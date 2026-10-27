import { test } from "node:test";
import assert from "node:assert/strict";
import { PostgresCMS } from "../src/production/postgres.mjs";
import { SupabaseDataCMS } from "../src/production/supabase-data.mjs";
import {
  ACCESS_COOKIE,
  CSRF_COOKIE,
  parseCookies,
  requireCsrf,
  sessionCookies,
  verifiedIdentity,
} from "../src/production/auth.mjs";
import {
  MAX_IMAGE_BYTES,
  mediaGateway,
  mediaObjectKey,
  safeMediaName,
  validatedImage,
} from "../src/production/storage.mjs";
import { commandRoute, loginRoute, refreshRoute, scheduleRoute } from "../src/production/serverless.mjs";
import { readRuntimeConfig } from "../src/production/runtime.mjs";
import { normalizeArticleCommand } from "../src/production/validation.mjs";
import { exportMedia, restoreMedia } from "../src/production/media-backup.mjs";
import sharp from "sharp";
import {renderPublicArticle} from '../src/production/render.mjs';

test('raw Data API HTML and source URLs are sanitized at the rendering boundary',()=>{
 const html=renderPublicArticle({slug:'raw',content:{title:'Raw',seo:{}},renderedHtml:'<p onclick="steal()">Safe</p><script>alert(1)</script>',sources:[{label:'Bad',url:'javascript:steal()'}]});
 assert.doesNotMatch(html,/onclick=|alert\(1\)|javascript:steal/);assert.match(html,/Safe/);
});

const actor = "00000000-0000-4000-8000-000000000001";
const article = "00000000-0000-4000-8000-000000000002";
const command = "00000000-0000-4000-8000-000000000003";

test("transaction rollback and actor binding use parameters", async () => {
  const queries = [];
  let released = false;
  const db = new PostgresCMS({
    connect: async () => ({
      query: async (...args) => {
        queries.push(args);
        return { rows: [] };
      },
      release: () => { released = true; },
    }),
  });
  await assert.rejects(db.transaction(actor, () => { throw Error("fail"); }));
  assert.equal(queries.at(-1)[0], "ROLLBACK");
  assert.deepEqual(JSON.parse(queries[1][1][0]), { sub: actor, role: "authenticated" });
  assert.equal(released, true);
});

test("idempotency UUID and command data are parameterized", async () => {
  const queries = [];
  const db = new PostgresCMS({
    connect: async () => ({
      query: async (...args) => {
        queries.push(args);
        return args[0].includes("dispatch") ? { rows: [{ result: { version: 1 } }] } : { rows: [] };
      },
      release() {},
    }),
  });
  assert.deepEqual(await db.command(actor, article, 0, "create", { title: "Draft" }, command), { version: 1 });
  const call = queries.find(([sql]) => sql.includes("dispatch"));
  assert.deepEqual(call[1], [command, article, 0, "create", '{"title":"Draft"}']);
  await assert.rejects(db.command(actor, article, 0, "bad action", {}, command), /Invalid action/);
});

test("Auth validates the live server response and ignores editable metadata", async () => {
  const identity = await verifiedIdentity("token", {
    url: "https://example.supabase.co",
    publishableKey: "public",
    fetchImpl: async () => Response.json({
      id: actor,
      user_metadata: { role: "owner" },
      app_metadata: { provider: "email" },
    }),
  });
  assert.deepEqual(identity, { id: actor, email: "", sessionId: null });
  await assert.rejects(verifiedIdentity("token", {
    url: "https://example.supabase.co",
    publishableKey: "public",
    fetchImpl: async () => new Response(null, { status: 401 }),
  }));
});

test("session cookies are secure and CSRF uses double submit", () => {
  const cookies = sessionCookies({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
  assert.equal(cookies.headers.length, 3);
  assert.ok(cookies.headers.every((value) => value.includes("Secure") && value.includes("SameSite=Strict")));
  assert.ok(cookies.headers.find((value) => value.startsWith(ACCESS_COOKIE)).includes("HttpOnly"));
  assert.ok(!cookies.headers.find((value) => value.startsWith(CSRF_COOKIE)).includes("HttpOnly"));
  const header = cookies.headers.map((value) => value.split(";")[0]).join("; ");
  const request = new Request("https://cms.example/api", { headers: { cookie: header, "x-csrf-token": cookies.csrf } });
  requireCsrf(request);
  assert.equal(parseCookies(header)[CSRF_COOKIE], cookies.csrf);
  assert.throws(() => requireCsrf(new Request("https://cms.example/api", { headers: { cookie: header } })));
});

test("PDF/SVG remain disabled and canonical images are metadata-stripped WebP", async () => {
  await assert.rejects(validatedImage(Buffer.from("%PDF-1.7\n%%EOF")));
  await assert.rejects(validatedImage(Buffer.from("<svg></svg>")));
  await assert.rejects(validatedImage(Buffer.alloc(MAX_IMAGE_BYTES + 1)));
  const source = await sharp({ create: { width: 4, height: 3, channels: 4, background: "#00a8a8" } }).png().toBuffer();
  const image = await validatedImage(source);
  assert.equal(image.mime, "image/webp");
  assert.equal(image.width, 4);
  assert.equal(image.height, 3);
  assert.match(image.checksum, /^[a-f0-9]{64}$/);
  assert.equal(mediaObjectKey(article), `images/${article}.webp`);
  assert.equal(safeMediaName("../../Pool Photo?.png"), "Pool Photo-.png");
});

test("media gateway fails closed and applies public/private cache policy", async () => {
  let read = false;
  await assert.rejects(mediaGateway(article, {
    authorize: async () => { throw Error("deny"); },
    readPrivate: async () => { read = true; },
  }));
  assert.equal(read, false);
  assert.equal((await mediaGateway("bad", { authorize() {}, readPrivate() {} })).status, 404);
  const response = await mediaGateway(article, {
    authorize: async () => true,
    readPrivate: async () => Buffer.from("webp"),
    published: true,
    etag: "abc",
  });
  assert.match(response.headers.get("cache-control"), /s-maxage/);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
});

test("scheduled route requires credential, reports failures, and never runs on denial", async () => {
  let ran = false;
  const route = scheduleRoute({ secret: "secret", runDue: async () => { ran = true; return { published: 2 }; } });
  assert.equal((await route(new Request("https://local/api/cron"))).status, 401);
  assert.equal(ran, false);
  const ok = await route(new Request("https://local/api/cron", { headers: { authorization: "Bearer secret" } }));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, result: { published: 2 } });
});

