import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit private source and independently supplied digest; no generated fallback.
const [source, expected] = process.argv.slice(2);
if (!source || !/^[a-f0-9]{64}$/i.test(expected || '')) {
  throw new Error('Usage: node scripts/install-private-browser-fixture.mjs <approved-private-json> <owner-supplied-sha256>');
}
const destination = fileURLToPath(new URL('../examples/existing-resources.json', import.meta.url));
if (resolve(source) === resolve(destination)) throw new Error('Select the original approved source package file');
const bytes = await readFile(source);
if (createHash('sha256').update(bytes).digest('hex') !== expected.toLowerCase()) {
  throw new Error('Private fixture checksum mismatch; nothing installed');
}
let records;
try {
  records = JSON.parse(bytes.toString('utf8'));
} catch {
  // Native JSON errors can echo fragments of confidential source bytes.
  throw new Error('Private fixture is invalid JSON; nothing installed');
}
if (!Array.isArray(records) || records.length === 0 || records.some(r => !r || typeof r !== 'object' || typeof r.slug !== 'string' || !r.slug.trim()) || new Set(records.map(r => r.slug)).size !== records.length) {
  throw new Error('Expected a nonempty article array with unique nonempty slugs; nothing installed');
}
await mkdir(dirname(destination), { recursive: true });
// Refuse overwrite: an existing approved fixture must be reviewed separately.
await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
console.log('Approved private fixture installed unchanged. Content and credentials were not printed.');
