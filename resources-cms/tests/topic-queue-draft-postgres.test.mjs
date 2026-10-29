// Actual queue + article SQL in disposable PGlite; verified JWT transport is
// emulated locally, as in production-e2e-pglite.test.mjs. No hosted connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {PostgresCMS} from '../src/production/postgres.mjs';
import {handleTopicApi} from '../src/production/topic-queue-api.mjs';
import {composeTopicArticle} from '../src/production/topic-to-article.mjs';
const owner='00000000-0000-4000-8000-000000000001',categoryId='00000000-0000-4000-8000-000000000002';
test('queue produces an immutable normal draft, preserves owner edits on replay and has no public/knowledge reachability',async()=>{
 const pg=new PGlite();
 try{
  await pg.exec('CREATE ROLE anon; CREATE ROLE authenticated;');
  await pg.exec(readFileSync('supabase/migrations/20261026035555_resources_cms_isolated_v1.sql','utf8'));
  const sql=readFileSync('supabase/migrations/20261026042156_resources_cms_commands_v2.sql','utf8')
   .replace("session_user='authenticator' AND ",'')
   .replace(/DO \$guard\$ BEGIN\n IF current_user<>'postgres'[\s\S]*?END \$guard\$;\n/,'')
   .replace(/-- This is a second, grantor-specific row\.[\s\S]*?END \$guard\$;\n/,'')
   .replace(/-- Remove only the temporary row granted by postgres\.[\s\S]*?END \$guard\$;\n/,'');
  await pg.exec(sql);
  await pg.exec(readFileSync('security/staging-topic-queue-candidate.sql','utf8'));
  await pg.exec(`INSERT INTO resources_cms.members VALUES('${owner}','owner',true); INSERT INTO resources_cms.taxonomy(id,kind,name) VALUES('${categoryId}','category','Pool care'); SET ROLE authenticated;`);
  const db=new PostgresCMS({connect:async()=>({query:(...args)=>pg.query(...args),release(){}})});
  db.topicList=user=>db.transaction(user,async c=>(await c.query('SELECT resources_cms.topic_queue_list() value')).rows[0].value);
  db.topicCommand=(user,action,id,version,payload={})=>db.transaction(user,async c=>(await c.query('SELECT resources_cms.topic_queue_command($1,$2::uuid,$3,$4::jsonb) value',[action,id,version,JSON.stringify(payload)])).rows[0].value);
  let calls=0;
  const prose='Test the water and inspect equipment before deciding which maintenance action is justified. Follow the documented instructions for the installed model and record observations for comparison with later results. '.repeat(3);
  const generator=async req=>{calls++;return composeTopicArticle({request:req,categoryId,researchSources:[{id:'a',label:'CDC',url:'https://www.cdc.gov/healthy-swimming/'},{id:'b',label:'PHTA',url:'https://www.phta.org/technical-bulletins/'}],draft:{title:'Weekly care of your pool',summary:prose.slice(0,200),intro:prose.slice(0,220),keyTakeaways:['Test before treatment.','Record observations.','Follow equipment documentation.'],sections:Array.from({length:4},(_,i)=>({heading:'Weekly step '+i,paragraphs:[prose,prose],sourceIds:['a','b']})),faqs:[{question:'When should I inspect?',answer:prose},{question:'What should I record?',answer:prose}],seo:{title:'Weekly pool care',description:prose.slice(0,160)}}});};
  const user={id:owner},topic=(await db.topicList(user)).find(t=>t.topic==='Weekly care of your pool');
  const call=()=>handleTopicApi({request:new Request('https://cms.example/api/topics/'+topic.id+'/create-article',{method:'POST',body:JSON.stringify({version:topic.version})}),db,user,role:'owner',topicPipeline:{queueEnabled:true,generator}});
  const response=await call();assert.equal(response.status,201,JSON.stringify(await response.clone().json()));
  let row=await db.read(user,topic.articleId);assert.equal(row.state,'draft');assert.equal(row.version,1);assert.equal(row.published_revision_id,null);assert.equal(row.editable.seo.noindex,true);
  assert.equal(await db.publicArticle(row.editable.slug),null);assert.deepEqual(await db.publicIndex(),[]);
  await db.command(user,row.id,row.version,'save',{...row.editable,title:'Owner revised weekly care'});
  assert.equal((await call()).status,200);assert.equal(calls,1);
  row=await db.read(user,row.id);assert.equal(row.version,2);assert.equal(row.editable.title,'Owner revised weekly care');
  assert.equal((await db.revisions(user,row.id)).length,2);
  await pg.exec('RESET ROLE');
  for(const table of ['knowledge_grants','publication_authorizations'])assert.equal((await pg.query('SELECT count(*)::int n FROM resources_cms.'+table)).rows[0].n,0);
 }finally{await pg.close();}
});