test("command route rejects cross-origin and missing CSRF before identity/database", async () => {
  let called = false;
  const route = commandRoute({
    origin: "https://cms.example",
    identity: async () => { called = true; return { id: actor }; },
    db: { command: async () => ({}) },
  });
  assert.equal((await route(new Request("https://cms.example", {
    method: "POST",
    headers: { origin: "https://evil.example" },
  }))).status, 403);
  assert.equal((await route(new Request("https://cms.example", {
    method: "POST",
    headers: { origin: "https://cms.example" },
  }))).status, 403);
  assert.equal(called, false);
});

test("login refuses non-members before setting a CMS session", async () => {
  const route = loginRoute({
    origin: "https://cms.example",
    signIn: async () => ({ identity: { id: actor }, access_token: "a", refresh_token: "r", expires_in: 3600 }),
    memberRole: async () => { throw Object.assign(Error("CMS membership denied"), { status: 403 }); },
  });
  const response = await route(new Request("https://cms.example/api/login", {
    method: "POST",
    headers: { origin: "https://cms.example" },
    body: JSON.stringify({ email: "owner@example.com", password: "secret" }),
  }));
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("runtime configuration requires no database credential", () => {
  const base = {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "public",
    CMS_ORIGIN: "https://cms.example",
  };
  assert.equal(readRuntimeConfig(base).origin, "https://cms.example");
  assert.equal(Object.hasOwn(readRuntimeConfig(base), "databaseUrl"), false);
  assert.throws(() => readRuntimeConfig({ ...base, CMS_ORIGIN: "http://cms.example" }), /HTTPS origin/);
});

test("Data API adapter uses publishable key plus caller JWT and never an elevated credential", async () => {
  const calls = [];
  const db = new SupabaseDataCMS({
    url: "https://example.supabase.co",
    publishableKey: "publishable",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return Response.json({ version: 1 });
    },
  });
  const user = { id: actor, accessToken: "verified-user-jwt" };
  assert.deepEqual(await db.command(user, article, 0, "create", { title: "Draft" }, command), { version: 1 });
  const headers = calls[0].options.headers;
  assert.equal(headers.apikey, "publishable");
  assert.equal(headers.Authorization, "Bearer verified-user-jwt");
  assert.equal(headers["Content-Profile"], "resources_cms");
  assert.doesNotMatch(JSON.stringify(calls), /service_role|CMS_DATABASE_URL/i);
  assert.throws(() => db.command({ id: actor }, article, 0, "create", {}, command), /Verified CMS session/);
});

test("production validation sanitizes article HTML before database dispatch", () => {
  const value = normalizeArticleCommand("save", {
    title: "Safe", slug: "safe", categoryId: article, tagIds: [], audience: "homeowners",
    body: '<p onclick="steal()">Keep</p><script>alert(1)</script><img src="https://evil.test/x" onerror="x">', sources: [], seo: {},
  });
  assert.doesNotMatch(value.body, /script|onclick|onerror|evil\.test/i);
  assert.match(value.body, /Keep/);
});

test("revoked refresh is fail-closed and clears all session cookies", async () => {
  const route = refreshRoute({
    origin: "https://cms.example",
    authConfig: { url: "https://example.supabase.co", publishableKey: "public", fetchImpl: async () => new Response(null, { status: 401 }) },
    memberRole: async () => "owner",
  });
  const session = sessionCookies({ access_token: "old", refresh_token: "revoked", expires_in: 60 });
  const cookieHeader = session.headers.map((item) => item.split(";", 1)[0]).join("; ");
  const response = await route(new Request("https://cms.example/api/refresh", { method: "POST", headers: { origin: "https://cms.example", cookie: cookieHeader, "x-csrf-token": session.csrf } }));
  assert.equal(response.status, 401);
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/);
});

test("media backup verifies checksums and restores without service credentials", async () => {
  const bytes = Buffer.from("canonical-webp");
  const checksum = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
  const uploaded = [];
  const storage = {
    download: async () => new Response(bytes),
    request: async (key, token, options) => { uploaded.push({ key, token, body: Buffer.from(options.body).toString() }); return new Response(null, { status: 200 }); },
  };
  const backup = await exportMedia({ db: { mediaList: async () => [{ id: article, object_key: `images/${article}.webp`, checksum, mime: "image/webp", archived: false }] }, storage, actorId: actor, token: "user-token" });
  assert.equal(backup.objects.length, 1);
  assert.deepEqual(await restoreMedia({ backup, storage, token: "restore-token" }), { restored: 1 });
  assert.deepEqual(uploaded[0], { key: `images/${article}.webp`, token: "restore-token", body: "canonical-webp" });
});
