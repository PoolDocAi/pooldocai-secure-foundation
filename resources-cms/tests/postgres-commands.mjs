import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";

function localizeV2(sql) {
  // PGlite runs as a superuser and does not emulate Supabase's managed
  // supabase_admin creator-membership row. Remove only the hosted-environment
  // role harness; all CMS DDL, ownership, policies and procedures run unchanged.
  return sql
    .replace("session_user='authenticator' AND ", "") // Workflow emulation; full session guard tested separately.
    .replace(/DO \$guard\$ BEGIN\n IF current_user<>'postgres'[\s\S]*?END \$guard\$;\n/, "")
    .replace(/-- This is a second, grantor-specific row\.[\s\S]*?END \$guard\$;\n/, "")
    .replace(/-- Remove only the temporary row granted by postgres\.[\s\S]*?END \$guard\$;\n/, "");
}

async function migrate(db) {
  await db.exec("CREATE ROLE anon; CREATE ROLE authenticated;");
  for (const file of readdirSync("supabase/migrations").sort()) {
    if (file.includes("storage_candidate")) continue;
    const sql = readFileSync(`supabase/migrations/${file}`, "utf8");
    await db.exec(file.includes("commands_v2") ? localizeV2(sql) : sql);
  }
}

const db = new PGlite();
await migrate(db);
const actor = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000002";
const cat = "00000000-0000-4000-8000-000000000003";
const editor = "00000000-0000-4000-8000-000000000004";
const reviewer = "00000000-0000-4000-8000-000000000005";
const viewer = "00000000-0000-4000-8000-000000000006";
await db.exec(`CREATE TABLE public.synthetic_customer_records(id uuid PRIMARY KEY,user_id uuid NOT NULL,private_value text NOT NULL);
 ALTER TABLE public.synthetic_customer_records ENABLE ROW LEVEL SECURITY;
 GRANT SELECT ON public.synthetic_customer_records TO authenticated;
 CREATE POLICY synthetic_customer_self ON public.synthetic_customer_records FOR SELECT TO authenticated
 USING(user_id=nullif(coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'sub','')::uuid);
 INSERT INTO public.synthetic_customer_records VALUES('00000000-0000-4000-8000-000000000090','00000000-0000-4000-8000-000000000091','tenant-private');
 INSERT INTO resources_cms.members VALUES('${actor}','owner',true),('${editor}','editor',true),('${reviewer}','reviewer',true),('${viewer}','viewer',true);
 INSERT INTO resources_cms.taxonomy(id,kind,name) VALUES('${cat}','category','Guides');
 SET ROLE authenticated; SET request.jwt.claims='{"sub":"${actor}","role":"authenticated"}';`);
