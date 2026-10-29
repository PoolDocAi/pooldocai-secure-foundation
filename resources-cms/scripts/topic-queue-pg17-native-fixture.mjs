import {strict as assert} from 'node:assert';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {assemblePg17TopicQueueSql} from './topic-queue-pg17-review.mjs';

// ONLY for a disposable local PostgreSQL 17 service in GitHub Actions.
// A mismatched host, port, database, version or explicit opt-in fails closed.
const db=process.env.PGDATABASE,host=process.env.PGHOST,port=process.env.PGPORT;
if(process.env.CMS_PG17_DISPOSABLE!=='1'||db!=='cms_fixture'||
  host!=='127.0.0.1'||port!=='5432')
 throw Error('Refusing to connect: requires disposable localhost PG17 fixture');
const fixture=readFileSync(new URL('../tests/fixtures/topic-queue-pg17-bootstrap.sql',import.meta.url),'utf8');
const env=(role)=>({...process.env,PGUSER:role,PGPASSWORD:
 role==='bootstrap'?'synthetic-bootstrap-only':
 role==='postgres'?'synthetic-executor-only':'synthetic-auth-only'});
function psql(role,input,{file=false,expectFailure=false}={}){
 const args=['-X','-v','ON_ERROR_STOP=1','-At',file?'-f':'-c',input];
 const result=spawnSync('psql',args,{env:env(role),encoding:'utf8',timeout:30000,maxBuffer:1048576});
 if(result.error)throw result.error;
 if(expectFailure){
   assert.notEqual(result.status,0,'Unsafe SQL was unexpectedly accepted: '+input.slice(0,130));
   return;
 }
 assert.equal(result.status,0,'psql failed: '+String(result.stderr).slice(0,1800));
 return result.stdout.trim();
}
function counts(){
 return psql('bootstrap',[
  'SELECT (SELECT count(*) FROM resources_cms.articles),',
  '(SELECT count(*) FROM resources_cms.editorial_holds),',
  '(SELECT count(*) FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid',
  ' JOIN pg_roles m ON m.oid=a.member WHERE r.rolname=',
  "'resources_cms_command_owner' AND m.rolname='postgres'),",
  "pg_has_role('postgres','resources_cms_command_owner','SET'),",
  "has_schema_privilege('resources_cms_command_owner','resources_cms','CREATE')"
 ].join(' '));
}
const marker=psql('bootstrap',"SELECT current_database()||'|'||current_user||'|'||current_setting('server_version_num')");
const [database,actor,version]=marker.split('|');
assert.equal(database,'cms_fixture');
assert.equal(actor,'bootstrap');
assert(Number(version)>=170000 && Number(version)<180000,'Require PostgreSQL 17');
const tmp=mkdtempSync(join(tmpdir(),'pooldocai-pg17-'));
try{
 const boot=join(tmp,'bootstrap.sql');
 writeFileSync(boot,fixture);
 psql('bootstrap',boot,{file:true});
 assert.equal(counts(),'35|32|1|f|f');
 const review=assemblePg17TopicQueueSql();
 const rollback=join(tmp,'topic-rollback.sql'),forward=join(tmp,'topic-forward.sql');
 writeFileSync(rollback,review.replace(/COMMIT;\s*$/,'ROLLBACK;\n'));
 writeFileSync(forward,review);
 psql('postgres',rollback,{file:true});
 assert.equal(psql('bootstrap',"SELECT to_regclass('resources_cms.topic_queue') IS NULL"),'t');
 assert.equal(counts(),'35|32|1|f|f','ROLLBACK must preserve content and grants');
 console.log('PG17 ROLLBACK rehearsal: no queue, role drift or content changes');
 psql('postgres',forward,{file:true});
 assert.equal(counts(),'35|32|1|f|f');
 assert.equal(psql('bootstrap',"SELECT count(*) FROM resources_cms.topic_queue"),'8');
 assert.equal(psql('bootstrap',"SELECT count(*) FROM resources_cms.topic_generation_attempts"),'0');
 assert.equal(psql('bootstrap',[
  'SELECT count(*) FROM pg_proc p WHERE p.oid IN',
  "('resources_cms.topic_queue_list()'::regprocedure,",
  "'resources_cms.topic_queue_command(text,uuid,integer,jsonb)'::regprocedure)",
  "AND pg_get_userbyid(p.proowner)='resources_cms_command_owner'"
 ].join(' ')),'2');
 const auth=(uuid)=>[
   'SET ROLE authenticated;',
   "SELECT set_config('request.jwt.claims',",
   "'{\"role\":\"authenticated\",\"sub\":\""+uuid+"\"}',false);",
   'SELECT resources_cms.topic_queue_list();'
 ].join('\n');
 const ownerUuid='00000000-0000-4000-8000-000000000001';
 const result=psql('authenticator',auth(ownerUuid));
 assert.equal(JSON.parse(result.split('\n').at(-1)).length,8);
 // Exercise real PG17 security-definer writes, then roll back this synthetic
 // owner request so the original eight seeded topics and attempt counts remain.
 const syntheticId='00000000-0000-4000-8000-000000000099';
 const ownerActionSql=[
   'BEGIN;',
   'SET ROLE authenticated;',
   "SELECT set_config('request.jwt.claims',",
   "'{\"role\":\"authenticated\",\"sub\":\""+ownerUuid+"\"}',false);",
   "SELECT resources_cms.topic_queue_command('add','"+syntheticId+"'::uuid,0,",
   "'{\"topic\":\"Synthetic native PG17 equipment maintenance\"}'::jsonb);",
   "SELECT resources_cms.topic_queue_command('claim','"+syntheticId+"'::uuid,1,'{}'::jsonb);",
   "SELECT resources_cms.topic_queue_command('release','"+syntheticId+"'::uuid,2,'{}'::jsonb);",
   'ROLLBACK;'
 ].join('\n');
 const actions=psql('authenticator',ownerActionSql);
 assert.match(actions,/"status":"queued"/);
 assert.match(actions,/"status":"generating"/);
 assert.equal(psql('bootstrap',"SELECT count(*) FROM resources_cms.topic_queue"),'8');
 assert.equal(psql('bootstrap',"SELECT count(*) FROM resources_cms.topic_generation_attempts"),'0');
 for(const id of ['00000000-0000-4000-8000-000000000002',
                   '00000000-0000-4000-8000-000000000003'])
   psql('authenticator',auth(id),{expectFailure:true});
 psql('authenticator',"SET ROLE anon; SELECT resources_cms.topic_queue_list()",{expectFailure:true});
 psql('authenticator',"SET ROLE authenticated; SELECT count(*) FROM resources_cms.topic_queue",{expectFailure:true});
 psql('postgres',[
  "SELECT set_config('request.jwt.claims',",
  "'{\"role\":\"authenticated\",\"sub\":\""+ownerUuid+"\"}',false);",
  'SELECT resources_cms.topic_queue_list();'
 ].join('\n'),{expectFailure:true});
 psql('postgres',forward,{file:true,expectFailure:true});
 assert.equal(psql('bootstrap',"SELECT count(*) FROM resources_cms.topic_queue"),'8');
 assert.equal(counts(),'35|32|1|f|f');
 console.log('PG17 committed fixture: owner allowed, viewer/inactive/anon/direct/spoofed denied, reapply blocked');
}finally{rmSync(tmp,{recursive:true,force:true});}
