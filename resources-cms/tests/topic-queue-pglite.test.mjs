import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const proposal=readFileSync(new URL('../security/staging-topic-queue-candidate.sql',import.meta.url),'utf8');
const uuid=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
const owner=uuid(1),viewer=uuid(2),item=uuid(60);
async function fixture(){
  const pg=new PGlite();
  await pg.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE resources_cms_runtime; CREATE ROLE resources_cms_command_owner;');
  await pg.exec('CREATE SCHEMA resources_cms;');
  await pg.exec('GRANT USAGE ON SCHEMA resources_cms TO anon,authenticated,resources_cms_command_owner;');
  await pg.exec("CREATE TABLE resources_cms.members(user_id uuid PRIMARY KEY,role text,active boolean);");
  await pg.exec("CREATE TABLE resources_cms.articles(id uuid PRIMARY KEY,state text);");
  await pg.exec('GRANT SELECT ON resources_cms.articles TO resources_cms_command_owner;');
  // Synthetic local actor only. Hosted resources_cms.actor() strictly requires
  // PostgREST session_user='authenticator' and verified JWT role/sub claims.
  await pg.exec("CREATE FUNCTION resources_cms.actor() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT NULLIF(current_setting('test.actor',true),'')::uuid $$;");
  await pg.exec("CREATE FUNCTION resources_cms.has_role(roles text[]) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT EXISTS(SELECT 1 FROM resources_cms.members WHERE user_id=resources_cms.actor() AND active AND role=ANY(roles)) $$;");
  await pg.exec("INSERT INTO resources_cms.members VALUES('"+owner+"','owner',true),('"+viewer+"','viewer',true);");
  await pg.exec(proposal);
  return pg;
}
async function identity(pg,id,role='authenticated'){
  await pg.exec('RESET ROLE');
  await pg.query("SELECT set_config('test.actor',$1,false)",[id||'']);
  await pg.exec('SET ROLE '+role);
}
async function command(pg,action,id,version,payload={}){
  const result=await pg.query('SELECT resources_cms.topic_queue_command($1,$2::uuid,$3,$4::jsonb) AS value',
    [action,id,version,JSON.stringify(payload)]);
  return result.rows[0].value;
}
test('queue seeds eight owned editorial requests without publishing or overwriting articles',async()=>{
 const pg=await fixture();
 try{
  await identity(pg,owner);
  const rows=(await pg.query('SELECT resources_cms.topic_queue_list() AS topics')).rows[0].topics;
  assert.equal(rows.length,8);
  assert(rows.some(x=>x.topic==='Weekly care of your pool'));
  assert(rows.every(x=>x.status==='queued'&&Number.isInteger(x.version)));
  await pg.exec('RESET ROLE');
  assert.equal((await pg.query("SELECT COUNT(*)::integer n FROM resources_cms.articles")).rows[0].n,0);
  assert.equal((await pg.query("SELECT has_table_privilege('anon','resources_cms.topic_queue','SELECT') AS anon")).rows[0].anon,false);
 }finally{await pg.close();}
});

test('only owner may add, list, claim or complete a queued topic',async()=>{
 const pg=await fixture();
 try {
  await identity(pg,viewer);
  await assert.rejects(pg.query('SELECT resources_cms.topic_queue_list()'),/Owner required/i);
  await assert.rejects(command(pg,'add',item,0,{topic:'Safe seasonal pool care'}),/Owner required/i);
  await identity(pg,null,'anon');
  await assert.rejects(pg.query('SELECT resources_cms.topic_queue_list()'),/permission denied/i);
  await identity(pg,owner);
  const created=await command(pg,'add',item,0,{topic:'Safe seasonal pool care',brief:'test',audience:'both'});
  assert.equal(created.status,'queued');
  assert.equal(created.id,item);
  await assert.rejects(command(pg,'add',uuid(61),0,{topic:'Safe seasonal pool care'}),/unique|duplicate/i);
  const claim=await command(pg,'claim',item,1);
  assert.equal(claim.status,'generating');
  await assert.rejects(command(pg,'claim',item,2),/not ready/i);
  await assert.rejects(command(pg,'complete',item,2),/private draft missing/i);
  await pg.exec('RESET ROLE');
  await pg.query('INSERT INTO resources_cms.articles VALUES($1,$2)',[created.articleId,'draft']);
  await identity(pg,owner);
  const final=await command(pg,'complete',item,2);
  assert.equal(final.status,'drafted');
  assert.equal(final.articleId,claim.articleId);
 }finally{await pg.close();}
});

