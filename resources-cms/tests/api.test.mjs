import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCMS } from "../server.mjs";
import { passwordHash, uid, now, revision } from "../src/store.mjs";
import sharp from "sharp";
const dir = mkdtempSync(join(tmpdir(), "pooldoc-cms-test-")),
  origin = "http://127.0.0.1:4197";
let cms, owner, editor, reviewer, viewer;
function user(role) {
  const id = uid();
  cms.db
    .prepare("INSERT INTO users VALUES(?,?,?,?,1)")
    .run(
      id,
      role + "@example.test",
      passwordHash("local-test-password-2026"),
      role,
    );
  return id;
}
async function request(
  path,
  { method = "GET", body, session, headers = {} } = {},
) {
  const r = await fetch(origin + path, {
    method,
    redirect: "manual",
    headers: {
      ...(session
        ? { Cookie: session.cookie, "X-CSRF-Token": session.csrf }
        : {}),
      Origin: origin,
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: r.status, data, text, headers: r.headers };
}
async function login(role) {
  const r = await request("/api/login", {
    method: "POST",
    body: {
      email: role + "@example.test",
      password: "local-test-password-2026",
    },
  });
  assert.equal(r.status, 200, r.text);
  assert.match(r.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  return {
    cookie: r.headers.get("set-cookie").split(";")[0],
    csrf: r.data.csrf,
  };
}
const draft = (slug = "test-" + uid().slice(0, 8)) => ({
  title: "A carefully reviewed resource",
  slug,
  summary: "A concise useful summary.",
  body: '<h2 id="checks">Safe first checks</h2><p>Observe the controller from a safe dry position.</p>',
  categoryId: "category-3",
  tagIds: ["tag-1"],
  sources: [
    {
      label: "Original manufacturer manual",
      url: "https://www.pentair.com/manual.pdf",
    },
    {
      label: "Technician verification record",
      url: "https://pooldocai.com/verification/test-record/",
    },
  ],
  seo: {
    title: "Safe pool checks",
    description: "Practical first checks for your swimming pool equipment.",
  },
  audience: "homeowners",
});
async function create(data = draft(), session = owner) {
  const r = await request("/api/content", {
    method: "POST",
    body: data,
    session,
  });
  assert.equal(r.status, 201, r.text);
  return r.data;
}
async function action(r, a, body = {}, session = owner) {
  return request(`/api/content/${r.id}/${a}`, {
    method: "POST",
    body: { version: r.version, ...body },
    session,
  });
}
async function published(data = draft()) {
  let r = await create(data);
  let x = await action(r, "review");
  assert.equal(x.status, 200, x.text);
  r = x.data;
  x = await action(r, "approve");
  assert.equal(x.status, 200, x.text);
  r = x.data;
  x = await action(r, "publish");
  assert.equal(x.status, 200, x.text);
  return x.data;
}
before(async () => {
  cms = createCMS({
    dbPath: join(dir, "cms.sqlite"),
    mediaPath: join(dir, "media"),
    origin,
    testMode: true,
  });
  for (const role of ["owner", "editor", "reviewer", "viewer"]) user(role);
  await new Promise((r) => cms.server.listen(4197, "127.0.0.1", r));
  owner = await login("owner");
  editor = await login("editor");
  reviewer = await login("reviewer");
  viewer = await login("viewer");
});
after(async () => {
  await new Promise((r) => cms.server.close(r));
  rmSync(dir, { recursive: true, force: true });
});
test("unauthorized admin/API/preview/export rejection and private no-store headers", async () => {
  assert.equal((await request("/admin/")).status, 303);
  for (const p of [
    "/api/content",
    "/api/export",
    "/api/knowledge/export",
    "/api/company_manuals",
    "/preview/" + uid(),
  ]) {
    const r = await request(p);
    assert.equal(r.status, 401, p);
    assert.equal(r.headers.get("cache-control"), "no-store");
  }
  assert.equal((await request("/data/cms.sqlite")).status, 404);
  assert.equal((await request("/public/admin.html")).status, 404);
});
test("owner login, invalid login, session identity and server-side role restrictions", async () => {
  assert.equal(
    (await request("/api/me", { session: owner })).data.role,
    "owner",
  );
  assert.equal(
    (
      await request("/api/login", {
        method: "POST",
        body: { email: "bad@example.test", password: "bad" },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/api/content", {
        method: "POST",
        body: draft(),
        session: viewer,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/taxonomy", {
        method: "POST",
        body: { kind: "tag", name: "Forbidden" },
        session: editor,
      })
    ).status,
    403,
  );
});
test("CSRF and hostile origins rejected", async () => {
  assert.equal(
    (
      await request("/api/content", {
        method: "POST",
        body: draft(),
        session: owner,
        headers: { "X-CSRF-Token": "bad" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/api/content", {
        method: "POST",
        body: draft(),
        session: owner,
        headers: { Origin: "https://evil.test" },
      })
    ).status,
    403,
  );
});
test("draft create/edit/persist/preview and optimistic concurrency", async () => {
  let r = await create();
  assert.equal(r.status, "draft");
  assert.equal((await request(`/resources/${r.slug}/`)).status, 404);
  assert.equal(
    (
      await request("/api/knowledge/export", { session: owner })
    ).data.records.some((x) => x.articleId === r.id),
    false,
  );
  const p = await request("/preview/" + r.id, { session: owner });
  assert.equal(p.status, 200);
  assert.match(p.text, /noindex/);
  assert.match(p.text, /Safe first checks/);
  const save = await request("/api/content/" + r.id, {
    method: "PUT",
    body: { ...r.data, summary: "Saved draft content", version: r.version },
    session: owner,
  });
  assert.equal(save.status, 200, save.text);
  assert.equal(
    (await request("/api/content/" + r.id, { session: owner })).data.data
      .summary,
    "Saved draft content",
  );
  assert.equal(
    (
      await request("/api/content/" + r.id, {
        method: "PUT",
        body: { ...r.data, version: r.version },
        session: owner,
      })
    ).status,
    409,
  );
});
test("publishing requires separate editorial approval; editor cannot approve or publish", async () => {
  let r = await create();
  assert.equal((await action(r, "publish")).status, 409);
  assert.equal((await action(r, "approve", {}, editor)).status, 403);
  assert.equal((await action(r, "publish", {}, editor)).status, 403);
  r = (await action(r, "review")).data;
  r = (await action(r, "approve", {}, reviewer)).data;
  r = (await action(r, "publish")).data;
  assert.equal(r.status, "published");
  assert.equal(r.knowledge.status, "not_submitted");
  assert.equal((await request(`/resources/${r.slug}/`)).status, 200);
  assert.equal(
    (
      await request("/api/knowledge/export", { session: owner })
    ).data.records.some((x) => x.articleId === r.id),
    false,
  );
});
test("published snapshot stable while editing, unpublish removes public page", async () => {
  let r = await published();
  const before = await request(`/resources/${r.slug}/`);
  r = (
    await request("/api/content/" + r.id, {
      method: "PUT",
      body: {
        ...r.data,
        body: "<h2>Unpublished replacement</h2>",
        version: r.version,
      },
      session: owner,
    })
  ).data;
  assert.equal(r.status, "draft");
  assert.equal((await request(`/resources/${r.slug}/`)).text, before.text);
  assert.equal((await action(r, "publish")).status, 409);
  r = (await action(r, "unpublish")).data;
  assert.equal((await request(`/resources/${r.slug}/`)).status, 404);
  assert.equal(r.published, false);
});
test("archive, recoverable delete and restore never republish", async () => {
  let r = await published();
  r = (await action(r, "archive")).data;
  assert.equal((await request(`/resources/${r.slug}/`)).status, 410);
  r = (await action(r, "delete")).data;
  assert.equal(r.status, "deleted");
  r = (await action(r, "restore")).data;
  assert.equal(r.status, "draft");
  assert.equal(r.published, false);
  assert.equal((await request(`/resources/${r.slug}/`)).status, 404);
});
test("revision rollback creates immutable new draft snapshot", async () => {
  let r = await create();
  const history = (
    await request(`/api/content/${r.id}/revisions`, { session: owner })
  ).data;
  r = (
    await request("/api/content/" + r.id, {
      method: "PUT",
      body: { ...r.data, title: "Changed title", version: r.version },
      session: owner,
    })
  ).data;
  const out = await action(r, "rollback", { revisionId: history[0].id });
  assert.equal(out.status, 200, out.text);
  assert.equal(out.data.data.title, "A carefully reviewed resource");
  assert.equal(out.data.version, 3);
  assert.throws(
    () =>
      cms.db
        .prepare("UPDATE revisions SET reason=? WHERE id=?")
        .run("tamper", history[0].id),
    /immutable/,
  );
});
test("category reassignment and topic filters preserve article slug", async () => {
  let r = await create();
  const slug = r.slug;
  r = (
    await request("/api/content/" + r.id, {
      method: "PUT",
      body: {
        ...r.data,
        categoryId: "category-2",
        tagIds: ["tag-5"],
        version: r.version,
      },
      session: owner,
    })
  ).data;
  assert.equal(r.data.categoryId, "category-2");
  assert.equal(r.slug, slug);
  const live = await published({
    ...draft(),
    categoryId: "category-2",
    tagIds: ["tag-5"],
  });
  assert.match(
    (await request("/resources/?tag=tag-5")).text,
    new RegExp(live.data.slug),
  );
  assert.doesNotMatch(
    (await request("/resources/?tag=tag-2")).text,
    new RegExp(live.data.slug),
  );
});
test("taxonomy create/rename/reorder/merge/archive restrictions", async () => {
  const c = await request("/api/taxonomy", {
    method: "POST",
    body: { kind: "category", name: "Special reports" },
    session: owner,
  });
  assert.equal(c.status, 201);
  const id = c.data.id;
  assert.equal(
    (
      await request("/api/taxonomy/" + id, {
        method: "PUT",
        body: { name: "Research reports", position: 1 },
        session: owner,
      })
    ).status,
    200,
  );
  let r = await published({ ...draft(), categoryId: id });
  assert.equal(
    (
      await request("/api/taxonomy/" + id, {
        method: "PUT",
        body: { archived: true },
        session: owner,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request("/api/taxonomy/" + id, {
        method: "PUT",
        body: { mergeInto: "category-1" },
        session: owner,
      })
    ).status,
    200,
  );
  assert.equal(
    (await request("/api/content/" + r.id, { session: owner })).data.data
      .categoryId,
    "category-1",
  );
  assert.equal((await request(`/resources/${r.slug}/`)).status, 200);
});
test("duplicate slug and historical redirect collision rejection", async () => {
  let r = await published();
  assert.equal(
    (
      await request("/api/content", {
        method: "POST",
        body: draft(r.slug),
        session: owner,
      })
    ).status,
    409,
  );
  const old = r.slug;
  r = (
    await request("/api/content/" + r.id, {
      method: "PUT",
      body: {
        ...r.data,
        slug: "renamed-" + uid().slice(0, 8),
        version: r.version,
      },
      session: owner,
    })
  ).data;
  r = (await action(r, "review")).data;
  r = (await action(r, "approve")).data;
  r = (await action(r, "publish")).data;
  const redirect = await request(`/resources/${old}/`);
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("location"), `/resources/${r.slug}/`);
  assert.equal(
    (
      await request("/api/content", {
        method: "POST",
        body: draft(old),
        session: owner,
      })
    ).status,
    409,
  );
  const xml = (await request("/sitemap.xml")).text;
  assert.ok(xml.includes(`/resources/${r.slug}/`));
  assert.ok(!xml.includes(`/resources/${old}/`));
});
test("public HTML, structured data, canonical, metadata, noindex exclusion", async () => {
  const r = await published();
  const html = (await request(`/resources/${r.slug}/`)).text;
  assert.match(html, /<h1>A carefully reviewed resource<\/h1>/);
  assert.match(html, /application\/ld\+json/);
  assert.match(html, /rel="canonical"/);
  assert.match(html, /og:title/);
  assert.match(html, /datePublished/);
  assert.match((await request("/sitemap.xml")).text, new RegExp(r.slug));
  const noindex = await published({
    ...draft(),
    seo: {
      title: "Unlisted title",
      description: "Useful description",
      noindex: true,
    },
  });
  assert.ok(!(await request("/sitemap.xml")).text.includes(noindex.slug));
});
test("server XSS sanitization including encoded URL and malformed markup", async () => {
  const r = await create({
    ...draft(),
    body: '<h2>Safe title</h2><script>alert(1)</script><img src="x" onerror="alert(1)"><a href="jav&#x61;script:alert(1)">bad</a><svg onload=alert(1)><script>alert(1)</script></svg><iframe srcdoc="x"></iframe><p style="background:url(javascript:x)">safe</p>',
  });
  assert.doesNotMatch(
    r.data.body,
    /onerror|onload|javascript:|<script|<svg|<iframe|style=/,
  );
  assert.match(r.data.body, /Safe title/);
});
test("media signature/format/size validation, private draft files, image canonicalization and publication", async () => {
  assert.equal(
    (
      await request("/api/media", {
        method: "POST",
        body: {
          name: "malicious.svg",
          mime: "image/svg+xml",
          base64: Buffer.from('<svg onload="alert(1)"></svg>').toString(
            "base64",
          ),
        },
        session: owner,
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await request("/api/media", {
        method: "POST",
        body: {
          name: "fake.png",
          mime: "image/png",
          base64: Buffer.from("not an image").toString("base64"),
        },
        session: owner,
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await request("/api/media", {
        method: "POST",
        body: {
          name: "active.pdf",
          mime: "application/pdf",
          base64: Buffer.from(
            "%PDF-1.7\n/JavaScript /OpenAction\n%%EOF",
          ).toString("base64"),
        },
        session: owner,
      })
    ).status,
    415,
  );
  const image = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "green" },
  })
    .png()
    .toBuffer();
  const upload = await request("/api/media", {
    method: "POST",
    body: {
      name: "pool.png",
      mime: "image/png",
      alt: "A green pool illustration",
      base64: image.toString("base64"),
    },
    session: owner,
  });
  assert.equal(upload.status, 201, upload.text);
  assert.equal(upload.data.mime, "image/webp");
  assert.equal((await request(upload.data.url)).status, 401);
  assert.equal(
    (await request(upload.data.url, { session: owner })).status,
    200,
  );
  const r = await published({
    ...draft(),
    body: `<h2>Image</h2><p>Useful text</p><img src="${upload.data.url}" alt="A green pool illustration">`,
  });
  assert.equal((await request(upload.data.url)).status, 200);
  await action(r, "archive");
  assert.equal((await request(upload.data.url)).status, 401);
});
test("imports ignore publication/knowledge claims, preserve citations, validate required fields", async () => {
  const r = await request("/api/import", {
    method: "POST",
    session: owner,
    body: {
      format: "pooldocai-resource-v1",
      article: {
        ...draft(),
        status: "published",
        knowledge: {
          status: "approved",
          classification: "verified_repair_procedure",
        },
      },
    },
  });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.data.status, "draft");
  assert.equal(r.data.knowledge.status, "not_submitted");
  assert.equal(r.data.data.sources.length, 2);
  assert.equal(
    (
      await request("/api/import", {
        method: "POST",
        body: {
          format: "pooldocai-resource-v1",
          article: { title: "Incomplete" },
        },
        session: owner,
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await request("/api/import", {
        method: "POST",
        body: { format: "wrong", article: draft() },
        session: owner,
      })
    ).status,
    422,
  );
});
test("knowledge approval separate, unauthorized editor blocked, evidence required and export revision identity", async () => {
  let r = await published();
  assert.equal(
    (
      await action(
        r,
        "knowledge-approve",
        { classification: "general_education", evidence: [] },
        editor,
      )
    ).status,
    403,
  );
  r = (await action(r, "knowledge-submit")).data;
  assert.equal(
    (
      await action(r, "knowledge-approve", {
        classification: "verified_repair_procedure",
        humanVerified: true,
        evidence: [],
      })
    ).status,
    422,
  );
  const x = await action(
    r,
    "knowledge-approve",
    {
      classification: "general_education",
      evidence: [
        {
          url: r.data.sources[0].url,
          type: "manufacturer",
          excerpt: "Source provides safe observation context",
        },
      ],
    },
    reviewer,
  );
  assert.equal(x.status, 200, x.text);
  r = x.data;
  const out = (await request("/api/knowledge/export", { session: owner })).data;
  const record = out.records.find((x) => x.articleId === r.id);
  assert.ok(record);
  assert.equal(record.revisionId, r.knowledge.revision_id);
  assert.equal(record.approvalStatus, "approved");
  assert.equal(record.ingestionStatus, "not_connected");
  assert.notEqual(record.articleCitation.url, record.originalSources[0].url);
  assert.equal(out.embedding.enabled, false);
  assert.equal(out.events.find((x) => x.article_id === r.id).status, "pending");
});
test("knowledge edits/revoke/archive/restore fail closed and outbox audit transaction rolls back on error", async () => {
  async function approved() {
    let r = await published();
    r = (await action(r, "knowledge-submit")).data;
    return (
      await action(r, "knowledge-approve", {
        classification: "homeowner_safe_observation",
        evidence: [
          {
            url: r.data.sources[0].url,
            type: "manufacturer",
            excerpt: "Observe without opening equipment",
          },
        ],
      })
    ).data;
  }
  let r = await approved();
  const revisionId = r.knowledge.revision_id;
  r = (
    await request("/api/content/" + r.id, {
      method: "PUT",
      body: {
        ...r.data,
        body: "<h2>Materially changed technique</h2>",
        version: r.version,
      },
      session: owner,
    })
  ).data;
  assert.equal(r.knowledge.status, "revoked");
  assert.ok(
    !(
      await request("/api/knowledge/export", { session: owner })
    ).data.records.some((x) => x.articleId === r.id),
  );
  assert.equal(
    (
      await request("/api/knowledge/eligibility?revisionId=" + revisionId, {
        session: owner,
      })
    ).data.eligible,
    false,
  );
  r = await approved();
  const rev = r.knowledge.revision_id;
  r = (await action(r, "knowledge-revoke")).data;
  assert.equal(r.knowledge.status, "revoked");
  const events = cms.db
    .prepare(
      "SELECT * FROM knowledge_outbox WHERE article_id=? AND event='revoke'",
    )
    .all(r.id);
  assert.equal(events.length, 1);
  r = (await action(r, "knowledge-revoke")).data;
  assert.equal(
    cms.db
      .prepare(
        "SELECT count(*) AS n FROM knowledge_outbox WHERE article_id=? AND event='revoke'",
      )
      .get(r.id).n,
    1,
  );
  r = (await action(r, "archive")).data;
  r = (await action(r, "restore")).data;
  assert.equal(r.knowledge.status, "revoked");
  assert.equal(
    (
      await request("/api/knowledge/eligibility?revisionId=" + rev, {
        session: owner,
      })
    ).data.eligible,
    false,
  );
  r = await approved();
  cms.db.exec(
    "CREATE TEMP TRIGGER fail_test BEFORE INSERT ON knowledge_outbox WHEN NEW.event='revoke' BEGIN SELECT RAISE(ABORT,'test outbox failure'); END;",
  );
  const failed = await request("/api/content/" + r.id, {
    method: "PUT",
    body: { ...r.data, title: "Will not commit", version: r.version },
    session: owner,
  });
  assert.ok(failed.status >= 400);
  const unchanged = (await request("/api/content/" + r.id, { session: owner }))
    .data;
  assert.equal(unchanged.version, r.version);
  assert.equal(unchanged.knowledge.status, "approved");
  cms.db.exec("DROP TRIGGER fail_test");
});
test("scheduled publication is durable, requires approval and executes once", async () => {
  let r = await create();
  assert.equal(
    (
      await action(r, "schedule", {
        scheduledAt: new Date(Date.now() + 20000).toISOString(),
      })
    ).status,
    409,
  );
  r = (await action(r, "review")).data;
  r = (await action(r, "approve")).data;
  r = (
    await action(r, "schedule", {
      scheduledAt: new Date(Date.now() + 1000).toISOString(),
    })
  ).data;
  assert.equal(r.status, "scheduled");
  assert.equal((await request(`/resources/${r.slug}/`)).status, 404);
  await new Promise((r) => setTimeout(r, 1300));
  cms.runScheduled();
  const result = (await request("/api/content/" + r.id, { session: owner }))
    .data;
  assert.equal(result.status, "published");
  cms.runScheduled();
  assert.equal(
    (await request("/api/content/" + r.id, { session: owner })).data.version,
    result.version,
  );
});
test("CMS has no tenant data endpoints or privileged core credentials", async () => {
  for (const p of [
    "/api/company_manuals",
    "/api/diagnostic_cases",
    "/api/learning_review_queue",
  ])
    assert.equal((await request(p, { session: owner })).status, 404);
  const source = readFileSync(
    new URL("../server.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /SUPABASE_SERVICE_ROLE_KEY|owfeebydlyacssqpnmkq/);
});
test("existing URLs imported without HTML/content/citation changes; marketing regression hashes", async () => {
  const originals = JSON.parse(
    readFileSync(
      new URL("../examples/existing-resources.json", import.meta.url),
      "utf8",
    ),
  );
  for (const d of originals) {
    const id = uid(),
      time = now();
    cms.db
      .prepare(
        "INSERT INTO articles(id,slug,status,data,published,version,created_at,updated_at) VALUES(?,?,'published',?,?,1,?,?)",
      )
      .run(id, d.slug, JSON.stringify(d), JSON.stringify(d), time, time);
    revision(
      cms.db,
      cms.db.prepare("SELECT * FROM articles WHERE id=?").get(id),
      null,
      "migration_test",
    );
    assert.equal(
      (await request(`/resources/${d.slug}/`)).text,
      readFileSync(
        new URL(`../evidence/live/${d.slug}.html`, import.meta.url),
        "utf8",
      ),
    );
  }
  for (const [route, file] of [
    ["/", "index.html"],
    ["/app.js", "app.js"],
    ["/consent.js", "consent.js"],
    ["/style.css", "style.css"],
    ["/llms.txt", "llms.txt"],
  ])
    assert.equal(
      (await request(route)).text,
      readFileSync(
        new URL("../evidence/live/" + file, import.meta.url),
        "utf8",
      ),
    );
  assert.match((await request("/")).text, /mrpppgkw/);
  assert.match((await request("/consent.js")).text, /G-6B7W7NBC1Y/);
  assert.match((await request("/consent.js")).text, /2146378225963533/);
});
test("safe bulk archive is atomic, version checked and owner-only", async () => {
  const a = await published(),
    b = await published();
  const items = [a, b].map((r) => ({ id: r.id, version: r.version }));
  assert.equal(
    (
      await request("/api/bulk/archive", {
        method: "POST",
        body: { items },
        session: editor,
      })
    ).status,
    403,
  );
  const failed = await request("/api/bulk/archive", {
    method: "POST",
    body: { items: [items[0], { ...items[1], version: 0 }] },
    session: owner,
  });
  assert.equal(failed.status, 409);
  assert.equal(
    (await request("/api/content/" + a.id, { session: owner })).data.status,
    "published",
  );
  assert.equal(
    (
      await request("/api/bulk/archive", {
        method: "POST",
        body: { items },
        session: owner,
      })
    ).status,
    200,
  );
  assert.equal((await request(`/resources/${a.slug}/`)).status, 410);
  assert.equal((await request(`/resources/${b.slug}/`)).status, 410);
});

test('logical export omits authentication secrets and binary backup restores exact database state', async () => {
  const exported = await request('/api/export', {session: owner});
  assert.equal(exported.status, 200);
  assert.ok(exported.data.articles.length > 0 && exported.data.revisions.length > 0);
  assert.equal(exported.data.users, undefined);
  assert.equal(exported.data.sessions, undefined);
  const {spawnSync} = await import('node:child_process');
  const out = spawnSync(process.execPath, ['scripts/backup.mjs'], {cwd: new URL('..', import.meta.url), env: {...process.env, CMS_DB: join(dir,'cms.sqlite'), CMS_MEDIA:join(dir,'media'), CMS_BACKUP_DEST:join(dir,'backup')}, encoding:'utf8'});
  assert.equal(out.status, 0, out.stderr);
  const {DatabaseSync} = await import('node:sqlite');
  const restored = new DatabaseSync(join(dir,'backup/cms.sqlite'));
  assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  for(const table of ['articles','revisions','audit','knowledge_reviews','knowledge_outbox','media']) assert.equal(restored.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, cms.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
  const media = cms.db.prepare('SELECT id FROM media').all();
  for(const m of media) assert.deepEqual(readFileSync(join(dir,'media',m.id)),readFileSync(join(dir,'backup/media',m.id)));
  restored.close();
});

test('migrated social metadata survives editing and self-canonical updates on slug publication', async () => {
  const original=JSON.parse(readFileSync(new URL('../examples/existing-resources.json',import.meta.url),'utf8'))[0];
  assert.equal(original.seo.image,'/assets/day-1536.webp');
  const slug='canonical-old-'+uid().slice(0,8);
  let r=await published({...draft(slug),seo:{...original.seo,canonical:'https://pooldocai.com/resources/'+slug+'/'}});
  let html=(await request('/resources/'+slug+'/')).text;
  assert.ok(html.includes('https://pooldocai.com/assets/day-1536.webp'));
  assert.ok(html.includes('Sunlit swimming pool beside a modern home'));
  const newSlug='canonical-new-'+uid().slice(0,8);
  r=(await request('/api/content/'+r.id,{method:'PUT',body:{...r.data,slug:newSlug,version:r.version},session:owner})).data;
  r=(await action(r,'review')).data;r=(await action(r,'approve')).data;r=(await action(r,'publish')).data;
  assert.equal(r.data.seo.canonical,'https://pooldocai.com/resources/'+newSlug+'/');
  assert.match((await request('/resources/'+newSlug+'/')).text,new RegExp('rel="canonical" href="https://pooldocai.com/resources/'+newSlug+'/"'));
});

test('pending knowledge withdrawal emits no incomplete event and reapproval cannot revive an old approval UUID', async()=>{
 let r=await published();r=(await action(r,'knowledge-submit')).data;
 r=(await request('/api/content/'+r.id,{method:'PUT',body:{...r.data,summary:'An updated summary',version:r.version},session:owner})).data;
 assert.equal(cms.db.prepare('SELECT count(*) AS n FROM knowledge_outbox WHERE article_id=?').get(r.id).n,0);
 r=(await action(r,'review')).data;r=(await action(r,'approve')).data;r=(await action(r,'publish')).data;
 const evidence=[{url:r.data.sources[0].url,type:'manufacturer',excerpt:'Observation source reviewed'}];
 r=(await action(r,'knowledge-submit')).data;r=(await action(r,'knowledge-approve',{classification:'general_education',evidence})).data;
 const old=r.knowledge.approval_id,revisionId=r.knowledge.revision_id;
 r=(await action(r,'knowledge-revoke')).data;r=(await action(r,'knowledge-submit')).data;r=(await action(r,'knowledge-approve',{classification:'general_education',evidence})).data;
 assert.notEqual(r.knowledge.approval_id,old);
 assert.equal((await request(`/api/knowledge/eligibility?revisionId=${revisionId}&approvalId=${old}`,{session:owner})).data.eligible,false);
 assert.equal((await request(`/api/knowledge/eligibility?revisionId=${revisionId}&approvalId=${r.knowledge.approval_id}`,{session:owner})).data.eligible,true);
 assert.equal(cms.db.prepare("SELECT count(*) AS n FROM knowledge_outbox WHERE article_id=? AND event='upsert'").get(r.id).n,2);
});