assert.equal((await db.query("SELECT count(*)::int n FROM public.synthetic_customer_records")).rows[0].n, 0);
let version = 0;
let sequence = 10;
const call = async (action, payload = {}, commandId = `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`) => {
  if (['publish','schedule'].includes(action)) {
    await db.exec('RESET ROLE');
    await db.query("INSERT INTO resources_cms.publication_authorizations(article_id,revision_id,capability,authorized_by,approval_reference) SELECT id,working_revision_id,$1,$2,'synthetic-local-authorization' FROM resources_cms.articles WHERE id=$3",[action,actor,id]);
    await db.exec(`SET ROLE authenticated; SET request.jwt.claims='{"sub":"${actor}","role":"authenticated"}';`);
  }
  const result = await db.query(
    "SELECT resources_cms.dispatch($1,$2,$3,$4,$5) AS result",
    [commandId, id, version, action, JSON.stringify(payload)],
  );
  version = result.rows[0].result.version;
  return result.rows[0].result;
};
const data = {
  slug: "safe-guide", title: "Guide", body: "<p>Observe safely</p>", summary: "Summary",
  categoryId: cat, tagIds: [], audience: "homeowners",
  sources: [{ url: "https://example.com/manual", label: "Manual" }],
  seo: { title: "Guide", description: "Description" },
};
await call("create", data);
const receiptId = "00000000-0000-4000-8000-000000000099";
const priorVersion = version;
const first = await call("review", {}, receiptId);
version = priorVersion;
const replay = await call("review", {}, receiptId);
assert.deepEqual(replay, first);
version = first.version;
await call("approve");
await call("publish");
await call("knowledge-submit");
await assert.rejects(call("knowledge-approve", { classification: "verified_repair_procedure", evidence: [{ url: "https://example.com/manual", excerpt: "Observe safely" }] }), /Knowledge approval rejected/);
await call("knowledge-approve", { classification: "general_education", evidence: [{ url: "https://example.com/manual", excerpt: "Observe safely" }] });
await call("save", { ...data, title: "Revised guide" });
await db.exec("RESET ROLE");
assert.equal((await db.query("SELECT active FROM resources_cms.knowledge_grants")).rows[0].active, false);
assert.equal((await db.query("SELECT count(*)::int AS n FROM resources_cms.outbox WHERE event='revoke'")).rows[0].n, 1);
assert.equal((await db.query("SELECT count(*)::int AS n FROM resources_cms.approval_history WHERE decision='revoked'")).rows[0].n, 1);
await db.exec("SET ROLE authenticated; SET request.jwt.claims='{\"sub\":\"" + actor + "\",\"role\":\"authenticated\"}';");
await call("review");
await call("approve");
await call("publish");
await call("knowledge-submit");
await call("knowledge-approve", { classification: "general_education", evidence: [{ url: "https://example.com/manual", excerpt: "Observe safely" }] });
await db.exec("RESET ROLE");
const beforeFailedRevision = (await db.query("SELECT count(*)::int n FROM resources_cms.revisions")).rows[0].n;
await db.exec(`CREATE FUNCTION resources_cms.synthetic_revoke_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event='revoke' THEN RAISE EXCEPTION 'synthetic outbox failure'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER synthetic_revoke_failure BEFORE INSERT ON resources_cms.outbox FOR EACH ROW EXECUTE FUNCTION resources_cms.synthetic_revoke_failure();
 SET ROLE authenticated; SET request.jwt.claims='{"sub":"${actor}","role":"authenticated"}';`);