test('failed generation releases the claim and older version cannot be replayed',async()=>{
 const pg=await fixture();
 try {
  await identity(pg,owner);
  const claim=await command(pg,'claim',item,1).catch(()=>null);
  assert.equal(claim,null,'nonexistent topic denied');
  const before=(await pg.query('SELECT resources_cms.topic_queue_list() AS topics')).rows[0].topics[0];
  const claimed=await command(pg,'claim',before.id,before.version);
  assert.equal(claimed.attempts,1);
  await assert.rejects(command(pg,'release',before.id,before.version),/changed/i);
  const next=await command(pg,'release',before.id,claimed.version);
  assert.equal(next.status,'queued'); assert.equal(next.attempts,1);
  assert.equal(next.version,claimed.version+1);
 }finally{await pg.close();}
});


test('durable generation guard serializes claims and records billable attempts',async()=>{
 const pg=await fixture();
 try{
  await identity(pg,owner);
  const rows=(await pg.query('SELECT resources_cms.topic_queue_list() AS topics')).rows[0].topics;
  const first=await command(pg,'claim',rows[0].id,rows[0].version);
  await assert.rejects(command(pg,'claim',rows[1].id,rows[1].version),/Another topic is already generating/i);
  const released=await command(pg,'release',rows[0].id,first.version);
  assert.equal(released.status,'queued');
  const next=await command(pg,'claim',rows[1].id,rows[1].version);
  assert.equal(next.status,'generating');
  await pg.exec('RESET ROLE');
  const counts=(await pg.query('SELECT count(*)::integer n FROM resources_cms.topic_generation_attempts')).rows[0].n;
  assert.equal(counts,2);
  const restricted=await pg.query("SELECT has_table_privilege('anon','resources_cms.topic_generation_attempts','SELECT') AS anon");
  assert.equal(restricted.rows[0].anon,false);
 }finally{await pg.close();}
});

test('NULL versions/payloads cannot bypass the SQL command boundary; add retries preserve identity',async()=>{
 const pg=await fixture();
 try{
  await identity(pg,owner);
  for(const action of ['add','claim','release','retry','complete','archive'])await assert.rejects(command(pg,action,item,null,{topic:'Synthetic pool care'}),/Invalid topic request/);
  await assert.rejects(command(pg,'add',item,0,null),/Invalid topic request/);
  const payload={topic:'Synthetic pool care',brief:'Synthetic notes'};
  const first=await command(pg,'add',item,0,payload);
  const second=await command(pg,'add',item,0,payload);
  assert.deepEqual(second,first);
  await assert.rejects(command(pg,'add',item,0,{...payload,brief:'Changed'}),/identity conflict/);
  await pg.exec('RESET ROLE');
  const owners=await pg.query("SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE proname IN ('topic_queue_list','topic_queue_command')");
  assert(owners.rows.every(r=>r.owner==='resources_cms_command_owner'));
 }finally{await pg.close();}
});

test('stalled recovery preserves three-attempt cap and rolling daily claims cannot exceed ten',async()=>{
 const pg=await fixture();
 try{
  await identity(pg,owner);
  const created=await command(pg,'add',item,0,{topic:'Synthetic bounded care'});
  let row=created;
  for(let i=1;i<=3;i++){
   row=await command(pg,'claim',item,row.version);
   await assert.rejects(command(pg,'retry',item,row.version),/still active/);
   await pg.exec('RESET ROLE');
   await pg.query("UPDATE resources_cms.topic_queue SET claimed_at=now()-interval '4 minutes' WHERE id=$1",[item]);
   await identity(pg,owner);
   row=await command(pg,'retry',item,row.version);assert.equal(row.attempts,i);
  }
  await assert.rejects(command(pg,'claim',item,row.version),/not ready/);
  await pg.exec('RESET ROLE');
  await pg.query('INSERT INTO resources_cms.topic_generation_attempts(topic_id,actor_id) SELECT $1::uuid,$2::uuid FROM generate_series(1,7)',[item,owner]);
  await identity(pg,owner);
  const other=await command(pg,'add',uuid(62),0,{topic:'Another bounded pool topic'});
  await assert.rejects(command(pg,'claim',other.id,other.version),/budget exhausted/);
 }finally{await pg.close();}
});
