import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const db = new PGlite();
await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated;
 CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claims',true)::jsonb->>'sub','')::uuid $$;
 CREATE SCHEMA storage;
 CREATE TABLE storage.buckets(id text PRIMARY KEY,name text NOT NULL,public boolean NOT NULL,file_size_limit bigint,allowed_mime_types text[]);
 CREATE TABLE storage.objects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),bucket_id text NOT NULL,name text NOT NULL);
 ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY; GRANT USAGE ON SCHEMA storage,auth TO anon,authenticated; GRANT SELECT,INSERT,DELETE ON storage.objects TO anon,authenticated; GRANT EXECUTE ON FUNCTION auth.uid() TO anon,authenticated;`);
await db.exec(readFileSync("supabase/migrations/20261026035555_resources_cms_isolated_v1.sql", "utf8"));
let v2 = readFileSync("supabase/migrations/20261026042156_resources_cms_commands_v2.sql", "utf8")
  .replace("session_user='authenticator' AND ", "")
  .replace(/DO \$guard\$ BEGIN\n IF current_user<>'postgres'[\s\S]*?END \$guard\$;\n/, "")
  .replace(/-- This is a second, grantor-specific row\.[\s\S]*?END \$guard\$;\n/, "")
  .replace(/-- Remove only the temporary row granted by postgres\.[\s\S]*?END \$guard\$;\n/, "");
await db.exec(v2);
await db.exec(readFileSync("supabase/migrations/20261026050000_resources_cms_storage_candidate.sql", "utf8"));
const owner = "00000000-0000-4000-8000-000000000001", category = "00000000-0000-4000-8000-000000000002", article = "00000000-0000-4000-8000-000000000003", revision = "00000000-0000-4000-8000-000000000004", media = "00000000-0000-4000-8000-000000000005";
assert.deepEqual((await db.query("SELECT public,file_size_limit,allowed_mime_types FROM storage.buckets WHERE id='resources-cms-media'")).rows[0], { public: false, file_size_limit: 4194304, allowed_mime_types: ["image/webp"] });
await db.exec(`INSERT INTO resources_cms.members VALUES('${owner}','owner',true); INSERT INTO resources_cms.taxonomy(id,kind,name) VALUES('${category}','category','Guides');
 INSERT INTO resources_cms.articles(id,slug,state,version) VALUES('${article}','published-media-test','draft',1);
 INSERT INTO resources_cms.revisions(id,article_id,revision_number,editable,rendered_html,content_checksum,primary_category_id,tag_ids,sources,audience,created_by) VALUES('${revision}','${article}',1,'{"title":"Media","slug":"published-media-test","featuredImage":"/media/${media}"}','<p><img src="/media/${media}" alt="test"></p>','x','${category}','{}','[]','homeowners','${owner}');
 INSERT INTO resources_cms.publication_authorizations(article_id,revision_id,capability,authorized_by,approval_reference) VALUES('${article}','${revision}','publish','${owner}','synthetic-storage-test');
 UPDATE resources_cms.articles SET state='published',working_revision_id='${revision}',published_revision_id='${revision}' WHERE id='${article}';
 INSERT INTO resources_cms.media(id,name,mime,size_bytes,object_key,checksum,alt,created_by) VALUES('${media}','test.webp','image/webp',10,'images/${media}.webp',repeat('a',64),'test','${owner}');`);
await db.exec(`SET ROLE authenticated; SET request.jwt.claims='{"sub":"00000000-0000-4000-8000-000000000099","role":"authenticated"}';`);
await assert.rejects(db.exec(`INSERT INTO storage.objects(bucket_id,name) VALUES('resources-cms-media','images/${media}.webp')`), /row-level security/);
await db.exec(`RESET ROLE; SET ROLE authenticated; SET request.jwt.claims='{"sub":"${owner}","role":"authenticated"}'; INSERT INTO storage.objects(bucket_id,name) VALUES('resources-cms-media','images/${media}.webp'); RESET ROLE;`);
await db.exec("SET ROLE anon; SET request.jwt.claims='{\"role\":\"anon\"}';");
assert.equal((await db.query("SELECT count(*)::int n FROM storage.objects WHERE bucket_id='resources-cms-media'")).rows[0].n, 1);
await db.exec("RESET ROLE; UPDATE resources_cms.articles SET state='draft',published_revision_id=NULL WHERE id='" + article + "'; SET ROLE anon;");
assert.equal((await db.query("SELECT count(*)::int n FROM storage.objects WHERE bucket_id='resources-cms-media'")).rows[0].n, 0);
await db.exec("RESET ROLE; SET ROLE authenticated; SET request.jwt.claims='{\"sub\":\"" + owner + "\",\"role\":\"authenticated\"}';");
assert.equal((await db.query("SELECT count(*)::int n FROM storage.objects WHERE bucket_id='resources-cms-media'")).rows[0].n, 1);
await db.close();
console.log("PASS: private Storage candidate denies nonmembers, permits scoped CMS member upload/read, exposes only currently published referenced media, and revokes public reads when unpublished. Local PostgreSQL emulation only.");
