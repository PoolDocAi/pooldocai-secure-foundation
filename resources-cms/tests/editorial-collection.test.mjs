import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore,seedTaxonomy,uid,now,revision,passwordHash } from '../src/store.mjs';
import { reconcileCollection,assertEditorialRelease } from '../src/editorial-collection.mjs';

test('31-resource collection preserves history, live snapshot, source parity and release holds',()=>{
 const db=openStore(join(mkdtempSync(join(tmpdir(),'cms-v29-')),'test.sqlite')); seedTaxonomy(db);
 const owner=uid(); db.prepare('INSERT INTO users VALUES(?,?,?,?,1)').run(owner,'test@example.test',passwordHash('collection-test-password'),'owner');
 for(const entry of JSON.parse(readFileSync('examples/approved-content-reconciliation.json')).resources){
  const id=uid(),time=now();db.prepare("INSERT INTO articles(id,slug,status,data,version,created_at,updated_at) VALUES(?,?,'draft',?,1,?,?)").run(id,entry.article.slug,JSON.stringify(entry.article),time,time);
  revision(db,db.prepare('SELECT * FROM articles WHERE id=?').get(id),owner,'accepted-baseline');
 }
 const live=JSON.parse(readFileSync('examples/existing-resources.json'))[0],liveId=uid(),time=now();
 db.prepare("INSERT INTO articles(id,slug,status,data,published,version,created_at,updated_at) VALUES(?,?,'published',?,?,1,?,?)").run(liveId,live.slug,JSON.stringify(live),JSON.stringify(live),time,time);
 revision(db,db.prepare('SELECT * FROM articles WHERE id=?').get(liveId),owner,'original-live');
 const original=db.prepare('SELECT published FROM articles WHERE id=?').get(liveId).published;
 const report=reconcileCollection(db,owner,'source-archive/approved-v29');
 assert.equal(report.approvedResourceCount,31);assert.equal(report.manuscripts,31);
 assert.equal(db.prepare('SELECT count(*) n FROM editorial_holds').get().n,31);
 assert.equal(db.prepare('SELECT published FROM articles WHERE id=?').get(liveId).published,original);
 for(const row of db.prepare('SELECT a.* FROM articles a JOIN editorial_holds h ON h.article_id=a.id').all()){
  assert.equal(row.status,'draft');assert.equal(row.scheduled_at,null);assert.equal(JSON.parse(row.data).seo.noindex,true);
  assert.throws(()=>assertEditorialRelease(db,row.id),/release blocked/);
 }
 assert.equal(db.prepare('SELECT count(*) n FROM knowledge_reviews').get().n,0);
 const revisions=db.prepare('SELECT count(*) n FROM revisions').get().n;
 reconcileCollection(db,owner,'source-archive/approved-v29');
 assert.equal(db.prepare('SELECT count(*) n FROM revisions').get().n,revisions);
 assert.throws(()=>reconcileCollection(db,uid(),'source-archive/approved-v29'),/owner required/);
 db.close();
});
