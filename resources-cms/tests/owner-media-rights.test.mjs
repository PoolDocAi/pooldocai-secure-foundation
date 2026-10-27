import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {normalizeMediaRightsCommand,reviewMediaRights,readMediaRights,reviewedMediaDisplayReady} from '../src/production/media-rights-review.mjs';
const owner='00000000-0000-4000-8000-000000000001',editor='00000000-0000-4000-8000-000000000002',viewer='00000000-0000-4000-8000-000000000003',media='00000000-0000-4000-8000-000000000004';
const checksum='a'.repeat(64);
const details=()=>({authenticity:'authentic-photograph',sourceType:'pooldocai-original',sourceUrl:'https://pooldocai.com/owned-image',attribution:'PoolDocAI',license:'Owned original',permissionReference:'owner-original-001',copyright:'PoolDocAI',checksum,width:8,height:6,alt:'Pool equipment model label',equipment:{manufacturer:'Example',model:'Test',representative:false}});
async function fixture(){const db=new PGlite();await db.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE authenticator;GRANT authenticated TO authenticator;');await db.exec(readFileSync('supabase/migrations/20261026035555_resources_cms_isolated_v1.sql','utf8'));const sql=readFileSync('supabase/migrations/20261026042156_resources_cms_commands_v2.sql','utf8').replace(/DO \$guard\$ BEGIN\n IF current_user<>'postgres'[\s\S]*?END \$guard\$;\n/,'').replace(/-- This is a second, grantor-specific row\.[\s\S]*?END \$guard\$;\n/,'').replace(/-- Remove only the temporary row granted by postgres\.[\s\S]*?END \$guard\$;\n/,'');await db.exec(sql);await db.exec(readFileSync('supabase/schema-proposals/owner-media-rights.sql','utf8'));await db.exec(`INSERT INTO resources_cms.members VALUES('${owner}','owner',true),('${editor}','editor',true),('${viewer}','viewer',true);INSERT INTO resources_cms.media(id,name,mime,size_bytes,object_key,checksum,alt,created_by)VALUES('${media}','Test original','image/webp',100,'images/${media}.webp','${checksum}','Test alt','${owner}');`);return db;}
async function signIn(db,id){await db.exec('SET SESSION AUTHORIZATION postgres;RESET ROLE');await db.query("SELECT set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:id,role:'authenticated'})]);await db.exec('SET SESSION AUTHORIZATION authenticator;SET ROLE authenticated');}
async function command(db,version,action,data={},id=randomUUID()){return(await db.query('SELECT resources_cms.media_rights_command($1,$2,$3,$4,$5) value',[id,media,version,action,JSON.stringify(data)])).rows[0].value;}

test('real local PostgreSQL roles enforce pending review, owner approval, immutable events and revocation',async()=>{const db=await fixture();try{
 await signIn(db,viewer);await assert.rejects(command(db,0,'submit',details()),/Editor required/);
 await signIn(db,editor);const pending=await command(db,0,'submit',details());assert.equal(pending.status,'pending');assert.equal(pending.ready,false);
 await assert.rejects(command(db,1,'approve',{humanVerified:true}),/Owner required/);
 await assert.rejects(db.exec('SELECT * FROM resources_cms.media_rights_reviews'),/permission denied/);
 await signIn(db,owner);await assert.rejects(command(db,1,'approve',{humanVerified:false}),/human rights/);await assert.rejects(command(db,0,'approve',{humanVerified:true}),/version conflict/);
 const approveId=randomUUID();const approved=await command(db,1,'approve',{humanVerified:true},approveId);assert.equal(approved.status,'approved');assert.equal(approved.ready,true);assert.equal(reviewedMediaDisplayReady(approved),true);assert.equal(approved.reviewerId,owner);
 const same=await command(db,1,'approve',{humanVerified:true},approveId);assert.equal(same.version,2);assert.equal(same.replayed,true);
 await assert.rejects(command(db,2,'submit',details()),/revoke approved/);
 await assert.rejects(command(db,2,'revoke',{reason:'different'},approveId),/Idempotency key reuse/);
 const revoked=await command(db,2,'revoke',{reason:'Permission withdrawn'});assert.equal(revoked.ready,false);assert.equal(revoked.status,'revoked');
 assert.equal((await command(db,1,'approve',{humanVerified:true},approveId)).ready,false,'replayed approval cannot revive eligibility');
 const read=(await db.query('SELECT resources_cms.media_rights_read($1) value',[media])).rows[0].value;assert.equal(read[0].status,'revoked');
 await db.exec('SET SESSION AUTHORIZATION postgres;RESET ROLE');await assert.rejects(db.exec("UPDATE resources_cms.media_rights_reviews SET review_status='approved'"),/immutable/);await assert.rejects(db.exec('DELETE FROM resources_cms.media_rights_reviews'),/immutable/);
 assert.equal((await db.query('SELECT count(*)::int n FROM resources_cms.media_rights_reviews')).rows[0].n,3);
}finally{await db.close();}});

test('expiration, incomplete rights, invented synthetic photos and checksum drift fail closed',async()=>{const db=await fixture();try{await signIn(db,owner);
 await assert.rejects(command(db,0,'submit',{...details(),reviewStatus:'approved'}),/Client review claims/);
 await assert.rejects(command(db,0,'submit',{...details(),checksum:'b'.repeat(64)}),/checksum/);
 const expired={...details(),expiresAt:'2000-01-01T00:00:00Z'};await command(db,0,'submit',expired);await assert.rejects(command(db,1,'approve',{humanVerified:true}),/human rights/);
 await command(db,1,'submit',{...details(),authenticity:'ai-generated'});await assert.rejects(command(db,2,'approve',{humanVerified:true}),/human rights/);
 await command(db,2,'submit',{...details(),permissionReference:''});await assert.rejects(command(db,3,'approve',{humanVerified:true}),/human rights/);
 await command(db,3,'submit',details());await command(db,4,'approve',{humanVerified:true});
 await db.exec('SET SESSION AUTHORIZATION postgres;RESET ROLE');await db.exec(`UPDATE resources_cms.media SET checksum=repeat('b',64) WHERE id='${media}'`);await signIn(db,owner);assert.equal((await db.query('SELECT resources_cms.media_rights_read($1) value',[media])).rows[0].value[0].ready,false);
}finally{await db.close();}});

test('forged direct SQL claims, anonymous RPCs, and audit transaction failures cannot approve media',async()=>{const db=await fixture();try{
 await db.query("SELECT set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,role:'authenticated'})]);await assert.rejects(command(db,0,'submit',details()),/Editor required/);
 await db.exec('SET ROLE anon');await assert.rejects(db.query('SELECT resources_cms.media_rights_read($1)',[media]),/permission denied/);await db.exec('RESET ROLE');
 await signIn(db,owner);await command(db,0,'submit',details());await db.exec('SET SESSION AUTHORIZATION postgres;RESET ROLE');await db.exec("CREATE FUNCTION resources_cms.test_reject_audit()RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic audit failure';END$$;CREATE TRIGGER test_media_audit_failure BEFORE INSERT ON resources_cms.audit FOR EACH ROW EXECUTE FUNCTION resources_cms.test_reject_audit();");await signIn(db,owner);await assert.rejects(command(db,1,'approve',{humanVerified:true}),/synthetic audit failure/);const read=(await db.query('SELECT resources_cms.media_rights_read($1) value',[media])).rows[0].value;assert.equal(read[0].status,'pending');assert.equal(read[0].version,1);
}finally{await db.close();}});

test('JS adapter uses verified identity and exact version/command with no client self-approval',async()=>{assert.throws(()=>normalizeMediaRightsCommand('approve',{mediaId:media,version:1,details:{humanVerified:'true'}}),/human/);assert.throws(()=>normalizeMediaRightsCommand('submit',{mediaId:media,version:0,details:{...details(),reviewerId:owner}}),/Client/);await assert.rejects(readMediaRights({},null,media),/Verified CMS/);const calls=[];const db={rpc:async(...args)=>{calls.push(args);return{};}};await reviewMediaRights(db,{id:owner,accessToken:'verified-token'},'submit',{mediaId:media,version:0,commandId:media,details:details()});assert.equal(calls[0][0],'media_rights_command');assert.equal(calls[0][1].p_version,0);assert.equal(calls[0][2],'verified-token');});

test('real local Storage RLS permits only caller-owned orphan cleanup and prevents registered delete or overwrite',async()=>{const db=await fixture();try{
 await db.exec(`CREATE SCHEMA auth;CREATE FUNCTION auth.uid()RETURNS uuid LANGUAGE sql STABLE AS $$SELECT (current_setting('request.jwt.claims',true)::jsonb->>'sub')::uuid$$;GRANT USAGE ON SCHEMA auth TO anon,authenticated,resources_cms_command_owner;GRANT EXECUTE ON FUNCTION auth.uid()TO anon,authenticated,resources_cms_command_owner;
 CREATE SCHEMA storage;CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text,name text,owner_id text,UNIQUE(bucket_id,name));ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;GRANT USAGE ON SCHEMA storage TO authenticated,anon;GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO authenticated;GRANT SELECT ON storage.objects TO anon;CREATE ROLE local_storage_transport;GRANT authenticated TO local_storage_transport;`);
 await db.exec("CREATE POLICY synthetic_existing_broad_guard ON storage.objects FOR ALL TO authenticated USING(true) WITH CHECK(true);");
 await db.exec(readFileSync('supabase/schema-proposals/owner-storage.sql','utf8'));
 await db.exec(`INSERT INTO storage.objects(bucket_id,name,owner_id)VALUES('resources-cms-media','images/${media}.webp','${owner}')`);
 await db.query("SELECT set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,role:'authenticated'})]);await db.exec('SET SESSION AUTHORIZATION local_storage_transport;SET ROLE authenticated');
 const orphan='00000000-0000-4000-8000-000000000099';await db.exec(`INSERT INTO storage.objects(bucket_id,name,owner_id)VALUES('resources-cms-media','images/${orphan}.webp','${owner}')`);
 assert.equal((await db.query(`DELETE FROM storage.objects WHERE name='images/${orphan}.webp' RETURNING id`)).rows.length,1);
 assert.equal((await db.query(`DELETE FROM storage.objects WHERE name='images/${media}.webp' RETURNING id`)).rows.length,0);
 assert.equal((await db.query(`UPDATE storage.objects SET name='images/${orphan}.webp' WHERE name='images/${media}.webp' RETURNING id`)).rows.length,0);
 await assert.rejects(db.exec(`INSERT INTO storage.objects(bucket_id,name,owner_id)VALUES('resources-cms-media','images/${orphan}.webp','${editor}')`),/row-level security/);
 // The injected preexisting global permissive policy already permits unrelated buckets.
 // Our restrictive boundary must not silently rewrite that existing core policy.
 await db.exec(`INSERT INTO storage.objects(bucket_id,name,owner_id)VALUES('private-company-manuals','images/${orphan}.webp','${owner}')`);
 assert.equal((await db.query("SELECT count(*)::int n FROM storage.objects WHERE bucket_id='private-company-manuals'")).rows[0].n,1);
 await assert.rejects(db.exec('SELECT * FROM resources_cms.media'),/permission denied/);
 await db.exec('SET SESSION AUTHORIZATION postgres;RESET ROLE;SET ROLE anon');assert.equal((await db.query('SELECT * FROM storage.objects')).rows.length,0);
}finally{await db.close();}});
