// CMS-based public delivery MUST NOT ship static article/Hub snapshots.
// This runs only after an explicitly enabled CMS delivery build. Other
// marketing routes and their original source/assets remain untouched.
import {readdirSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';

const RETIRED=[
  'green-pool-first-checks.html',
  'pool-pump-wont-start.html',
  'green-pool-first-checks',
  'pool-pump-wont-start',
  'resourcesindex.html',
  'live-catalog.json',
  'review-pages',
  'sitemap.xml',
  'resources-sitemap.xml',
  'llms.txt',
];

export function pruneStaticPublications(root='public') {
  for(const relative of RETIRED)
    rmSync(join(root,relative),{recursive:true,force:true});
  const dir=join(root,'resources');
  if(!existsSync(dir))return;
  // CMS owns all /resources/ page routes. Preserve styles/scripts/media
  // files but remove every pre-rendered article/collection/Hub snapshot,
  // including slugs newly added to the historic marketing package.
  for(const entry of readdirSync(dir,{withFileTypes:true})) {
    if(entry.isDirectory()||entry.name.endsWith('.html')) {
      rmSync(join(dir,entry.name),{recursive:true,force:true});
    }
  }
}
