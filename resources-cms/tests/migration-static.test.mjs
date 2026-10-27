import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const v1 = readFileSync("supabase/migrations/20261026035555_resources_cms_isolated_v1.sql", "utf8");
const v2 = readFileSync("supabase/migrations/20261026042156_resources_cms_commands_v2.sql", "utf8");
const storage = readFileSync("supabase/migrations/20261026050000_resources_cms_storage_candidate.sql", "utf8");

test("every CMS function fixes search_path", () => {
  for (const sql of [v1, v2, storage]) {
    const definitions = [...sql.matchAll(/CREATE(?: OR REPLACE)? FUNCTION resources_cms\.[\s\S]*?\$\$;/g)].map((match) => match[0]);
    assert.ok(definitions.length > 0);
    for (const definition of definitions) assert.match(definition, /SET search_path=''/);
  }
});

test("PostgreSQL 17 temporary membership is explicit and revoked grantor-specifically", () => {
  assert.match(v2, /GRANT resources_cms_command_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres/);
  assert.match(v2, /REVOKE resources_cms_command_owner FROM postgres GRANTED BY postgres RESTRICT/);
  assert.match(v2, /g\.rolname='supabase_admin' AND a\.admin_option AND NOT a\.inherit_option AND NOT a\.set_option/);
  assert.match(v2, /pg_has_role\('postgres','resources_cms_command_owner','SET'\)/);
});

test("Data API receives only allowlisted RPCs and the direct runtime is retired", () => {
  assert.doesNotMatch(v1 + v2, /GRANT\s+(?:INSERT|UPDATE|DELETE|ALL)[^;]*\bTO resources_cms_runtime/i);
  assert.match(v2, /REVOKE ALL ON ALL FUNCTIONS IN SCHEMA resources_cms FROM PUBLIC,anon,authenticated,resources_cms_runtime/);
  assert.match(v2, /REVOKE USAGE ON SCHEMA resources_cms FROM resources_cms_runtime/);
  assert.match(v2, /GRANT EXECUTE ON FUNCTION resources_cms\.dispatch[\s\S]*TO authenticated/);
  assert.doesNotMatch(v2, /GRANT EXECUTE[^;]*publish_due[^;]*TO (?:anon|authenticated|resources_cms_runtime)/i);
  for (const name of ["dispatch", "taxonomy_command", "media_command", "settings_command", "bulk_archive", "publish_due", "public_article", "public_index", "public_media", "public_redirect", "query"]) {
    assert.match(v2, new RegExp(`ALTER FUNCTION resources_cms\\.${name.replace("_", "_")}\\(`));
  }
});

test("actor identity is JWT-bound and never trusts a caller-supplied CMS GUC", () => {
  assert.match(v2, /request\.jwt\.claims/);
  assert.match(v2, /->>'role'='authenticated'/);
  assert.doesNotMatch(v2, /resources_cms\.actor_id/);
});

test("Storage migration is private, bucket-scoped and excludes PDFs", () => {
  assert.match(storage, /'resources-cms-media','resources-cms-media',false,4194304,ARRAY\['image\/webp'\]/);
  assert.doesNotMatch(storage, /application\/pdf|public\s*,?\s*true/i);
  assert.equal((storage.match(/bucket_id='resources-cms-media'/g) || []).length, 4);
});
