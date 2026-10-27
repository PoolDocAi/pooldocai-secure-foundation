// Explicit separate cutover build; the accepted fixed-snapshot build is intact.

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
if (process.env.CMS_PUBLISHED_DELIVERY_ENABLED !== '1') throw new Error('Explicit CMS delivery gate required');
await import('./build-review.mjs');
// Never permit old static files to mask a CMS 404, withdrawal or upstream error.
for (const slug of ['pool-pump-wont-start', 'green-pool-first-checks']) rmSync(`public/resources/${slug}`, { recursive: true, force: true });
rmSync('public/sitemap.xml', { force: true });
rmSync('public/llms.txt', { force: true });
// The supplied originals are base64 representations. Materialize the SAME WebP
// bytes for delivery; no source asset, pixel, dimension or technical detail changes.
for (const name of ['day-1536.webp', 'day-768.webp', 'night-1536.webp', 'night-768.webp']) {
  let bytes = readFileSync(`assets/${name}`);
  if (bytes.subarray(0, 4).toString() !== 'RIFF') bytes = Buffer.from(bytes.toString('ascii').trim(), 'base64');
  if (bytes.subarray(0, 4).toString() !== 'RIFF' || bytes.subarray(8, 12).toString() !== 'WEBP') throw new Error('Original WebP is invalid: ' + name);
  writeFileSync(`public/assets/${name}`, bytes);
}
