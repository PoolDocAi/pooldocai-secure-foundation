import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const magic=Buffer.from('PDACMSR1');
const MAX_BYTES=128*1024*1024;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=()=>{throw new Error('Recovery package validation failed');};
const keyBytes=key=>{if(!Buffer.isBuffer(key)||key.length!==32)fail();return key;};
const identity=item=>JSON.stringify([item.bucket,item.key]);
const validLocation=item=>typeof item.bucket==='string'&&item.bucket.length>0&&item.bucket.length<=100&&typeof item.key==='string'&&item.key.length>0&&item.key.length<=2048&&!/[\u0000-\u001f]/.test(item.bucket+item.key);
function validate(payload) {
  if(payload?.format!=='pooldocai-recovery-bundle-v1'||!/^([a-z]{20}|synthetic-[a-z0-9-]+)$/.test(payload.projectRef||'')||!Array.isArray(payload.buckets)||!Array.isArray(payload.inventory)||!Array.isArray(payload.objects)||payload.buckets.length>1000||payload.inventory.length>100000)fail();
  if(new Set(payload.buckets).size!==payload.buckets.length||payload.buckets.some(b=>typeof b!=='string'||!b||b.length>100))fail();
  const expected=new Map();
  for(const item of payload.inventory){if(!validLocation(item)||!payload.buckets.includes(item.bucket)||expected.has(identity(item)))fail();expected.set(identity(item),item);}
  if(expected.size!==payload.objects.length)fail();
  let total=0;const seen=new Set();
  const bytesOf=item=>{
    if(typeof item.base64!=='string'||item.base64.length>MAX_BYTES*1.4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item.base64))fail();
    const bytes=Buffer.from(item.base64,'base64');total+=bytes.length;
    if(total>MAX_BYTES||bytes.length!==item.bytes||hash(bytes)!==item.sha256)fail();return bytes;
  };
  const dump=bytesOf(payload.database);
  if(dump.subarray(0,5).toString()!=='PGDMP')fail();
  for(const object of payload.objects){const id=identity(object),expectedObject=expected.get(id);if(!expectedObject||seen.has(id))fail();seen.add(id);const bytes=bytesOf(object);if(expectedObject.bytes!==bytes.length)fail();}
  if(!Number.isFinite(Date.parse(payload.createdAt))||!Number.isFinite(Date.parse(payload.inventoryCapturedAt)))fail();
  return payload;
}

// The snapshot inventory must cover ALL buckets and objects, not just CMS
// media. Database Storage metadata is not a backup of the actual object bytes.
export function sealRecoveryBundle({projectRef,databaseDump,buckets,inventory,objects,inventoryCapturedAt},key) {
  keyBytes(key);
  const encode=bytes=>({base64:Buffer.from(bytes).toString('base64'),bytes:bytes.length,sha256:hash(bytes)});
  const payload=validate({format:'pooldocai-recovery-bundle-v1',projectRef,createdAt:new Date().toISOString(),inventoryCapturedAt,buckets,inventory,database:encode(databaseDump),objects:objects.map(o=>({bucket:o.bucket,key:o.key,...encode(o.bytes)}))});
  const plaintext=Buffer.from(JSON.stringify(payload));
  try {
    if(plaintext.length>MAX_BYTES*1.5-36)fail();
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(magic);
    return Buffer.concat([magic,iv,cipher.update(plaintext),cipher.final(),cipher.getAuthTag()]);
  } finally {plaintext.fill(0);}
}

export function openRecoveryBundle(encrypted,key) {
  keyBytes(key);
  let plaintext;
  try {
    if(!Buffer.isBuffer(encrypted)||encrypted.length<36||encrypted.length>MAX_BYTES*1.5||!timingSafeEqual(encrypted.subarray(0,8),magic))fail();
    const decipher=createDecipheriv('aes-256-gcm',key,encrypted.subarray(8,20));decipher.setAAD(magic);decipher.setAuthTag(encrypted.subarray(-16));
    plaintext=Buffer.concat([decipher.update(encrypted.subarray(20,-16)),decipher.final()]);
    return validate(JSON.parse(plaintext.toString('utf8')));
  } catch {fail();} finally {plaintext?.fill(0);}
}

// Invoke with bytes independently downloaded from the operator's offsite
// repository. This proves cryptographic readback only, not an actual restore.
export function verifyOffsiteReadback({encrypted,readback,key,expectedProjectRef}) {
  if(!Buffer.isBuffer(readback)||hash(encrypted)!==hash(readback))fail();
  const payload=openRecoveryBundle(readback,key);if(payload.projectRef!==expectedProjectRef)fail();
  return {format:'pooldocai-offsite-readback-v1',projectRef:payload.projectRef,encryptedSha256:hash(readback),databaseSha256:payload.database.sha256,storageObjects:payload.objects.length,storageBuckets:payload.buckets.length,authenticatedDecryption:true,independentRestoreRehearsal:false,productionReleaseAuthorized:false};
}
