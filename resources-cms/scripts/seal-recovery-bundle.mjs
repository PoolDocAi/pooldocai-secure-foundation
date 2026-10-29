// Offline secure-operator utility; never invoked by the CMS web runtime.
// No credentials or key values are accepted as command-line arguments.
import {readFileSync,writeFileSync,realpathSync,existsSync,statSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {sealRecoveryBundle,verifyOffsiteReadback} from '../src/production/recovery-bundle.mjs';

function outsideGit(path,existing=true) {
  const absolute=existing?realpathSync(path):join(realpathSync(dirname(resolve(path))),resolve(path).split(/[\\/]/).pop());
  for(let dir=existing&&statSync(absolute).isDirectory()?absolute:dirname(absolute);;dir=dirname(dir)){
    if(existsSync(join(dir,'.git')))throw Error('Recovery files must stay outside Git checkouts');
    if(dirname(dir)===dir)break;
  }
  return absolute;
}
const boundedRead=path=>{const real=outsideGit(path);if(statSync(real).size>256*1024*1024)throw Error('Recovery input exceeds supported size');return readFileSync(real);};
let key;
try {
  const [mode,configPath,outputOrReadback]=process.argv.slice(2);
  const encoded=process.env.CMS_RECOVERY_KEY_BASE64;delete process.env.CMS_RECOVERY_KEY_BASE64;
  if(!encoded||!/^[A-Za-z0-9+/]{43}=$/.test(encoded))throw Error('Provide a 32-byte recovery key through the secure operator environment');
  key=Buffer.from(encoded,'base64');
  if(!['seal','verify-offsite'].includes(mode)||!configPath||!outputOrReadback)throw Error('Usage: seal-recovery-bundle.mjs seal CONFIG OUTPUT | verify-offsite CONFIG DOWNLOADED_COPY');
  const config=JSON.parse(boundedRead(configPath));
  if(mode==='seal') {
    const inventory=JSON.parse(boundedRead(config.storageInventoryPath));
    const encrypted=sealRecoveryBundle({projectRef:config.projectRef,databaseDump:boundedRead(config.databaseDumpPath),buckets:inventory.buckets,inventory:inventory.objects,inventoryCapturedAt:inventory.capturedAt,objects:config.storageObjects.map(o=>({bucket:o.bucket,key:o.key,bytes:boundedRead(o.path)}))},key);
    writeFileSync(outsideGit(outputOrReadback,false),encrypted,{flag:'wx',mode:0o600});
    console.log(JSON.stringify({sealed:true,productionReleaseAuthorized:false}));
  } else {
    if(realpathSync(config.encryptedBundlePath)===realpathSync(outputOrReadback))throw Error('An independently retrieved copy is required');
    const result=verifyOffsiteReadback({encrypted:boundedRead(config.encryptedBundlePath),readback:boundedRead(outputOrReadback),key,expectedProjectRef:config.projectRef});
    console.log(JSON.stringify(result));
  }
} catch {console.error('Recovery operation rejected. Check restricted paths, key availability, complete inventory, size limits and input integrity. No release authorization was granted.');process.exitCode=1;}
finally {key?.fill(0);}
