// Explicit separate cutover build; the accepted fixed-snapshot build is intact.

import { readFileSync, writeFileSync } from 'node:fs';
import { pruneStaticPublications } from './prune-static-publications.mjs';
if (process.env.CMS_PUBLISHED_DELIVERY_ENABLED !== '1') throw new Error('Explicit CMS delivery gate required');
await import('./build-review.mjs');
// Public Resources are derived from the current authorized CMS projection.
// No historical static URL, collection, index, or sitemap may bypass withdrawal.
pruneStaticPublications('public');
// The supplied originals are base64 representations. Materialize the SAME WebP
// bytes for delivery; no source asset, pixel, dimension or technical detail changes.
for (const name of ['day-1536.webp', 'day-768.webp', 'night-1536.webp', 'night-768.webp']) {
  let bytes = readFileSync(`assets/${name}`);
  if (bytes.subarray(0, 4).toString() !== 'RIFF') bytes = Buffer.from(bytes.toString('ascii').trim(), 'base64');
  if (bytes.subarray(0, 4).toString() !== 'RIFF' || bytes.subarray(8, 12).toString() !== 'WEBP') throw new Error('Original WebP is invalid: ' + name);
  writeFileSync(`public/assets/${name}`, bytes);
}
