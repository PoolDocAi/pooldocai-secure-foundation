import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { PostgresCMS } from "../src/production/postgres.mjs";
import { createProductionApp } from "../src/production/app.mjs";

const owner = "00000000-0000-4000-8000-000000000001", category = "00000000-0000-4000-8000-000000000002";
const localize = (sql) => sql
  .replace("session_user='authenticator' AND ", "") // Auth transport emulation; full guard tested separately.
  .replace(/DO \$guard\$ BEGIN\n IF current_user<>'postgres'[\s\S]*?END \$guard\$;\n/, "")
  .replace(/-- This is a second, grantor-specific row\.[\s\S]*?END \$guard\$;\n/, "")
  .replace(/-- Remove only the temporary row granted by postgres\.[\s\S]*?END \$guard\$;\n/, "");

test("production HTTP app executes editorial workflow through PostgreSQL adapter", { timeout: 30_000 }, async () => {
  const pg = new PGlite();
  await pg.exec("CREATE ROLE anon; CREATE ROLE authenticated;");
  await pg.exec(readFileSync("supabase/migrations/20261026035555_resources_cms_isolated_v1.sql", "utf8"));
  await pg.exec(localize(readFileSync("supabase/migrations/20261026042156_resources_cms_commands_v2.sql", "utf8")));
  await pg.exec(`INSERT INTO resources_cms.members VALUES('${owner}','owner',true); INSERT INTO resources_cms.taxonomy(id,kind,name) VALUES('${category}','category','How-To Guides'); SET ROLE authenticated;`);
  const pool = { connect: async () => ({ query: (...args) => pg.query(...args), release() {} }) };
  const db = new PostgresCMS(pool);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/auth/v1/token") return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
    if (path === "/auth/v1/user") return Response.json({ id: owner, email: "owner@example.test" });
    return new Response(null, { status: 404 });
  };
  try {
    const app = createProductionApp({ config: { supabaseUrl: "https://example.supabase.co", publishableKey: "public", origin: "https://cms.example", cronSecret: "cron", schedulerActorId: owner }, db });
    const login = await app(new Request("https://cms.example/api/login", { method: "POST", headers: { origin: "https://cms.example" }, body: JSON.stringify({ email: "owner@example.test", password: "test" }) }));
    assert.equal(login.status, 200);
    const session = await login.json(), cookie = login.headers.getSetCookie().map((item) => item.split(";", 1)[0]).join("; ");
    const call = async (path, method = "GET", value) => app(new Request(`https://cms.example${path}`, { method, headers: { origin: "https://cms.example", cookie, ...(method !== "GET" ? { "x-csrf-token": session.csrf, "content-type": "application/json" } : {}) }, ...(value ? { body: JSON.stringify(value) } : {}) }));
    const upload = await call('/api/article-upload','POST',{name:'synthetic.md',categoryId:category,base64:Buffer.from('# Private synthetic upload\n\nTODO: repair at 20 psi.').toString('base64')});
    assert.equal(upload.status,201);
    const intake = await upload.json();
    assert.equal(intake.article.status,'draft');
    assert.equal((await call(`/api/content/${intake.article.id}/automated-review`,'POST',{version:intake.article.version})).status,200);
    assert.equal((await app(new Request(`https://cms.example/resources/${intake.article.data.slug}/`))).status,404);
    assert.equal((await db.publicIndex()).some(item=>item.article_id===intake.article.id),false);
    await pg.exec('RESET ROLE');
    assert.equal((await pg.query('SELECT count(*)::int n FROM resources_cms.knowledge_grants')).rows[0].n,0);
    await pg.exec('SET ROLE authenticated');
    const payload = { title: "Production path draft", slug: "production-path-draft", summary: "Safe summary", body: "<p>Safe body</p>", categoryId: category, tagIds: [], audience: "homeowners", author: "PoolDocAI", sources: [{ label: "Manual", url: "https://example.com/manual" }], seo: { title: "Production path draft", description: "Safe summary" } };
    let response = await call("/api/content", "POST", payload);
    assert.equal(response.status, 201);
    let article = await response.json();
    for (const action of ["review", "approve", "publish"]) {
      if(action==='publish') {
        await pg.exec('RESET ROLE');
        await pg.query("INSERT INTO resources_cms.publication_authorizations(article_id,revision_id,capability,authorized_by,approval_reference) SELECT id,working_revision_id,'publish',$1,'synthetic-local-authorization' FROM resources_cms.articles WHERE id=$2",[owner,article.id]);
        await pg.exec('SET ROLE authenticated');
      }
      response = await call(`/api/content/${article.id}/${action}`, "POST", { version: article.version });
      assert.equal(response.status, 200);
      article = await response.json();
    }
    assert.equal(article.status, "published");
    assert.equal(article.knowledge.status, "not_submitted");
    const directPublished = await db.publicArticle("production-path-draft");
    assert.ok(directPublished, JSON.stringify(await db.publicIndex()));
    const publicPage = await app(new Request("https://cms.example/resources/production-path-draft/"));
    assert.equal(publicPage.status, 200);
    assert.match(await publicPage.text(), /Safe body/);
    response = await call(`/api/content/${article.id}/unpublish`, "POST", { version: article.version });
    assert.equal(response.status, 200);
    assert.equal((await app(new Request("https://cms.example/resources/production-path-draft/"))).status, 404);
  } finally {
    globalThis.fetch = originalFetch;
    await pg.close();
  }
});