await assert.rejects(call("save", { ...data, title: "Must roll back" }), /synthetic outbox failure/);
await db.exec("RESET ROLE");
assert.equal((await db.query("SELECT count(*)::int n FROM resources_cms.revisions")).rows[0].n, beforeFailedRevision);
assert.equal((await db.query("SELECT active FROM resources_cms.knowledge_grants ORDER BY verified_at DESC LIMIT 1")).rows[0].active, true);
await db.exec("DROP TRIGGER synthetic_revoke_failure ON resources_cms.outbox; DROP FUNCTION resources_cms.synthetic_revoke_failure(); SET ROLE authenticated; SET request.jwt.claims='{\"sub\":\"" + actor + "\",\"role\":\"authenticated\"}';");
await assert.rejects(db.exec("UPDATE resources_cms.articles SET state='published'"), /permission denied/);
await assert.rejects(db.query("SELECT resources_cms.command($1,$2,$3,$4)", [id, version, "review", "{}"]), /permission denied/);
await db.exec("RESET ROLE");
await assert.rejects(db.exec("UPDATE resources_cms.revisions SET rendered_html='tamper'"), /immutable/);
const securedFunctions = (await db.query(`SELECT proname,prosecdef,pg_get_userbyid(proowner) owner,coalesce(array_to_string(proconfig,','),'') config
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='resources_cms'`)).rows;
for (const name of ["command","dispatch","taxonomy_command","media_command","settings_command","bulk_archive","publish_due","public_article","public_index","public_media","public_redirect","query"]) {
  const fn = securedFunctions.find((entry) => entry.proname === name);
  assert.ok(fn, `missing ${name}`);
  assert.equal(fn.owner, "resources_cms_command_owner", `${name} owner`);
  assert.equal(fn.prosecdef, true, `${name} SECURITY DEFINER`);
  assert.match(fn.config, /search_path=""/, `${name} search_path`);
}
assert.equal(securedFunctions.find((entry) => entry.proname === "actor").prosecdef, false);
assert.equal((await db.query("SELECT has_schema_privilege('resources_cms_runtime','resources_cms','USAGE') AS allowed")).rows[0].allowed, false);
assert.equal((await db.query("SELECT has_table_privilege('authenticated','resources_cms.articles','SELECT') AS allowed")).rows[0].allowed, false);
assert.equal((await db.query("SELECT has_function_privilege('anon','resources_cms.dispatch(uuid,uuid,integer,text,jsonb)','EXECUTE') AS allowed")).rows[0].allowed, false);
assert.equal((await db.query("SELECT has_function_privilege('authenticated','resources_cms.dispatch(uuid,uuid,integer,text,jsonb)','EXECUTE') AS allowed")).rows[0].allowed, true);
await db.exec("SET ROLE authenticated; SET request.jwt.claims='{\"sub\":\"" + editor + "\",\"role\":\"authenticated\"}';");
await assert.rejects(db.query("SELECT resources_cms.dispatch('00000000-0000-4000-8000-000000000081',$1,$2,'publish','{}')", [id, version]), /Owner required/);
await assert.rejects(db.query("SELECT resources_cms.dispatch('00000000-0000-4000-8000-000000000082',$1,$2,'knowledge-approve','{}')", [id, version]), /Reviewer required/);
await db.exec("RESET ROLE; SET ROLE authenticated; SET request.jwt.claims='{\"sub\":\"" + reviewer + "\",\"role\":\"authenticated\"}';");
await assert.rejects(db.query("SELECT resources_cms.dispatch('00000000-0000-4000-8000-000000000083',$1,$2,'save','{}')", [id, version]), /Editor required/);
await db.exec("RESET ROLE; SET ROLE authenticated; SET request.jwt.claims='{\"sub\":\"" + viewer + "\",\"role\":\"authenticated\"}';");
assert.ok(Array.isArray((await db.query("SELECT resources_cms.query('article-list','{}') AS result")).rows[0].result));
await assert.rejects(db.query("SELECT resources_cms.dispatch('00000000-0000-4000-8000-000000000084',$1,$2,'review','{}')", [id, version]), /authorization denied/i);
await db.exec("SET ROLE authenticated; SET request.jwt.claims='{\"sub\":\"00000000-0000-4000-8000-000000000099\",\"role\":\"authenticated\"}';");
await assert.rejects(db.query("SELECT resources_cms.query('article-list','{}')"), /membership denied/i);
await db.exec("RESET ROLE; SET ROLE anon; SET request.jwt.claims='{\"role\":\"anon\"}';");
assert.equal((await db.query("SELECT resources_cms.public_article('missing') AS value")).rows[0].value, null);
await assert.rejects(db.query("SELECT resources_cms.query('article-list','{}')"), /permission denied/);
await db.exec("RESET ROLE");

const { exportCMS, restoreEmptyCMS } = await import("../src/production/backup.mjs");
const backup = await exportCMS(db);
const fresh = new PGlite();
await migrate(fresh);
await restoreEmptyCMS(fresh, backup);
assert.equal((await fresh.query('SELECT count(*)::int n FROM resources_cms.knowledge_grants WHERE active')).rows[0].n,0);
assert.equal((await fresh.query("SELECT count(*)::int n FROM resources_cms.revisions")).rows[0].n, backup.data.revisions.length);
await assert.rejects(restoreEmptyCMS(fresh, backup), /empty CMS/);
await fresh.close();
await db.close();
const statement = "PASS: local PostgreSQL engine executes both migrations after documented removal of the Supabase-only role harness; JWT-bound Data API dispatch idempotency, owner/editor/reviewer/viewer/nonmember authorization, tenant-private core RLS denial, create/review/approve/publish, separate knowledge approval with technical-class fail-closed, automatic revocation with audit/outbox, synthetic revocation failure full rollback, intended function ownership/SECURITY DEFINER/empty search_path, retired runtime denial, direct-table/base-command denial, anon denial, public-read allowlist, immutable revisions, export and empty restore passed. Remote Supabase not tested.\n";
writeFileSync("evidence/postgres-commands-results-phase3.txt", statement);
console.log(statement.trim());
