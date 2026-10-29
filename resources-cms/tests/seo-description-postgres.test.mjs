import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {PostgresCMS} from '../src/production/postgres.mjs';
import {normalizeArticleCommand} from '../src/production/validation.mjs';
import {reviewProposals,applyApprovedProposals} from '../src/production/review-proposals.mjs';
const owner='00000000-0000-4000-8000-000000000001',category='00000000-0000-4000-8000-000000000002',id='00000000-0000-4000-8000-000000000003';
test('generated metadata persists through immutable PostgreSQL save revisions without public reachability',async()=>{
  const pg=new PGlite();
  try {
    await pg.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
    await pg.exec(readFileSync('supabase/migrations/20261026035555_resources_cms_isolated_v1.sql','utf8'));
    // Synthetic local auth transport only; no hosted guard or schema changes.
    const sql=readFileSync('supabase/migrations/20261026042156_resources_cms_commands_v2.sql','utf8')
      .replace("session_user='authenticator' AND ",'')
      .replace(/DO \$guard\$ BEGIN\n IF current_user<>'postgres'[\s\S]*?END \$guard\$;\n/,'')
      .replace(/-- This is a second, grantor-specific row\.[\s\S]*?END \$guard\$;\n/,'')
      .replace(/-- Remove only the temporary row granted by postgres\.[\s\S]*?END \$guard\$;\n/,'');
    await pg.exec(sql);
    await pg.exec(`INSERT INTO resources_cms.members VALUES('${owner}','owner',true); INSERT INTO resources_cms.taxonomy(id,kind,name) VALUES('${category}','category','Guides'); SET ROLE authenticated;`);
    const db=new PostgresCMS({connect:async()=>({query:(...args)=>pg.query(...args),release(){}})});
    const original={title:'Pool circulation observations',slug:'pool-circulation-observations',categoryId:category,tagIds:[],sources:[],audience:'homeowners',seo:{},body:'<p>This article describes pool circulation observations and the notes to record when comparing water movement during routine inspections.</p>'};
    await db.command(owner,id,0,'create',original);
    const proposal=reviewProposals(original).find(p=>p.id==='seo-description');
    assert.ok(proposal);
    const approved=applyApprovedProposals(original,[{id:proposal.id}]);
    const saved=normalizeArticleCommand('save',approved.changed);
    await db.command(owner,id,1,'save',saved);
    const row=await db.read(owner,id);
    assert.equal(row.editable.seo.description,saved.seo.description);assert.ok(row.editable.seo.description.length>=90);
    assert.equal(row.version,2);assert.equal(row.state,'draft');assert.equal(row.published_revision_id,null);
    const revisions=await db.revisions(owner,id);
    assert.equal(revisions.length,2);assert.equal(revisions.find(r=>r.version===1).data.seo.description,undefined);
    assert.equal(await db.publicArticle(original.slug),null);
  } finally {await pg.close();}
});
