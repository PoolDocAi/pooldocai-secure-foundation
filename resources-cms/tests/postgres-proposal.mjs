import { PGlite } from "@electric-sql/pglite";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
const db = new PGlite();
const results = [];
const ok = (name) => {
  results.push({ name, passed: true });
  console.log("PASS", name);
};
await db.exec(
  "CREATE ROLE anon; CREATE ROLE authenticated; CREATE TABLE public.core_sentinel(id int PRIMARY KEY,private_value text); INSERT INTO public.core_sentinel VALUES(1,'tenant-private'); ALTER TABLE public.core_sentinel ENABLE ROW LEVEL SECURITY; CREATE POLICY core_deny ON public.core_sentinel TO authenticated USING(false);",
);
const before = (
  await db.query(
    "SELECT policyname,qual FROM pg_policies WHERE schemaname='public'",
  )
).rows;
const file = readdirSync("supabase/migrations").find((p) =>
  p.endsWith("_resources_cms_isolated_v1.sql"),
);
await db.exec(readFileSync("supabase/migrations/" + file, "utf8"));
ok(
  "Proposed migration executes in a real local PostgreSQL WASM engine (not Supabase)",
);
assert.deepEqual(
  (
    await db.query(
      "SELECT policyname,qual FROM pg_policies WHERE schemaname='public'",
    )
  ).rows,
  before,
);
assert.equal(
  (await db.query("SELECT private_value FROM public.core_sentinel")).rows[0]
    .private_value,
  "tenant-private",
);
ok("Existing public sentinel table and policy are unchanged");
const owner = "00000000-0000-4000-8000-000000000001",
  editor = "00000000-0000-4000-8000-000000000002",
  nonmember = "00000000-0000-4000-8000-000000000003";
await db.exec(
  `INSERT INTO resources_cms.members VALUES('${owner}','owner',true),('${editor}','editor',true); INSERT INTO resources_cms.taxonomy(kind,name) VALUES('category','Example');`,
);
await db.exec("SET ROLE anon");
await assert.rejects(
  db.query("SELECT * FROM resources_cms.taxonomy"),
  /permission denied/,
);
await db.exec("RESET ROLE");
ok("Anonymous role cannot access the CMS schema");
await db.exec("SET ROLE authenticated");
await assert.rejects(
  db.query("SELECT * FROM resources_cms.taxonomy"),
  /permission denied/,
);
await db.exec("RESET ROLE");
ok("Core authenticated role gains no CMS privilege");
await db.exec(
  `SET ROLE resources_cms_runtime; SET resources_cms.actor_id='${nonmember}';`,
);
assert.equal(
  (await db.query("SELECT * FROM resources_cms.taxonomy")).rows.length,
  0,
);
await db.exec("RESET ROLE");
ok("CMS runtime without explicit membership sees no rows");
await db.exec(
  `SET ROLE resources_cms_runtime; SET resources_cms.actor_id='${owner}';`,
);
assert.equal(
  (await db.query("SELECT * FROM resources_cms.members")).rows.length,
  1,
);
assert.equal(
  (await db.query("SELECT * FROM resources_cms.taxonomy")).rows.length,
  1,
);
await assert.rejects(
  db.query("SELECT * FROM public.core_sentinel"),
  /permission denied/,
);
await assert.rejects(
  db.query("UPDATE resources_cms.members SET role='owner'"),
  /permission denied/,
);
await assert.rejects(
  db.query(
    "INSERT INTO resources_cms.taxonomy(kind,name) VALUES('tag','Unauthorized')",
  ),
  /permission denied/,
);
await db.exec("RESET ROLE");
ok(
  "Owner membership permits CMS reads, no tenant reads, privilege escalation or unwired writes",
);
await db.exec(
  `SET ROLE resources_cms_runtime; SET resources_cms.actor_id='${editor}';`,
);
assert.equal(
  (
    await db.query(
      "SELECT resources_cms.has_role(ARRAY['owner','reviewer']) AS allowed",
    )
  ).rows[0].allowed,
  false,
);
await db.exec("RESET ROLE");
ok("Editor membership cannot act as reviewer/owner");
const rls = (
  await db.query(
    "SELECT c.relname,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='resources_cms' AND c.relkind='r'",
  )
).rows;
assert.ok(rls.length >= 10 && rls.every((r) => r.relrowsecurity));
ok("All proposed CMS tables have RLS enabled");
writeFileSync(
  "evidence/postgres-proposal-results.json",
  JSON.stringify(
    {
      environment:
        "PGlite local PostgreSQL WASM; Supabase Auth/Storage and remote environments NOT tested",
      results,
    },
    null,
    2,
  ),
);
await db.close();
