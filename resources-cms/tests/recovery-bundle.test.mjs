import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {sealRecoveryBundle,openRecoveryBundle,verifyOffsiteReadback} from '../src/production/recovery-bundle.mjs';

const fixture=()=>({projectRef:'synthetic-recovery-test',databaseDump:Buffer.from('PGDMPsynthetic-database-private'),buckets:['private-documents','cms-media','empty-bucket'],inventoryCapturedAt:new Date().toISOString(),inventory:[{bucket:'private-documents',key:'tenant/original.docx',bytes:12},{bucket:'cms-media',key:'images/original.webp',bytes:0}],objects:[{bucket:'private-documents',key:'tenant/original.docx',bytes:Buffer.from('private-file')},{bucket:'cms-media',key:'images/original.webp',bytes:Buffer.alloc(0)}]});
test('encrypts full database and all Storage buckets, including non-CMS objects and empty buckets',()=>{
  const key=randomBytes(32),source=fixture(),sealed=sealRecoveryBundle(source,key);
  assert.equal(sealed.includes(Buffer.from('private-file')),false);assert.equal(sealed.includes(Buffer.from('private-documents')),false);
  const restored=openRecoveryBundle(sealed,key);assert.deepEqual(Buffer.from(restored.database.base64,'base64'),source.databaseDump);assert.equal(restored.objects.length,2);assert.equal(restored.buckets.length,3);
  assert.deepEqual(Buffer.from(restored.objects[0].base64,'base64'),source.objects[0].bytes);
  assert.notDeepEqual(sealRecoveryBundle(source,key),sealed,'Fresh nonce for each package');
});
test('wrong key, changed ciphertext, truncation, cross-project readback and missing bytes fail closed',()=>{
  const key=randomBytes(32),sealed=sealRecoveryBundle(fixture(),key),changed=Buffer.from(sealed);changed[25]^=1;
  for(const input of [changed,sealed.subarray(0,-1),Buffer.from('invalid')])assert.throws(()=>openRecoveryBundle(input,key));
  assert.throws(()=>openRecoveryBundle(sealed,randomBytes(32)));
  assert.throws(()=>verifyOffsiteReadback({encrypted:sealed,readback:changed,key,expectedProjectRef:'synthetic-recovery-test'}));
  assert.throws(()=>verifyOffsiteReadback({encrypted:sealed,readback:sealed,key,expectedProjectRef:'owfeebydlyacssqpnmkq'}));
  for(const mutate of [f=>f.objects.pop(),f=>f.inventory[0].bytes++,f=>f.objects.push(f.objects[0]),f=>f.buckets.splice(0,1),f=>f.databaseDump=Buffer.from('invalid dump')]){const f=fixture();mutate(f);assert.throws(()=>sealRecoveryBundle(f,key));}
});
test('offsite readback verifies decryption but cannot claim independent restore or authorize release',()=>{
  const key=randomBytes(32),encrypted=sealRecoveryBundle(fixture(),key),result=verifyOffsiteReadback({encrypted,readback:Buffer.from(encrypted),key,expectedProjectRef:'synthetic-recovery-test'});
  assert.equal(result.authenticatedDecryption,true);assert.equal(result.independentRestoreRehearsal,false);assert.equal(result.productionReleaseAuthorized,false);assert.equal(result.storageObjects,2);
});
test('secure operator CLI seals and verifies a separately copied synthetic artifact; refuses Git paths and logs no secrets',()=>{
  const dir=mkdtempSync(join(tmpdir(),'pooldoc-recovery-')),key=randomBytes(32),secret=key.toString('base64');
  try {
    const f=fixture(),config={projectRef:f.projectRef,databaseDumpPath:join(dir,'db.dump'),storageInventoryPath:join(dir,'inventory.json'),storageObjects:f.objects.map((o,i)=>({bucket:o.bucket,key:o.key,path:join(dir,`object-${i}`)})),encryptedBundlePath:join(dir,'encrypted.pdarecovery')};
    writeFileSync(config.databaseDumpPath,f.databaseDump);writeFileSync(config.storageInventoryPath,JSON.stringify({capturedAt:f.inventoryCapturedAt,buckets:f.buckets,objects:f.inventory}));
    f.objects.forEach((o,i)=>writeFileSync(config.storageObjects[i].path,o.bytes));const configPath=join(dir,'config.json');writeFileSync(configPath,JSON.stringify(config));
    const run=(mode,target)=>spawnSync(process.execPath,['scripts/seal-recovery-bundle.mjs',mode,configPath,target],{encoding:'utf8',env:{...process.env,CMS_RECOVERY_KEY_BASE64:secret}});
    const sealed=run('seal',config.encryptedBundlePath);assert.equal(sealed.status,0,sealed.stderr);
    const copy=join(dir,'independently-downloaded-copy.pdarecovery');writeFileSync(copy,readFileSync(config.encryptedBundlePath));
    const verified=run('verify-offsite',copy);assert.equal(verified.status,0,verified.stderr);assert.equal(JSON.parse(verified.stdout).authenticatedDecryption,true);
    assert.equal(run('seal',resolve('unsafe-recovery.pdarecovery')).status,1);
    for(const output of [sealed,verified])assert.doesNotMatch(output.stdout+output.stderr,new RegExp(secret.replace(/[+]/g,'\\+')));
  } finally {rmSync(dir,{recursive:true,force:true});key.fill(0);}
});
