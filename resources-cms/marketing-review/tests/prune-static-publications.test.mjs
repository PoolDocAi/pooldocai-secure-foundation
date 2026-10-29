import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {pruneStaticPublications} from '../scripts/prune-static-publications.mjs';

test('CMS publish build removes all old and newly named resource snapshots but preserves homepage, legal pages, waitlist and assets',()=>{
 const root=mkdtempSync(join(tmpdir(),'pooldocai-cms-static-withdraw-'));
 const put=(name,text)=>{const file=join(root,name);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text);};
 try{
  for(const file of [
    'resources/index.html','resources/green-pool-first-checks/index.html',
    'resources/pool-pump-wont-start/index.html',
    'resources/new-stale-article/index.html',
    'resources/collections/explore-resources/learning-center/index.html',
    'resources/old-static.html',
    'review-pages/green-pool-first-checks/index.html',
    'review-pages/pool-pump-wont-start/index.html',
    'green-pool-first-checks.html','pool-pump-wont-start.html',
    'resourcesindex.html','live-catalog.json','llms.txt','sitemap.xml','resources-sitemap.xml',
    'green-pool-first-checks/index.html','pool-pump-wont-start/index.html'
  ])put(file,'MUST NOT SHIP');
  for(const file of [
    'index.html','waitlist.html','privacy.html','terms.html',
    'assets/day-1536.webp','resources/resources.css','resources/resources.js'
  ])put(file,'PRESERVED');
  pruneStaticPublications(root);
  pruneStaticPublications(root); // repeated builds should be safe
  for(const file of [
    'resources/index.html','resources/green-pool-first-checks/index.html',
    'resources/pool-pump-wont-start/index.html',
    'resources/new-stale-article/index.html',
    'resources/collections','resources/old-static.html','review-pages',
    'green-pool-first-checks.html','pool-pump-wont-start.html',
    'resourcesindex.html','live-catalog.json','llms.txt','sitemap.xml',
    'resources-sitemap.xml','green-pool-first-checks','pool-pump-wont-start'
  ])assert.equal(existsSync(join(root,file)),false,'Static duplicate survives: '+file);
  for(const file of [
    'index.html','waitlist.html','privacy.html','terms.html',
    'assets/day-1536.webp','resources/resources.css','resources/resources.js'
  ])assert.equal(readFileSync(join(root,file),'utf8'),'PRESERVED','Unrelated marketing file altered: '+file);
 } finally{rmSync(root,{recursive:true,force:true});}
});
