import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const read=p=>readFileSync(p,'utf8');
const u='00000000-0000-4000-8000-000000000001';
const sid='00000000-0000-4000-8000-000000000002';
const factor='00000000-0000-4000-8000-000000000003';
const other='00000000-0000-4000-8000-000000000099';

test('V3 candidate has no Storage-owner DDL or managed Storage grant path',()=>{
 const source=read('supabase/schema-proposals/mfa-aal2-review.sql');
 const sql=source.replace(/--[^\n]*/g,'').replace(/\/\*[\s\S]*?\*\//g,'');
 assert.doesNotMatch(sql,/CREATE\s+POLICY[^;]*ON\s+storage\.objects|ALTER\s+POLICY|DROP\s+POLICY|ALTER\s+TABLE\s+storage\.objects|(?:GRANT|REVOKE)[^;]*supabase_storage_admin/i);
 assert.doesNotMatch(sql,/mfa_storage_allowed|resources_cms_mfa_boundary/);
 assert(source.includes(read('supabase/schema-proposals/mfa-storage-policy-contract.sql').trim().replace(/;$/,'')));
});

test('review-only AAL2 SQL: real PostgreSQL RLS/RPC semantics with synthetic Auth/Storage', {timeout:60000}, async t=>{
 const db=new PGlite();
 try{
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE authenticator NOINHERIT;
 GRANT anon,authenticated TO authenticator;
 CREATE SCHEMA auth; CREATE SCHEMA storage;
 CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT (auth.jwt()->>'sub')::uuid $$;
 CREATE TABLE auth.sessions(id uuid PRIMARY KEY,user_id uuid,not_after timestamptz,aal text,factor_id uuid);
 CREATE TABLE auth.mfa_factors(id uuid PRIMARY KEY,user_id uuid,status text,factor_type text);
 CREATE TABLE storage.objects(bucket_id text,name text,owner_id text);
 ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
 GRANT USAGE ON SCHEMA auth,storage TO anon,authenticated;
 GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO anon,authenticated;`);
 // Local fixture only: give the bootstrap role its hosted name, then create
 // a distinct non-superuser postgres. PG17 now creates managed membership rows
 // with the same grantor/options as Staging. No production role path is invented.
 await db.exec(`CREATE ROLE test_root SUPERUSER; SET SESSION AUTHORIZATION test_root;
 ALTER ROLE postgres RENAME TO supabase_admin;
 CREATE ROLE postgres CREATEROLE NOINHERIT;
 GRANT CREATE,TEMP ON DATABASE postgres TO postgres;
 GRANT USAGE ON SCHEMA auth,storage TO postgres;
 GRANT SELECT ON auth.sessions,auth.mfa_factors TO postgres WITH GRANT OPTION;
 CREATE ROLE supabase_storage_admin NOLOGIN NOINHERIT;
 ALTER TABLE storage.objects OWNER TO supabase_storage_admin;
 SET ROLE postgres;`);
 await db.exec(read('supabase/migrations/20261026035555_resources_cms_isolated_v1.sql'));
 // Exact PG17 baseline setup; no guard/body stripping.
 // Normalize only legacy ACL grant ownership to the observed live ACL model.
 // The candidate under test below has NO guard/ownership/ACL transformations.
 const baseline=read('supabase/migrations/20261026042156_resources_cms_commands_v2.sql')
 .replace('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA resources_cms FROM PUBLIC,anon,authenticated,resources_cms_runtime;',
 `DO $acl$ DECLARE f record; BEGIN FOR f IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='resources_cms' AND p.proowner=current_user::regrole LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,resources_cms_runtime',f.oid::regprocedure); END LOOP; END $acl$; SET LOCAL ROLE resources_cms_command_owner; DO $acl$ DECLARE f record; BEGIN FOR f IN SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='resources_cms' AND p.proowner=current_user::regrole LOOP EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,resources_cms_runtime',f.oid::regprocedure); END LOOP; END $acl$;`)
 .replace('GRANT EXECUTE ON FUNCTION resources_cms.actor(),resources_cms.has_role(text[]) TO resources_cms_command_owner;\n-- Remove only',
 'SET LOCAL ROLE postgres; GRANT EXECUTE ON FUNCTION resources_cms.actor(),resources_cms.has_role(text[]) TO resources_cms_command_owner;\n-- Remove only');
 await db.exec(baseline);
 await db.exec("RESET ROLE");
 await db.exec(`INSERT INTO resources_cms.members VALUES('${u}','owner',true);
 INSERT INTO auth.sessions VALUES('${sid}','${u}',NULL,'aal2','${factor}');
 INSERT INTO auth.mfa_factors VALUES('${factor}','${u}','verified','totp');
 INSERT INTO storage.objects VALUES('resources-cms-media','private.webp','${u}'),('company-manuals','private.pdf','${u}');
`);
 // Scout's managed ACL model: only postgres has preexisting Auth access.
 await db.exec('RESET ROLE');
 const storageSource=read('supabase/schema-proposals/owner-storage.sql');
 for(const name of ['owner_storage_member','owner_storage_orphan_object']){
 const body=storageSource.match(new RegExp('CREATE FUNCTION resources_cms\\.'+name+'[\\s\\S]*?\\$\\$;'))[0];
 await db.exec(body+`; ALTER FUNCTION resources_cms.${name}(${name==='owner_storage_member'?'text[]':'text'}) OWNER TO resources_cms_command_owner; REVOKE ALL ON FUNCTION resources_cms.${name}(${name==='owner_storage_member'?'text[]':'text'}) FROM PUBLIC; GRANT EXECUTE ON FUNCTION resources_cms.${name}(${name==='owner_storage_member'?'text[]':'text'}) TO authenticated;`);
 }
 await db.exec(`INSERT INTO resources_cms.media(id,name,mime,size_bytes,object_key,checksum,alt,created_by)
 VALUES('${factor}','registered.webp','image/webp',10,'images/${factor}.webp',repeat('a',64),'synthetic','${u}');
 CREATE POLICY cms_storage_registered_media ON resources_cms.media FOR SELECT TO resources_cms_command_owner
 USING(resources_cms.owner_storage_member(ARRAY['owner','editor','reviewer','viewer']));
 REVOKE CREATE ON SCHEMA resources_cms FROM resources_cms_command_owner; SET ROLE postgres;`);
 await db.exec('RESET ROLE; GRANT USAGE ON SCHEMA auth,resources_cms,storage TO supabase_storage_admin; GRANT EXECUTE ON FUNCTION resources_cms.owner_storage_member(text[]),resources_cms.owner_storage_orphan_object(text) TO supabase_storage_admin; SET ROLE supabase_storage_admin');
 await db.exec(`CREATE POLICY resources_cms_boundary_select ON storage.objects AS RESTRICTIVE FOR SELECT TO anon,authenticated USING(((bucket_id <> 'resources-cms-media'::text) OR resources_cms.owner_storage_member(ARRAY['owner'::text, 'editor'::text, 'reviewer'::text, 'viewer'::text])));
CREATE POLICY resources_cms_media_member_select ON storage.objects AS PERMISSIVE FOR SELECT TO authenticated USING(((bucket_id = 'resources-cms-media'::text) AND resources_cms.owner_storage_member(ARRAY['owner'::text, 'editor'::text, 'reviewer'::text, 'viewer'::text])));
CREATE POLICY resources_cms_boundary_insert ON storage.objects AS RESTRICTIVE FOR INSERT TO anon,authenticated WITH CHECK(((bucket_id <> 'resources-cms-media'::text) OR ((owner_id = (auth.uid())::text) AND resources_cms.owner_storage_orphan_object(name))));
CREATE POLICY resources_cms_media_insert ON storage.objects AS PERMISSIVE FOR INSERT TO authenticated WITH CHECK(((bucket_id = 'resources-cms-media'::text) AND (owner_id = (auth.uid())::text) AND resources_cms.owner_storage_orphan_object(name)));
CREATE POLICY resources_cms_boundary_delete ON storage.objects AS RESTRICTIVE FOR DELETE TO anon,authenticated USING(((bucket_id <> 'resources-cms-media'::text) OR ((owner_id = (auth.uid())::text) AND resources_cms.owner_storage_orphan_object(name))));
CREATE POLICY resources_cms_media_delete ON storage.objects AS PERMISSIVE FOR DELETE TO authenticated USING(((bucket_id = 'resources-cms-media'::text) AND (owner_id = (auth.uid())::text) AND resources_cms.owner_storage_orphan_object(name)));
CREATE POLICY resources_cms_boundary_update ON storage.objects AS RESTRICTIVE FOR UPDATE TO anon,authenticated USING((bucket_id <> 'resources-cms-media'::text)) WITH CHECK((bucket_id <> 'resources-cms-media'::text));
 CREATE POLICY company_manuals_scope ON storage.objects FOR ALL TO authenticated
 USING(bucket_id='company-manuals' AND owner_id=auth.uid()::text)
 WITH CHECK(bucket_id='company-manuals' AND owner_id=auth.uid()::text);
 CREATE POLICY other_bucket_scope ON storage.objects FOR ALL TO authenticated
 USING(bucket_id='other-private' AND owner_id=auth.uid()::text)
 WITH CHECK(bucket_id='other-private' AND owner_id=auth.uid()::text);`);
 await db.exec('RESET ROLE');
 await db.exec(`GRANT EXECUTE ON FUNCTION resources_cms.owner_storage_member(text[]) TO anon;
 INSERT INTO storage.objects VALUES('other-private','other.txt','${u}'),('company-manuals','foreign.pdf','${other}'); SET ROLE postgres;`);
 const contract=read('supabase/schema-proposals/mfa-storage-policy-contract.sql');
 const initialContract=(await db.query(contract)).rows[0];
 assert.equal(initialContract.composition_valid,true,JSON.stringify(initialContract));
 await db.query("SELECT set_config('resources_cms.review_storage_policy_digest',$1,false)",[initialContract.inventory_digest]);
 await t.test('read-only policy preflight and unavailable Storage-owner boundary',async()=>{
 const {rows:[r]}=await db.query(`SELECT c.relowner::regrole::text owner,
 pg_has_role('postgres',c.relowner,'MEMBER') member,pg_has_role('postgres',c.relowner,'SET') can_set,
 pg_has_role('postgres',c.relowner,'USAGE') usage,
 EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid=c.relowner AND member='postgres'::regrole AND admin_option) admin_option FROM pg_class c WHERE c.oid='storage.objects'::regclass`);
 assert.deepEqual(r,{owner:'supabase_storage_admin',member:false,can_set:false,usage:false,admin_option:false});
 await assert.rejects(db.exec('CREATE POLICY forbidden_owner_ddl ON storage.objects USING(true)'),/must be owner|permission denied/);
 const results=await db.exec(read('supabase/schema-proposals/mfa-aal2-preflight.sql'));assert(results.length>5);
 });
 await t.test('reader privilege reality has no command-owner Auth access or grant option',async()=>{
 const {rows:[r]}=await db.query(`SELECT (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) AS super,
 has_schema_privilege('postgres','auth','USAGE') AS usage,
 has_schema_privilege('postgres','auth','USAGE WITH GRANT OPTION') AS grantable,
 has_schema_privilege('resources_cms_command_owner','auth','USAGE') AS command_usage`);
 assert.deepEqual(r,{super:false,usage:true,grantable:false,command_usage:false});
 });
 const proposal=read('supabase/schema-proposals/mfa-aal2-review.sql');
 assert.match(proposal,/ROLLBACK;\s*$/);
 await t.test('policy drift or missing independently bound digest aborts before changes',async()=>{
 await db.query("SELECT set_config('resources_cms.review_storage_policy_digest','',false)");
 await assert.rejects(db.exec(proposal),/Storage helper policy composition\/digest drift/);await db.exec('ROLLBACK');
 await db.exec(`RESET ROLE; SET ROLE supabase_storage_admin;
 ALTER POLICY resources_cms_boundary_select ON storage.objects USING(true); SET ROLE postgres;`);
 await assert.rejects(db.exec(proposal),/Storage helper policy composition\/digest drift/);await db.exec('ROLLBACK');
 await db.exec(`RESET ROLE; SET ROLE supabase_storage_admin;
 ALTER POLICY resources_cms_boundary_select ON storage.objects USING((bucket_id <> 'resources-cms-media') OR resources_cms.owner_storage_member(ARRAY['owner','editor','reviewer','viewer']));
 CREATE POLICY unexpected_cms_policy ON storage.objects FOR SELECT TO authenticated USING(bucket_id='resources-cms-media'); SET ROLE postgres;`);
 assert.equal((await db.query(contract)).rows[0].composition_valid,false);
 await db.exec('RESET ROLE; SET ROLE supabase_storage_admin; DROP POLICY unexpected_cms_policy ON storage.objects; SET ROLE postgres;');
 const restored=(await db.query(contract)).rows[0];assert.equal(restored.composition_valid,true);
 await db.query("SELECT set_config('resources_cms.review_storage_policy_digest',$1,false)",[restored.inventory_digest]);
 });
 // Memory-only candidate installation; no network/database endpoint is used.
 await t.test('exact guarded transfer and transaction rollback restore captured catalog baseline',async()=>{
 await db.exec(proposal.replace(/ROLLBACK;\s*$/,''));
 const restored=await db.exec(read('supabase/schema-proposals/mfa-aal2-rollback-review.sql'));
 assert(restored.some(x=>x.rows?.some(r=>String(r.rollback_evidence).startsWith('PASS: exact'))));
 });
 await db.exec('SET ROLE postgres');
 await t.test('injected failure with temporary privileges restores exact baseline without cleanup',async()=>{
 const prefix=proposal.slice(0,proposal.indexOf('CREATE TABLE resources_cms.mfa_policy'));
 await db.exec(prefix);
 await assert.rejects(db.exec("DO $$ BEGIN RAISE EXCEPTION 'synthetic interruption'; END $$;"),/synthetic interruption/);
 const restored=await db.exec(read('supabase/schema-proposals/mfa-aal2-rollback-review.sql'));
 assert(restored.some(x=>x.rows?.some(r=>String(r.rollback_evidence).startsWith('PASS: exact'))));
 });
 await db.exec('SET ROLE postgres');
 // Behavioral install is in-memory only; exact rollback is tested above.
 await db.exec(proposal.replace(/ROLLBACK;\s*$/,'COMMIT;'));
 const claims=over=>({sub:u,session_id:sid,role:'authenticated',aal:'aal2',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+600,...over});
 const admin=async sql=>{await db.exec('SET SESSION AUTHORIZATION test_root; RESET ROLE;');return db.exec(sql)};
 const caller=async(over={},transport='authenticator')=>{
 await admin(`SET SESSION AUTHORIZATION ${transport}; SET ROLE authenticated;`);
 await db.query("SELECT set_config('request.jwt.claims',$1,false)",[JSON.stringify(claims(over))]);
 };
 const role=async name=>(await db.query(`SELECT resources_cms.${name}() AS role`)).rows[0].role;
 const count=async bucket=>(await db.query('SELECT count(*)::int n FROM storage.objects WHERE bucket_id=$1',[bucket])).rows[0].n;
 await t.test('off by default; server policy mismatch denied; legacy query stays usable',async()=>{
 await caller({aal:'aal1'});assert.equal((await db.query("SELECT resources_cms.query('member-role') AS r")).rows[0].r,'owner');
 await assert.rejects(role('mfa_private_role'),/policy not ready/);
 assert.equal(await role('mfa_member_role'),'owner');
 });
 await t.test('gate OFF compatibility: current member read and owned orphan insert/delete; UPDATE still denied',async()=>{
 await caller({aal:'aal1'});assert.equal(await count('resources-cms-media'),1);
 assert.equal((await db.query("SELECT resources_cms.owner_storage_member(ARRAY['owner']) allowed")).rows[0].allowed,true);
 await db.query("INSERT INTO storage.objects VALUES('resources-cms-media',$1,$2)",[`images/${other}.webp`,u]);
 assert.equal(await count('resources-cms-media'),2);
 assert.equal((await db.query("DELETE FROM storage.objects WHERE bucket_id='resources-cms-media' AND name=$1 RETURNING *",[`images/${other}.webp`])).rows.length,1);
 assert.equal((await db.query("UPDATE storage.objects SET name='denied' WHERE bucket_id='resources-cms-media' RETURNING *")).rows.length,0);
 assert.equal(await count('company-manuals'),1);assert.equal(await count('other-private'),1);
 });
 await admin('UPDATE resources_cms.mfa_policy SET require_aal2=true');
 await t.test('AAL1 bootstrap only: normal query/dispatch/Storage denied',async()=>{
 await caller({aal:'aal1'});assert.equal(await role('mfa_member_role'),'owner');
 await assert.rejects(db.query("SELECT resources_cms.query('article-list')"),/authorization denied/);
 await assert.rejects(db.query(`SELECT resources_cms.dispatch('${factor}','${factor}',1,'update','{}')`),/authorization denied/);
 assert.equal(await count('resources-cms-media'),0);
 await assert.rejects(db.exec("INSERT INTO storage.objects VALUES('resources-cms-media','new.webp','x')"),/row-level security/);
 assert.equal((await db.query("DELETE FROM storage.objects WHERE bucket_id='resources-cms-media' RETURNING *")).rows.length,0);
 assert.equal((await db.query("UPDATE storage.objects SET name='bad' WHERE bucket_id='resources-cms-media' RETURNING *")).rows.length,0);
 assert.equal(await count('company-manuals'),1,'non-CMS bucket unaffected by new fence');
 });
 await t.test('direct AAL1 Storage helper RPCs disclose no membership or orphan state',async()=>{
 await caller({aal:'aal1'});
 for(const roles of [['owner'],['editor'],['owner','editor','reviewer','viewer']]){
 assert.equal((await db.query('SELECT resources_cms.owner_storage_member($1::text[]) AS allowed',[roles])).rows[0].allowed,false);
 }
 assert.equal((await db.query('SELECT resources_cms.owner_storage_orphan_object($1) AS allowed',[`images/${other}.webp`])).rows[0].allowed,false);
 assert.equal((await db.query('SELECT resources_cms.owner_storage_orphan_object($1) AS allowed',[`images/${factor}.webp`])).rows[0].allowed,false);
 await caller({aal:'aal1',iat:1});
 assert.equal((await db.query("SELECT resources_cms.owner_storage_member(ARRAY['owner']) AS allowed")).rows[0].allowed,false);
 assert.equal(await count('resources-cms-media'),0);
 });
 await t.test('legitimate AAL2 Storage helpers allow own role and canonical orphan',async()=>{
 await caller();
 assert.equal((await db.query("SELECT resources_cms.owner_storage_member(ARRAY['owner']) AS allowed")).rows[0].allowed,true);
 assert.equal((await db.query('SELECT resources_cms.owner_storage_orphan_object($1) AS allowed',[`images/${other}.webp`])).rows[0].allowed,true);
 assert.equal((await db.query('SELECT resources_cms.owner_storage_orphan_object($1) AS allowed',['../company-manuals/private.pdf'])).rows[0].allowed,false);
 assert.equal((await db.query('SELECT resources_cms.owner_storage_orphan_object($1) AS allowed',[`images/${factor}.webp`])).rows[0].allowed,false,'registered media is not an orphan');
 });
 await t.test('AAL2 existing policies permit owner/editor orphan INSERT/DELETE, deny wrong owner/viewer and all UPDATE',async()=>{
 for(const roleName of ['owner','editor']){
 await admin(`UPDATE resources_cms.members SET role='${roleName}' WHERE user_id='${u}'`);await caller();
 await db.query("INSERT INTO storage.objects VALUES('resources-cms-media',$1,$2)",[`images/${other}.webp`,u]);
 assert.equal((await db.query("DELETE FROM storage.objects WHERE bucket_id='resources-cms-media' AND name=$1 RETURNING *",[`images/${other}.webp`])).rows.length,1);
 await assert.rejects(db.query("INSERT INTO storage.objects VALUES('resources-cms-media',$1,$2)",[`images/${other}.webp`,other]),/row-level security/);
 assert.equal((await db.query("UPDATE storage.objects SET name='denied' WHERE bucket_id='resources-cms-media' RETURNING *")).rows.length,0);
 }
 await admin(`UPDATE resources_cms.members SET role='viewer' WHERE user_id='${u}'`);await caller();assert.equal(await count('resources-cms-media'),1);
 await assert.rejects(db.query("INSERT INTO storage.objects VALUES('resources-cms-media',$1,$2)",[`images/${other}.webp`,u]),/row-level security/);
 await admin(`UPDATE resources_cms.members SET role='owner' WHERE user_id='${u}'`);
 });
 await t.test('unrelated buckets preserve caller scope at AAL1 and AAL2 under gate ON',async()=>{
 for(const aal of ['aal1','aal2']){
 await caller({aal});assert.equal(await count('company-manuals'),1);assert.equal(await count('other-private'),1);
 await db.query("INSERT INTO storage.objects VALUES('other-private','temporary.txt',$1)",[u]);
 assert.equal((await db.query("DELETE FROM storage.objects WHERE bucket_id='other-private' AND name='temporary.txt' RETURNING *")).rows.length,1);
 await assert.rejects(db.query("INSERT INTO storage.objects VALUES('company-manuals','foreign.pdf',$1)",[other]),/row-level security/);
 }
 });
 await t.test('AAL2 current member/session/factor allowed; bootstrap rejects AAL2',async()=>{
 await caller();assert.equal(await role('mfa_private_role'),'owner');
 assert.equal((await db.query("SELECT resources_cms.query('member-role') AS r")).rows[0].r,'owner');
 assert.equal(await count('resources-cms-media'),1);
 assert.equal((await db.query("UPDATE storage.objects SET name='tampered' WHERE bucket_id='resources-cms-media' RETURNING *")).rows.length,0,'existing UPDATE fence retained');
 await assert.rejects(role('mfa_member_role'),/membership denied/);
 });
 for(const [label,over] of [['nonmember',{sub:other}],['foreign session',{session_id:other}],['expired',{exp:1}],['missing session',{session_id:null}],['anonymous',{is_anonymous:true}],['wrong role',{role:'anon'}],['missing AAL',{aal:null}],['malformed session',{session_id:'bad'}]]){
 await t.test(label+' denied at RPC and Storage',async()=>{
 await caller(over);await assert.rejects(role('mfa_private_role'),/membership denied/);assert.equal(await count('resources-cms-media'),0);
 });
 }
 await t.test('valid foreign account session/factor grants no CMS membership',async()=>{
 await admin(`INSERT INTO auth.sessions VALUES('${other}','${other}',NULL,'aal2','${other}'); INSERT INTO auth.mfa_factors VALUES('${other}','${other}','verified','totp')`);
 await caller({sub:other,session_id:other});
 await assert.rejects(role('mfa_private_role'),/membership denied/);
 await assert.rejects(db.query("SELECT resources_cms.query('article-list')"),/membership denied/);
 assert.equal(await count('resources-cms-media'),0);
 await caller({sub:other,session_id:other,aal:'aal1'});await assert.rejects(role('mfa_member_role'),/membership denied/);
 await admin(`DELETE FROM auth.sessions WHERE id='${other}'; DELETE FROM auth.mfa_factors WHERE id='${other}'`);
 });
 await t.test('inactive/revoked membership checked without token refresh',async()=>{
 await admin(`UPDATE resources_cms.members SET active=false WHERE user_id='${u}'`);await caller();await assert.rejects(role('mfa_private_role'),/membership denied/);assert.equal(await count('resources-cms-media'),0);
 await admin(`UPDATE resources_cms.members SET active=true WHERE user_id='${u}'`);
 });
 await t.test('factor removal immediately denies stale AAL2',async()=>{
 await admin(`DELETE FROM auth.mfa_factors WHERE id='${factor}'`);await caller();await assert.rejects(role('mfa_private_role'),/membership denied/);assert.equal(await count('resources-cms-media'),0);
 await admin(`INSERT INTO auth.mfa_factors VALUES('${factor}','${u}','verified','totp')`);
 });
 await t.test('session downgrade immediately denies stale AAL2',async()=>{
 await admin(`UPDATE auth.sessions SET aal='aal1'`);await caller();await assert.rejects(role('mfa_private_role'),/membership denied/);
 await admin(`UPDATE auth.sessions SET aal='aal2'`);
 });
 await t.test('backup factor accepted only when verified and bound to this session',async()=>{
 await admin(`INSERT INTO auth.mfa_factors VALUES('${other}','${u}','verified','totp'); UPDATE auth.sessions SET factor_id='${other}'`);
 await caller();assert.equal(await role('mfa_private_role'),'owner');
 await admin(`UPDATE auth.mfa_factors SET status='unverified' WHERE id='${other}'`);await caller();await assert.rejects(role('mfa_private_role'),/membership denied/);
 await admin(`UPDATE auth.sessions SET factor_id='${factor}'`);
 });
 await t.test('expired session and logout deletion deny token replay',async()=>{
 await admin(`UPDATE auth.sessions SET not_after=now()-interval '1 second'`);await caller();await assert.rejects(role('mfa_private_role'),/membership denied/);
 await admin('DELETE FROM auth.sessions');await caller();await assert.rejects(role('mfa_private_role'),/membership denied/);assert.equal(await count('resources-cms-media'),0);
 await caller({aal:'aal1'});await assert.rejects(role('mfa_member_role'),/membership denied/);
 await admin(`INSERT INTO auth.sessions VALUES('${sid}','${u}',NULL,'aal2','${factor}')`);
 });
 await t.test('bootstrap expires server-side even if a cookie is replayed',async()=>{
 await caller({aal:'aal1',iat:1});await assert.rejects(role('mfa_member_role'),/membership denied/);
 });
 await t.test('anonymous Storage remains private and has no bootstrap EXECUTE',async()=>{
 await admin('SET SESSION AUTHORIZATION authenticator; SET ROLE anon;');
 await db.query("SELECT set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'anon'})]);
 assert.equal(await count('resources-cms-media'),0);
 await assert.rejects(role('mfa_member_role'),/permission denied/);
 });
 await t.test('forged SQL context cannot impersonate Data API transport',async()=>{
 await caller({},'authenticated');await assert.rejects(role('mfa_private_role'),/membership denied/);
 });
 await t.test('internal helpers and direct tables not executable/readable by API role',async()=>{
 await caller();await assert.rejects(db.query('SELECT resources_cms.mfa_identity(true)'),/permission denied/);
 await assert.rejects(db.query('SELECT * FROM resources_cms.members'),/permission denied/);
 await assert.rejects(db.query('UPDATE resources_cms.mfa_policy SET require_aal2=false'),/permission denied/);
 });
 }finally{await db.close()}
});
