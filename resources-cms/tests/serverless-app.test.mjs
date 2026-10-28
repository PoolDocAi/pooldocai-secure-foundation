import { test } from "node:test";
import assert from "node:assert/strict";
import { createProductionApp } from "../src/production/app.mjs";

const published = {
  slug: "safe-guide", state: "published", publishedAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z",
  categoryName: "How-To Guides", renderedHtml: "<p>Published body</p>", sources: [],
  content: { title: "Safe guide", slug: "safe-guide", summary: "Summary", body: "<p>Published body</p>", author: "PoolDocAI", seo: { title: "Safe guide", description: "Summary" } },
};
function app(overrides = {}) {
  const db = {
    publicIndex: async () => [{ article_id: "1", slug: "safe-guide", category_name: "How-To Guides", content: published.content, rendered_html: published.renderedHtml, updated_at: published.updatedAt }],
    publicArticle: async (slug) => slug === "safe-guide" ? published : null,
    redirect: async (slug) => slug === "old-safe-guide" ? "safe-guide" : null,
    ...overrides,
  };
  return createProductionApp({
    config: { supabaseUrl: "https://example.supabase.co", publishableKey: "public", origin: "https://cms.example", cronSecret: "cron", schedulerActorId: "00000000-0000-4000-8000-000000000001" },
    db,
  });
}

test("serverless public routes render crawlable HTML and never expose missing drafts", async () => {
  const route = app();
  const article = await route(new Request("https://cms.example/resources/safe-guide/"));
  assert.equal(article.status, 200);
  const html = await article.text();
  assert.match(html, /Published body/);
  assert.match(html, /application\/ld\+json/);
  assert.match(html, /canonical/);
  assert.equal((await route(new Request("https://cms.example/resources/private-draft/"))).status, 404);
  const preview = await route(new Request("https://cms.example/preview/00000000-0000-4000-8000-000000000002"));
  assert.equal(preview.status, 401);
  assert.equal((await route(new Request("https://cms.example/preview-assets/resource-17/workflow.svg"))).status, 401);
});

test("serverless editorial diagram alternatives require verified CMS membership", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ id: "00000000-0000-4000-8000-000000000001", email: "owner@example.test" });
  try {
    const route = app({
      transaction: async (_actor, callback) => callback({ query: async () => ({ rows: [{ role: "owner" }] }) }),
    });
    for (const [path, mime] of [["workflow.svg", "image/svg+xml"], ["workflow.png", "image/png"], ["workflow.pdf", "application/pdf"]]) {
      const response = await route(new Request(`https://cms.example/preview-assets/resource-17/${path}`, { headers: { cookie: "__Host-pooldocai-cms-access=verified-token" } }));
      assert.ok([200, 503].includes(response.status), "verified editor must get the private asset or a missing-asset error, never a fake 401");
      if (response.status === 200) assert.match(response.headers.get("content-type"), new RegExp(mime.replace("+", "\\+")));
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.match(response.headers.get("x-robots-tag"), /noindex/);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test("serverless hub, sitemap, redirects and health are deterministic", async () => {
  const route = app();
  assert.match(await (await route(new Request("https://cms.example/resources/"))).text(), /Safe guide/);
  const sitemap = await route(new Request("https://cms.example/resources-sitemap.xml"));
  assert.equal(sitemap.headers.get("content-type"), "application/xml; charset=utf-8");
  assert.match(await sitemap.text(), /safe-guide/);
  const redirect = await route(new Request("https://cms.example/resources/old-safe-guide/"));
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("location"), "/resources/safe-guide/");
  assert.equal((await route(new Request("https://cms.example/api/health/resources"))).status, 200);
  const admin = await route(new Request("https://cms.example/admin/"));
  assert.equal(admin.status, 302);
  assert.equal(admin.headers.get("location"), "/admin/login");
});

test("verified ordinary Supabase user without CMS membership is denied", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ id: "00000000-0000-4000-8000-000000000099", email: "ordinary@example.test" });
  try {
    const route = app({
      transaction: async (_actor, fn) => fn({ query: async () => ({ rows: [] }) }),
    });
    const response = await route(new Request("https://cms.example/api/me", { headers: { cookie: "__Host-pooldocai-cms-access=verified-token" } }));
    assert.equal(response.status, 403);
  } finally { globalThis.fetch = originalFetch; }
});
