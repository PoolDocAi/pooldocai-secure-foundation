import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inventoryStorageBytes, verifyStorageBytes } from '../../scripts/launch-readiness-recovery/storage-recovery.mjs';

const rows = [
  { bucket:'company-manuals', key:'tenant-a/manual.pdf', version:'v1', size:4 },
  { bucket:'cms-private', key:'archived/old.webp', version:'v2', size:0, archived:true },
  { bucket:'company-manuals', key:'orphan.bin', version:'v3', size:4, referenced:false }
];
const setup = (overrides={}) => ({ inventory:async()=>rows.map(r=>({...r})), read:async row=>row.size ? Buffer.from([0,1,2,255]) : Buffer.alloc(0), ...overrides });
test('all buckets, archived, orphan and zero-byte objects recover exactly',async()=>{
  const payload=await inventoryStorageBytes(setup());
  assert.deepEqual(verifyStorageBytes(payload).map(r=>r.bytes),[Buffer.from([0,1,2,255]),Buffer.alloc(0),Buffer.from([0,1,2,255])]);
});
test('changed inventories, duplicates, missing versions and short reads fail',async()=>{
  let calls=0;
  await assert.rejects(inventoryStorageBytes(setup({inventory:async()=>++calls===1?rows:rows.map(r=>({...r,version:'changed'}))})),/Storage changed/);
  await assert.rejects(inventoryStorageBytes(setup({inventory:async()=>[rows[0],rows[0]]})));
  await assert.rejects(inventoryStorageBytes(setup({inventory:async()=>[{...rows[0],version:''}]})));
  await assert.rejects(inventoryStorageBytes(setup({read:async()=>Buffer.alloc(1)})));
  await assert.rejects(inventoryStorageBytes(setup({maxBytes:3})),/memory limit/);
  const reused=rows.map(row=>({...row}));
  await assert.rejects(inventoryStorageBytes(setup({inventory:async()=>reused,read:async row=>{
    reused[0].version='changed-in-place';return row.size?Buffer.from([0,1,2,255]):Buffer.alloc(0);
  }})),/Storage changed/);
});
test('post-decryption byte tampering and truncation fail',async()=>{
  const payload=await inventoryStorageBytes(setup()); payload.objects[0].bytes='AAAAAA==';
  assert.throws(()=>verifyStorageBytes(payload));
  assert.throws(()=>verifyStorageBytes({format:'pooldocai-storage-integrity-v1',objects:[{...rows[0],bytes:'AA==',sha256:'0'.repeat(64)}]}));
});
test('existing 7-Zip AES256 flow encrypts and restores synthetic inventory; bad password and damaged archive fail',async t=>{
  const candidates=process.platform==='win32'?['C:/Program Files/7-Zip/7z.exe','7z']:['7z','7zz'];
  const seven=candidates.find(exe=>spawnSync(exe,['i'],{encoding:'utf8'}).status===0);
  if(!seven) return t.skip('7-Zip unavailable; integrity tests still run');
  const root=mkdtempSync(join(tmpdir(),'pooldocai-synthetic-storage-'));
  const run=(args)=>spawnSync(seven,args,{cwd:root,encoding:'utf8'});
  // Deliberately public synthetic-only password; never use this harness for real data.
  const password='SYNTHETIC-ONLY-NO-PRIVATE-DATA';
  try {
    const payload=await inventoryStorageBytes(setup());
    writeFileSync(join(root,'storage.json'),JSON.stringify(payload));
    assert.equal(run(['a','-t7z','-mhe=on','-m0=LZMA2',`-p${password}`,'storage.7z','storage.json']).status,0);
    const details=run(['l','-slt',`-p${password}`,'storage.7z']);
    assert.match(details.stdout,/7zAES/); assert.match(details.stdout,/Encrypted = \+/);
    assert.equal(run(['t',`-p${password}`,'storage.7z']).status,0);
    assert.notEqual(run(['t','-pWRONG-SYNTHETIC-PASSWORD','storage.7z']).status,0);
    mkdirSync(join(root,'restore'));
    assert.equal(run(['x',`-p${password}`,'-orestore','storage.7z']).status,0);
    assert.deepEqual(verifyStorageBytes(JSON.parse(readFileSync(join(root,'restore/storage.json'),'utf8'))),verifyStorageBytes(payload));
    const archive=readFileSync(join(root,'storage.7z'));
    writeFileSync(join(root,'damaged.7z'),archive.subarray(0,archive.length-20));
    assert.notEqual(run(['t',`-p${password}`,'damaged.7z']).status,0);
  } finally {
    // Exact fresh synthetic-only temp directory; never pointed at owner files.
    if(existsSync(root)) rmSync(root,{recursive:true,force:true});
  }
});
