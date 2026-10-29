import { createHash } from 'node:crypto';

// Integrity helper only. No network, credentials, filesystem or encryption framework.
// Serialize its private result only inside the existing owner-approved encrypted workflow.
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = () => { throw new Error('Invalid or inconsistent Storage inventory'); };
const canonical = rows => JSON.stringify(rows.map(row => ({ bucket: row.bucket, key: row.key, version: row.version, size: row.size })).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
function validate(rows) {
  if (!Array.isArray(rows)) fail();
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row.bucket !== 'string' || !row.bucket || typeof row.key !== 'string' || !row.key || typeof row.version !== 'string' || !row.version || !Number.isSafeInteger(row.size) || row.size < 0) fail();
    const id = JSON.stringify([row.bucket, row.key]);
    if (seen.has(id)) fail();
    seen.add(id);
  }
}
export async function inventoryStorageBytes({ inventory, read, maxBytes = 64 * 1024 * 1024 }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) fail();
  const supplied = await inventory(); validate(supplied);
  // Keep an independent baseline even if an adapter reuses mutable objects.
  const before = supplied.map(row => ({ bucket:row.bucket, key:row.key, version:row.version, size:row.size }));
  const expected = before.reduce((n,row) => n + row.size, 0);
  if (!Number.isSafeInteger(expected) || expected > maxBytes) throw new Error('Storage capture exceeds configured memory limit');
  const objects = [];
  for (const row of before) {
    const bytes = await read(Object.freeze({ ...row }));
    if (!Buffer.isBuffer(bytes) || bytes.length !== row.size) fail();
    objects.push({ bucket:row.bucket, key:row.key, version:row.version, size:row.size, sha256:hash(bytes), bytes:bytes.toString('base64') });
  }
  const after = await inventory(); validate(after);
  if (canonical(before) !== canonical(after)) throw new Error('Storage changed during capture');
  return { format:'pooldocai-storage-integrity-v1', objects };
}
// Used on decrypted bytes inside the approved isolated restore process.
export function verifyStorageBytes(payload) {
  if (payload?.format !== 'pooldocai-storage-integrity-v1') fail();
  validate(payload.objects);
  return payload.objects.map(row => {
    if (typeof row.bytes !== 'string' || typeof row.sha256 !== 'string') fail();
    const bytes = Buffer.from(row.bytes,'base64');
    if (bytes.toString('base64') !== row.bytes || bytes.length !== row.size || hash(bytes) !== row.sha256) fail();
    return { bucket:row.bucket, key:row.key, version:row.version, bytes };
  });
}
