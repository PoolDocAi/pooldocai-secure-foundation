import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir(new URL('../src/generated/', import.meta.url), { recursive: true });
// Preserve the current sanitizer/security fixes; inline its ESM-only parser so
// Vercel's CommonJS loader never has to require() an ES module at runtime.
await build({ entryPoints: ['sanitize-html'], bundle: true, platform: 'node', format: 'cjs',
  target: 'node24', outfile: 'src/generated/sanitize-html.cjs', legalComments: 'inline' });

// Bundle the ESM-only Markdown parser as CJS for the Vercel Node function loader.
// Keep the parser behavior intact; import it only from this generated artifact.
await build({ entryPoints: ['marked'], bundle: true, platform: 'node', format: 'cjs',
  target: 'node24', outfile: 'src/generated/marked.cjs', legalComments: 'inline' });
