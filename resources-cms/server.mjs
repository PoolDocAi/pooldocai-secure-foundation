import http from "node:http";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { resolve, extname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import sharp from "sharp";
import {
  openStore,
  seedTaxonomy,
  now,
  uid,
  transaction,
  audit,
  revision,
  verifyPassword,
  passwordHash,
} from "./src/store.mjs";
import { validateContent, warnings, esc } from "./src/content.mjs";
import { collectionSchema, assertEditorialRelease } from './src/editorial-collection.mjs';
import {
  revoke,
  checksum,
  classifications,
  sections,
  exportKnowledge,
} from "./src/knowledge.mjs";
import { renderArticle, renderHub, sitemap } from "./src/render.mjs";
import { editorialAsset } from "./src/editorial-assets.mjs";
import {catalogSitemap,localPublishedRows,addPublicCapabilities} from './src/platform/catalog.mjs';
import {localPlatform} from './src/platform/local.mjs';
import {platformRoutes,platformPath} from './src/platform/routes.mjs';
import {toWebRequest,sendWebResponse} from './src/production/node-http.mjs';
const root = resolve(import.meta.dirname),
  hash = (x) => createHash("sha256").update(x).digest("hex");
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
export function createCMS({
  dbPath = process.env.CMS_DB || "data/cms.sqlite",
  mediaPath = process.env.CMS_MEDIA || "data/media",
  origin = process.env.CMS_ORIGIN || "http://127.0.0.1:4173",
  testMode = false,
  features = {taxonomy:process.env.CMS_TAXONOMY_V3==='1',discovery:process.env.CMS_DISCOVERY_V3==='1',analytics:process.env.CMS_ANALYTICS_ENABLED==='1',assistant:process.env.CMS_ASSISTANT_ENABLED==='1'},
} = {}) {
  const db = openStore(dbPath);
  collectionSchema(db);
  db.exec(readFileSync(resolve(root, "migrations/002-knowledge.sql"), "utf8"));
  seedTaxonomy(db);
  mkdirSync(mediaPath, { recursive: true });
  if (
    !/^https:\/\//.test(origin) &&
    !/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin)
  )
    throw new Error("HTTPS required outside loopback");
  const secure = origin.startsWith("https:"),
    cookieName = secure ? "__Host-cms" : "cms_local";
  const permissions = {
    owner: [
      "read",
      "write",
      "review",
      "publish",
      "taxonomy",
      "media",
      "settings",
      "export",
      "knowledge",
    ],
    editor: ["read", "write", "media"],
    reviewer: ["read", "review", "knowledge"],
    viewer: ["read"],
  };
  const send = (
    res,
    status,
    data,
    type = "application/json; charset=utf-8",
  ) => {
    res.writeHead(status, { "Content-Type": type });
    res.end(type.startsWith("application/json") ? JSON.stringify(data) : data);
  };
  const optionalUser=req=>{try{return auth(req);}catch{return null;}};
  const getRow = (id) => {
    const r = db.prepare("SELECT * FROM articles WHERE id=?").get(id);
    if (!r) fail(404, "Resource not found");
    return r;
  };
  const format = (r) => ({
    ...r,
    data: JSON.parse(r.data),
    published: !!r.published,
    warnings: [...warnings(db, JSON.parse(r.data)), ...db.prepare('SELECT reason FROM editorial_holds WHERE article_id=?').all(r.id).map(x=>'Publication hold: '+x.reason)],
    knowledge: db
      .prepare("SELECT * FROM knowledge_reviews WHERE article_id=?")
      .get(r.id) || {
      status: "not_submitted",
      classification: "unverified_hypothesis",
    },
  });
  const auth = (req) => {
    const raw = (req.headers.cookie || "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
    if (!raw) return null;
    return db
      .prepare(
        "SELECT u.id,u.email,u.role,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1",
      )
      .get(hash(raw), Date.now());
  };
  const requirePerm = (req, p) => {
    const u = auth(req);
    if (!u) fail(401, "Sign in required");
    if (!permissions[u.role]?.includes(p))
      fail(403, "Your role cannot perform this action");
    return u;
  };
  const readBody = async (req) => {
    let size = 0,
      parts = [];
    for await (const part of req) {
      size += part.length;
      if (size > 15 * 1024 * 1024) fail(413, "Request too large");
      parts.push(part);
    }
    try {
      return JSON.parse(Buffer.concat(parts).toString() || "{}");
    } catch {
      fail(400, "Invalid JSON");
    }
  };
  const checkVersion = (row, body) => {
    if (!Number.isInteger(body.version) || row.version !== body.version)
      fail(409, "This resource changed elsewhere. Reload before saving.");
  };
  const save = (row, data, actor, reason, extra = {}) => {
    const time = now();
    revoke(db, row.id, actor, "Content or editorial state changed");
    db.prepare(
      "UPDATE articles SET data=?,version=version+1,updated_at=? WHERE id=?",
    ).run(JSON.stringify({ ...data, updatedAt: time }), time, row.id);
    if (extra.status)
      db.prepare("UPDATE articles SET status=?,scheduled_at=? WHERE id=?").run(
        extra.status,
        extra.scheduledAt || null,
        row.id,
      );
    const next = getRow(row.id);
    revision(db, next, actor, reason);
    audit(db, actor, reason, row.id, { version: next.version });
    return format(next);
  };
  function publicationChecks(d) {
    if(features.taxonomy) {
      const keys={primaryTopicId:'equipment',guideTypeId:'content_type',audienceTagId:'audience'};
      for(const [key,facet] of Object.entries(keys))if(!d.discovery?.[key]||!d.tagIds.includes(d.discovery[key])||!db.prepare('SELECT 1 FROM facet_tags f JOIN taxonomy t ON t.id=f.tag_id WHERE f.tag_id=? AND f.facet=? AND NOT t.archived AND f.merged_into IS NULL').get(d.discovery[key],facet))fail(422,'Primary topic, guide type and audience tags require editorial selection');
    }
    const w = warnings(db, d);
    if (
      w.includes("Article body is empty") ||
      !d.summary ||
      !d.seo.title ||
      !d.seo.description ||
      !d.sources.length ||
      w.some((x) => /alt text|Broken internal/.test(x))
    )
      fail(422, "Resolve publication checks: " + w.join("; "));
    for (const [, id] of (
      d.body +
      " " +
      d.featuredImage +
      " " +
      d.seo.image
    ).matchAll(/\/media\/([a-f0-9-]+)/g))
      if (!db.prepare("SELECT id FROM media WHERE id=?").get(id))
        fail(422, "Referenced media does not exist");
  }
  function publish(row, actor, reason = "publish") {
    assertEditorialRelease(db, row.id);
    revoke(db, row.id, actor, "Publication revision changed");
    const data = JSON.parse(row.data);
    publicationChecks(data);
    const other = db
      .prepare("SELECT id FROM articles WHERE slug=? AND id<>?")
      .get(data.slug, row.id);
    if (other) fail(409, "Duplicate slug");
    const reserved = db
      .prepare("SELECT article_id FROM redirects WHERE old_slug=?")
      .get(data.slug);
    if (reserved && reserved.article_id !== row.id)
      fail(409, "Slug is reserved by an existing redirect");
    const previous = row.published ? JSON.parse(row.published) : null;
    if (row.slug !== data.slug) {
      if(data.seo.canonical===`https://pooldocai.com/resources/${row.slug}/`) data.seo.canonical=`https://pooldocai.com/resources/${data.slug}/`;
      db.prepare(
        "INSERT INTO redirects(old_slug,article_id,created_at) VALUES(?,?,?) ON CONFLICT(old_slug) DO UPDATE SET article_id=excluded.article_id",
      ).run(row.slug, row.id, now());
    }
    const live = {
      ...data,
      publishedAt: data.publishedAt || previous?.publishedAt || now(),
      updatedAt: now(),
    };
    delete live.legacyHtml;
    delete live.legacySha256;
    db.prepare(
      "UPDATE articles SET slug=?,published=?,data=?,status='published',scheduled_at=NULL,version=version+1,updated_at=? WHERE id=?",
    ).run(live.slug, JSON.stringify(live), JSON.stringify(live), now(), row.id);
    const next = getRow(row.id);
    revision(db, next, actor, reason);
    audit(db, actor, reason, row.id, {
      slug: live.slug,
      version: next.version,
    });
    return format(next);
  }
  function runScheduled() {
    for (const r of db
      .prepare(
        "SELECT * FROM articles WHERE status='scheduled' AND scheduled_at<=?",
      )
      .all(now())) {
      try {
        transaction(db, () => publish(r, null, "scheduled_publish"));
      } catch (e) {
        transaction(db, () => {
          db.prepare(
            "UPDATE articles SET status='review',scheduled_at=NULL WHERE id=?",
          ).run(r.id);
          audit(db, null, "schedule_failed", r.id, { message: e.message });
        });
      }
    }
  }
  const interval = setInterval(runScheduled, 1000);
  interval.unref();
  const platform=features.taxonomy?localPlatform(db,save):null;
  const server = http.createServer(async (req, res) => {
    let pathname = "";
    try {
      const url = new URL(req.url, origin);
      pathname = decodeURIComponent(url.pathname);
      const isPrivate =
        pathname.startsWith("/admin") ||
        pathname.startsWith("/api") ||
        pathname.startsWith("/preview");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=()",
      );
      res.setHeader(
        "Cache-Control",
        isPrivate ? "no-store" : "public, max-age=0, must-revalidate",
      );
      res.setHeader(
        "Content-Security-Policy",
        isPrivate
          ? "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; form-action 'self'; base-uri 'none'; object-src 'none'"
          : "default-src 'self'; script-src 'self' 'sha256-UzfK5VgY11o7T9BtOY3Q6sHMid5P8QyFd282tQRFh8A=' https://www.googletagmanager.com https://connect.facebook.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://www.google-analytics.com https://www.facebook.com; connect-src 'self' https://formspree.io https://www.google-analytics.com https://region1.google-analytics.com https://www.facebook.com; form-action 'self' https://formspree.io; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
      );
      if (isPrivate)
        res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
      if (secure)
        res.setHeader("Strict-Transport-Security", "max-age=31536000");
      if (platformPath(pathname)&&!(pathname==='/resources/'&&!features.discovery)) {
        const handler=platformRoutes({features,adapter:platform,origin,identity:async()=>requirePerm(req,'read'),guardWrite:async()=>{const u=requirePerm(req,'read');if(req.headers.origin!==origin||req.headers['x-csrf-token']!==u.csrf)fail(403,'Request security check failed');}});
        return sendWebResponse(res,await handler(await toWebRequest(req,32768)));
      }
      if (req.method === "GET" && pathname === "/health")
        return send(res, 200, { ok: true });
      if (req.method === "POST" && pathname === "/api/login") {
        if (req.headers.origin !== origin) fail(403, "Origin rejected");
        const b = await readBody(req),
          email = String(b.email || "").toLowerCase(),
          ip = req.socket.remoteAddress;
        if (email.length > 254 || String(b.password || "").length > 1024)
          fail(422, "Invalid credential length");
        // Do not trust forwarded IPs; an upstream rate limiter is required behind a shared proxy.
        for (const key of [`ip:${ip}`, `email:${email}`]) {
          const a = db
            .prepare("SELECT * FROM login_attempts WHERE key=?")
            .get(key);
          if (a && a.until_at > Date.now() && a.count >= 8)
            fail(429, "Too many attempts. Try again in 15 minutes.");
          db.prepare(
            "INSERT INTO login_attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=CASE WHEN until_at<? THEN 1 ELSE count+1 END,until_at=CASE WHEN until_at<? THEN excluded.until_at ELSE until_at END",
          ).run(key, Date.now() + 900000, Date.now(), Date.now());
        }
        const u = db
          .prepare("SELECT * FROM users WHERE email=? AND active=1")
          .get(email);
        const dummy = passwordHash("dummy-timing-password");
        if (
          !verifyPassword(
            String(b.password || ""),
            u?.password_hash || dummy,
          ) ||
          !u
        )
          fail(401, "Email or password is incorrect");
        const token = randomBytes(32).toString("hex"),
          csrf = randomBytes(32).toString("hex");
        transaction(db, () => {
          db.prepare(
            "DELETE FROM sessions WHERE expires_at<? OR user_id=?",
          ).run(Date.now(), u.id);
          db.prepare("INSERT INTO sessions VALUES(?,?,?,?)").run(
            hash(token),
            u.id,
            csrf,
            Date.now() + 8 * 3600000,
          );
          audit(db, u.id, "login", u.id);
        });
        res.setHeader(
          "Set-Cookie",
          `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secure ? "; Secure" : ""}`,
        );
        return send(res, 200, { id: u.id, email: u.email, role: u.role, csrf });
      }
      if (pathname.startsWith("/api/")) {
        const u = requirePerm(req, "read");
        if (!["GET", "HEAD"].includes(req.method)) {
          if (
            req.headers.origin !== origin ||
            req.headers["x-csrf-token"] !== u.csrf
          )
            fail(403, "Request security check failed");
          if (
            !String(req.headers["content-type"]).startsWith("application/json")
          )
            fail(415, "Use application/json");
        }
        const body = ["GET", "HEAD"].includes(req.method)
          ? {}
          : await readBody(req);
        if (pathname === "/api/me" && req.method === "GET")
          return send(res, 200, u);
        if (pathname === "/api/logout" && req.method === "POST") {
          db.prepare("DELETE FROM sessions WHERE user_id=?").run(u.id);
          res.setHeader(
            "Set-Cookie",
            `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}`,
          );
          return send(res, 200, { ok: true });
        }
        if (pathname === "/api/dashboard" && req.method === "GET") {
          const rows = db
              .prepare("SELECT * FROM articles ORDER BY updated_at DESC")
              .all(),
            counts = {};
          for (const s of [
            "published",
            "draft",
            "scheduled",
            "archived",
            "review",
            "approved",
            "deleted",
          ])
            counts[s] = rows.filter((r) => r.status === s).length;
          return send(res, 200, {
            counts,
            warnings: rows
              .filter((r) => r.status !== "deleted")
              .flatMap((r) =>
                warnings(db, JSON.parse(r.data)).map((message) => ({
                  id: r.id,
                  title: JSON.parse(r.data).title,
                  message,
                })),
              ),
            recent: db
              .prepare(
                "SELECT a.*,u.email FROM audit a LEFT JOIN users u ON a.actor_id=u.id ORDER BY a.created_at DESC LIMIT 25",
              )
              .all(),
          });
        }
        if (pathname === "/api/content" && req.method === "GET")
          return send(
            res,
            200,
            db
              .prepare("SELECT * FROM articles ORDER BY updated_at DESC")
              .all()
              .map(format),
          );
        if (
          (pathname === "/api/content" || pathname === "/api/import") &&
          req.method === "POST"
        ) {
          requirePerm(req, "write");
          if (
            pathname === "/api/import" &&
            body.format !== "pooldocai-resource-v1"
          )
            fail(422, "Expected format pooldocai-resource-v1");
          const input = pathname === "/api/import" ? body.article : body;
          if (!input || typeof input !== "object")
            fail(422, "Article object required");
          const data = validateContent(db, input);
          if (
            db.prepare("SELECT id FROM articles WHERE slug=?").get(data.slug) ||
            db
              .prepare("SELECT old_slug FROM redirects WHERE old_slug=?")
              .get(data.slug) ||
            db
              .prepare(
                "SELECT id FROM articles WHERE json_extract(data,'$.slug')=?",
              )
              .get(data.slug)
          )
            fail(409, "Duplicate or reserved slug");
          const id = uid(),
            time = now();
          transaction(db, () => {
            db.prepare(
              "INSERT INTO articles(id,slug,status,data,version,created_at,updated_at) VALUES(?,?,'draft',?,1,?,?)",
            ).run(
              id,
              data.slug,
              JSON.stringify({ ...data, updatedAt: time }),
              time,
              time,
            );
            revision(
              db,
              getRow(id),
              u.id,
              pathname === "/api/import" ? "import_draft" : "create",
            );
            audit(
              db,
              u.id,
              pathname === "/api/import" ? "import_draft" : "create",
              id,
            );
          });
          return send(res, 201, format(getRow(id)));
        }
        if (pathname === "/api/bulk/archive" && req.method === "POST") {
          requirePerm(req, "publish");
          if (
            !Array.isArray(body.items) ||
            !body.items.length ||
            body.items.length > 50
          )
            fail(422, "Select between 1 and 50 resources");
          const result = transaction(db, () =>
            body.items.map((item) => {
              const row = getRow(item.id);
              checkVersion(row, item);
              if (["archived", "deleted"].includes(row.status))
                fail(409, "Selection contains an already archived resource");
              db.prepare(
                "UPDATE articles SET previous_status=?,published=NULL WHERE id=?",
              ).run(row.status, row.id);
              return save(row, JSON.parse(row.data), u.id, "bulk_archive", {
                status: "archived",
              });
            }),
          );
          return send(res, 200, result);
        }
        const match = pathname.match(
          /^\/api\/content\/([a-f0-9-]+)(?:\/(.+))?$/,
        );
        if (match) {
          const row = getRow(match[1]),
            action = match[2];
          if (req.method === "GET" && !action)
            return send(res, 200, format(row));
          if (req.method === "GET" && action === "revisions")
            return send(
              res,
              200,
              db
                .prepare(
                  "SELECT * FROM revisions WHERE article_id=? ORDER BY version DESC LIMIT 100",
                )
                .all(row.id)
                .map((r) => ({ ...r, data: JSON.parse(r.data) })),
            );
          if (req.method === "PUT" && !action) {
            requirePerm(req, "write");
            checkVersion(row, body);
            if (["deleted", "archived", "scheduled"].includes(row.status))
              fail(409, "Restore or cancel the schedule before editing");
            const d = validateContent(
              db,
              body,
              row.data ? JSON.parse(row.data) : {},
            );
            const conflict = db
              .prepare(
                "SELECT id FROM articles WHERE id<>? AND (slug=? OR json_extract(data,'$.slug')=?)",
              )
              .get(row.id, d.slug, d.slug);
            const old = db
              .prepare("SELECT article_id FROM redirects WHERE old_slug=?")
              .get(d.slug);
            if (conflict || (old && old.article_id !== row.id))
              fail(409, "Duplicate or reserved slug");
            return send(
              res,
              200,
              transaction(db, () =>
                save(row, d, u.id, "save", { status: "draft" }),
              ),
            );
          }
          if (req.method === "POST" && action) {
            checkVersion(row, body);
            const d = JSON.parse(row.data);
            return send(
              res,
              200,
              transaction(db, () => {
                if (action === "knowledge-submit") {
                  requirePerm(req, "write");
                  if (row.status !== "published" || !row.published)
                    fail(
                      409,
                      "Publish and verify the current revision before knowledge review",
                    );
                  const rev = db
                    .prepare(
                      "SELECT id FROM revisions WHERE article_id=? AND version=?",
                    )
                    .get(row.id, row.version);
                  const oldReview = db
                    .prepare(
                      "SELECT status FROM knowledge_reviews WHERE article_id=?",
                    )
                    .get(row.id);
                  if (oldReview?.status === "approved")
                    fail(
                      409,
                      "Revoke the current knowledge approval before requesting a new review",
                    );
                  db.prepare(
                    "INSERT INTO knowledge_reviews(article_id,status,revision_id) VALUES(?,'pending',?) ON CONFLICT(article_id) DO UPDATE SET status='pending',approval_id=NULL,revision_id=excluded.revision_id,classification='unverified_hypothesis',verification_status='unverified',checksum=NULL,reviewer_id=NULL,reviewed_at=NULL,evidence='[]',section_ids='[]',reason=''",
                  ).run(row.id, rev.id);
                  audit(db, u.id, "knowledge_submit", row.id);
                  return format(getRow(row.id));
                }
                if (action === "knowledge-revoke") {
                  requirePerm(req, "knowledge");
                  revoke(
                    db,
                    row.id,
                    u.id,
                    String(body.reason || "Reviewer withdrew approval"),
                  );
                  return format(getRow(row.id));
                }
                if (action === "knowledge-approve") {
                  requirePerm(req, "knowledge");
                  const k = db
                    .prepare(
                      "SELECT * FROM knowledge_reviews WHERE article_id=?",
                    )
                    .get(row.id);
                  if (
                    !k ||
                    k.status !== "pending" ||
                    row.status !== "published"
                  )
                    fail(
                      409,
                      "Submit the published current revision for knowledge review first",
                    );
                  if (
                    !classifications.includes(body.classification) ||
                    body.classification === "unverified_hypothesis"
                  )
                    fail(
                      422,
                      "Unverified hypotheses cannot enter diagnostic retrieval",
                    );
                  const evidence = body.evidence;
                  if (
                    !Array.isArray(evidence) ||
                    !evidence.length ||
                    evidence.some(
                      (e) =>
                        !d.sources.some((s) => s.url === e.url) ||
                        ![
                          "manufacturer",
                          "authority",
                          "technician_verification",
                        ].includes(e.type) ||
                        !e.excerpt ||
                        String(e.excerpt).length > 3000,
                    )
                  )
                    fail(
                      422,
                      "Supply evidence excerpts from the article source references with an evidence type",
                    );
                  const actionable = [
                    "manufacturer_supported_diagnostic",
                    "technician_reviewed_diagnostic",
                    "verified_repair_procedure",
                  ].includes(body.classification);
                  if (
                    actionable &&
                    (!body.humanVerified ||
                      !String(body.verificationMethod || "").trim() ||
                      !evidence.some((e) => e.type === "manufacturer") ||
                      !evidence.some(
                        (e) =>
                          e.type === "technician_verification" &&
                          evidence.some(
                            (m) => m.type === "manufacturer" && m.url !== e.url,
                          ),
                      ))
                  )
                    fail(
                      422,
                      "Actionable guidance requires original manufacturer evidence, a technician verification record, a human attestation and verification method",
                    );
                  const sectionIds = body.sectionIds || [];
                  if (
                    !Array.isArray(sectionIds) ||
                    sectionIds.some(
                      (id) => !sections(d).some((s) => s.id === id),
                    )
                  )
                    fail(422, "Unknown section ID");
                  const rev = db
                    .prepare(
                      "SELECT * FROM revisions WHERE article_id=? AND version=?",
                    )
                    .get(row.id, row.version);
                  if (rev.id !== k.revision_id)
                    fail(409, "Revision changed during knowledge review");
                  const verification = actionable
                      ? "human_technically_verified"
                      : "evidence_reviewed",
                    approvalId = uid();
                  db.prepare(
                    "UPDATE knowledge_reviews SET status='approved',approval_id=?,classification=?,verification_status=?,checksum=?,reviewer_id=?,reviewed_at=?,evidence=?,section_ids=?,reason=? WHERE article_id=?",
                  ).run(
                    approvalId,
                    body.classification,
                    verification,
                    checksum(d),
                    u.id,
                    now(),
                    JSON.stringify(evidence),
                    JSON.stringify(sectionIds),
                    String(body.verificationMethod || "Source reviewed"),
                    row.id,
                  );
                  db.prepare(
                    "INSERT OR IGNORE INTO knowledge_outbox(id,article_id,revision_id,approval_id,event,created_at) VALUES(?,?,?,?,'upsert',?)",
                  ).run(uid(), row.id, rev.id, approvalId, now());
                  audit(db, u.id, "knowledge_approve", row.id, {
                    revisionId: rev.id,
                    classification: body.classification,
                    verification,
                    evidence,
                    sectionIds,
                    verificationMethod: body.verificationMethod,
                  });
                  return format(getRow(row.id));
                }
                if (action === "publish") {
                  requirePerm(req, "publish");
                  if (row.status !== "approved")
                    fail(409, "Approve for publication before publishing");
                  return publish(row, u.id);
                }
                if (action === "schedule") {
                  assertEditorialRelease(db, row.id);
                  requirePerm(req, "publish");
                  if (row.status !== "approved")
                    fail(409, "Approve this draft before scheduling");
                  if (
                    !Number.isFinite(Date.parse(body.scheduledAt)) ||
                    Date.parse(body.scheduledAt) <= Date.now()
                  )
                    fail(422, "Choose a future publication time");
                  publicationChecks(d);
                  return save(row, d, u.id, "schedule", {
                    status: "scheduled",
                    scheduledAt: new Date(body.scheduledAt).toISOString(),
                  });
                }
                if (action === "cancel-schedule") {
                  requirePerm(req, "publish");
                  if (row.status !== "scheduled")
                    fail(409, "Resource is not scheduled");
                  return save(row, d, u.id, "cancel_schedule", {
                    status: row.published ? "published" : "approved",
                  });
                }
                if (action === "review") {
                  requirePerm(req, "write");
                  if (row.status !== "draft")
                    fail(409, "Only drafts can enter review");
                  return save(row, d, u.id, "request_review", {
                    status: "review",
                  });
                }
                if (action === "approve") {
                  requirePerm(req, "review");
                  if (row.status !== "review")
                    fail(409, "Only resources in review can be approved");
                  publicationChecks(d);
                  return save(row, d, u.id, "approve", { status: "approved" });
                }
                if (action === "unpublish") {
                  requirePerm(req, "publish");
                  if (!row.published) fail(409, "Resource is not published");
                  db.prepare(
                    "UPDATE articles SET published=NULL WHERE id=?",
                  ).run(row.id);
                  return save(row, d, u.id, "unpublish", { status: "draft" });
                }
                if (action === "archive" || action === "delete") {
                  requirePerm(req, "publish");
                  if (row.status === "deleted")
                    fail(409, "Resource is already in trash");
                  if (action === "delete" && row.status !== "archived")
                    fail(409, "Archive a resource before moving it to trash");
                  db.prepare(
                    "UPDATE articles SET previous_status=?,published=NULL WHERE id=?",
                  ).run(row.status, row.id);
                  return save(row, d, u.id, action, {
                    status: action === "archive" ? "archived" : "deleted",
                  });
                }
                if (action === "restore") {
                  requirePerm(req, "write");
                  if (!["archived", "deleted"].includes(row.status))
                    fail(409, "Resource is not archived or deleted");
                  return save(row, d, u.id, "restore_as_draft", {
                    status: "draft",
                  });
                }
                if (action === "rollback") {
                  requirePerm(req, "write");
                  if (["scheduled", "archived", "deleted"].includes(row.status))
                    fail(409, "Restore or cancel schedule before rolling back");
                  const r = db
                    .prepare(
                      "SELECT * FROM revisions WHERE article_id=? AND id=?",
                    )
                    .get(row.id, body.revisionId);
                  if (!r) fail(404, "Revision not found");
                  const restored = validateContent(db, JSON.parse(r.data));
                  const c = db
                    .prepare(
                      "SELECT id FROM articles WHERE id<>? AND (slug=? OR json_extract(data,'$.slug')=?)",
                    )
                    .get(row.id, restored.slug, restored.slug);
                  if (c) fail(409, "Revision slug is now reserved");
                  return save(row, restored, u.id, "rollback_as_draft", {
                    status: "draft",
                  });
                }
                if (action === "duplicate") {
                  requirePerm(req, "write");
                  const id = uid(),
                    time = now();
                  let slug = `${d.slug.slice(0, 90)}-copy-${id.slice(0, 8)}`;
                  const copy = {
                    ...d,
                    title: `${d.title} (copy)`.slice(0, 180),
                    slug,
                    publishedAt: null,
                    updatedAt: time,
                    featured: false,
                    seo: { ...d.seo, canonical: "" },
                  };
                  delete copy.legacyHtml;
                  delete copy.legacySha256;
                  db.prepare(
                    "INSERT INTO articles(id,slug,status,data,version,created_at,updated_at) VALUES(?,?,'draft',?,1,?,?)",
                  ).run(id, slug, JSON.stringify(copy), time, time);
                  revision(db, getRow(id), u.id, "duplicate");
                  audit(db, u.id, "duplicate", id, { source: row.id });
                  return format(getRow(id));
                }
                fail(404, "Unknown content action");
              }),
            );
          }
          fail(405, "Method not allowed");
        }
        if (pathname === "/api/taxonomy" && req.method === "GET")
          return send(
            res,
            200,
            db
              .prepare("SELECT * FROM taxonomy ORDER BY kind,position,name")
              .all(),
          );
        if (pathname === "/api/taxonomy" && req.method === "POST") {
          requirePerm(req, "taxonomy");
          const kind = body.kind,
            name = String(body.name || "").trim();
          if (!["category", "tag"].includes(kind) || !name || name.length > 100)
            fail(422, "Category/tag name required (100 characters maximum)");
          const id = uid();
          db.prepare("INSERT INTO taxonomy VALUES(?,?,?,?,0)").run(
            id,
            kind,
            name,
            db
              .prepare("SELECT count(*) AS n FROM taxonomy WHERE kind=?")
              .get(kind).n,
          );
          audit(db, u.id, "taxonomy_create", id);
          return send(res, 201, { id });
        }
        const tax = pathname.match(/^\/api\/taxonomy\/([a-z0-9-]+)$/);
        if (tax && req.method === "PUT") {
          requirePerm(req, "taxonomy");
          return send(
            res,
            200,
            transaction(db, () => {
              const t = db
                .prepare("SELECT * FROM taxonomy WHERE id=?")
                .get(tax[1]);
              if (!t) fail(404, "Taxonomy not found");
              if (body.mergeInto) {
                const target = db
                  .prepare(
                    "SELECT * FROM taxonomy WHERE id=? AND kind=? AND archived=0",
                  )
                  .get(body.mergeInto, t.kind);
                if (!target || target.id === t.id)
                  fail(422, "Choose another active item of the same kind");
                for (const r of db.prepare("SELECT * FROM articles").all()) {
                  let changed = false;
                  const update = (d) => {
                    if (!d) return null;
                    if (t.kind === "category" && d.categoryId === t.id) {
                      d.categoryId = target.id;
                      changed = true;
                    }
                    if (t.kind === "tag" && d.tagIds.includes(t.id)) {
                      d.tagIds = [
                        ...new Set(
                          d.tagIds.map((x) => (x === t.id ? target.id : x)),
                        ),
                      ];
                      changed = true;
                    }
                    if (changed) {
                      delete d.legacyHtml;
                      delete d.legacySha256;
                    }
                    return d;
                  };
                  const d = update(JSON.parse(r.data)),
                    p = r.published;
                  if (changed) {
                    save(r, d, u.id, "taxonomy_merge");
                    db.prepare(
                      "UPDATE articles SET published=? WHERE id=?",
                    ).run(p, r.id);
                  }
                }
                db.prepare("UPDATE taxonomy SET archived=1 WHERE id=?").run(
                  t.id,
                );
              } else {
                const name = String(body.name ?? t.name).trim();
                if (
                  !name ||
                  name.length > 100 ||
                  !Number.isInteger(body.position ?? t.position)
                )
                  fail(422, "Invalid taxonomy values");
                if (body.archived === true) {
                  const used = db
                    .prepare(
                      "SELECT data,published FROM articles WHERE status NOT IN ('deleted','archived')",
                    )
                    .all()
                    .some((r) =>
                      [r.data, r.published].filter(Boolean).some((raw) => {
                        const d = JSON.parse(raw);
                        return t.kind === "category"
                          ? d.categoryId === t.id
                          : d.tagIds.includes(t.id);
                      }),
                    );
                  if (used)
                    fail(
                      409,
                      "Reassign or merge resources before archiving this item",
                    );
                }
                db.prepare(
                  "UPDATE taxonomy SET name=?,position=?,archived=? WHERE id=?",
                ).run(
                  name,
                  body.position ?? t.position,
                  body.archived === undefined
                    ? t.archived
                    : Number(body.archived),
                  t.id,
                );
              }
              audit(
                db,
                u.id,
                body.mergeInto ? "taxonomy_merge" : "taxonomy_update",
                t.id,
                body,
              );
              return { ok: true };
            }),
          );
        }
        if (pathname === "/api/media" && req.method === "GET")
          return send(
            res,
            200,
            db.prepare("SELECT * FROM media ORDER BY created_at DESC").all(),
          );
        if (pathname === "/api/media" && req.method === "POST") {
          requirePerm(req, "media");
          if (
            typeof body.base64 !== "string" ||
            !/^[A-Za-z0-9+/]*={0,2}$/.test(body.base64)
          )
            fail(422, "Invalid base64 file");
          let bytes = Buffer.from(body.base64, "base64");
          if (!bytes.length || bytes.length > 10 * 1024 * 1024)
            fail(413, "File must be between 1 byte and 10 MB");
          let mime = body.mime;
          const name = String(body.name || "upload")
            .replace(/[^a-zA-Z0-9._ -]/g, "")
            .slice(0, 160);
          if (/\.(svg|html?|js|exe|zip|docx?|xlsx?)$/i.test(name))
            fail(415, "This file type is not allowed");
          if (["image/png", "image/jpeg", "image/webp"].includes(mime)) {
            try {
              const image = sharp(bytes, { limitInputPixels: 40000000 });
              const meta = await image.metadata();
              if (!["png", "jpeg", "webp"].includes(meta.format))
                fail(415, "Image content does not match allowed formats");
              bytes = await image.rotate().webp({ quality: 85 }).toBuffer();
              mime = "image/webp";
            } catch {
              fail(415, "Invalid or oversized image");
            }
          } else if (mime === "application/pdf") {
            const txt = bytes.toString("latin1");
            if (
              !txt.startsWith("%PDF-") ||
              !txt.trimEnd().endsWith("%%EOF") ||
              /\/(JavaScript|JS|OpenAction|AA|Launch|EmbeddedFile|RichMedia|XFA)\b/i.test(
                txt,
              )
            )
              fail(
                415,
                "Invalid PDF or active PDF content. Upload a flattened PDF.",
              );
          } else if (mime === "text/plain" || mime === "text/csv") {
            if (bytes.includes(0) || bytes.toString("utf8").includes("\ufffd"))
              fail(415, "Text attachment must be UTF-8");
          } else
            fail(
              415,
              "Allowed files: JPEG, PNG, WebP, flattened PDF, UTF-8 text or CSV",
            );
          const id = uid(),
            alt = String(body.alt || "").slice(0, 300);
          writeFileSync(resolve(mediaPath, id), bytes, {
            mode: 0o600,
            flag: "wx",
          });
          db.prepare("INSERT INTO media VALUES(?,?,?,?,?,?,?,?)").run(
            id,
            name,
            mime,
            bytes.length,
            alt,
            hash(bytes),
            now(),
            u.id,
          );
          audit(db, u.id, "media_upload", id, { name, mime });
          return send(res, 201, { id, url: `/media/${id}`, name, mime, alt });
        }
        const media = pathname.match(/^\/api\/media\/([a-f0-9-]+)$/);
        if (media && req.method === "PUT") {
          requirePerm(req, "media");
          db.prepare("UPDATE media SET alt=? WHERE id=?").run(
            String(body.alt || "").slice(0, 300),
            media[1],
          );
          audit(db, u.id, "media_metadata", media[1]);
          return send(res, 200, { ok: true });
        }
        if (pathname === "/api/settings" && req.method === "GET")
          return send(res, 200, {
            ...JSON.parse(
              db.prepare("SELECT data FROM settings WHERE id=1").get().data,
            ),
            permissions,
            ownerOnlyProvisioning: true,
          });
        if (pathname === "/api/settings" && req.method === "PUT") {
          requirePerm(req, "settings");
          if (
            !["homeowners", "professionals", "both"].includes(
              body.defaultAudience,
            )
          )
            fail(422, "Invalid default audience");
          const d = {
            defaultAudience: body.defaultAudience,
            requireSources: true,
            publicationTimezone: "America/New_York",
            integrationIssuer: String(body.integrationIssuer || "").slice(
              0,
              200,
            ),
            indexNowEnabled: false,
          };
          db.prepare("UPDATE settings SET data=? WHERE id=1").run(
            JSON.stringify(d),
          );
          audit(db, u.id, "settings_update", "1");
          return send(res, 200, d);
        }
        if (pathname === "/api/knowledge/export" && req.method === "GET") {
          requirePerm(req, "export");
          return send(res, 200, exportKnowledge(db));
        }
        if (pathname === "/api/knowledge/eligibility" && req.method === "GET") {
          requirePerm(req, "knowledge");
          const out = exportKnowledge(db);
          return send(res, 200, {
            revisionId: url.searchParams.get("revisionId"),
            eligible: out.records.some(
              (r) =>
                r.revisionId === url.searchParams.get("revisionId") &&
                r.approvalId === url.searchParams.get("approvalId"),
            ),
            checkedAt: now(),
            cacheSeconds: 0,
          });
        }
        if (pathname === "/api/export" && req.method === "GET") {
          requirePerm(req, "export");
          res.setHeader(
            "Content-Disposition",
            'attachment; filename="pooldocai-editorial-export.json"',
          );
          return send(res, 200, {
            format: "pooldocai-backup-v1",
            exportedAt: now(),
            ...(features.taxonomy?{platform:{format:'resources-platform-local-v1',facetTags:db.prepare('SELECT * FROM facet_tags').all(),tagRequests:db.prepare('SELECT * FROM facet_requests').all(),liveVerifications:db.prepare('SELECT * FROM live_verifications').all()}}:{}),
            editorialHolds: db.prepare('SELECT * FROM editorial_holds').all(),
            knowledgeReviews: db
              .prepare("SELECT * FROM knowledge_reviews")
              .all(),
            knowledgeOutbox: db.prepare("SELECT * FROM knowledge_outbox").all(),
            articles: db.prepare("SELECT * FROM articles").all(),
            taxonomy: db.prepare("SELECT * FROM taxonomy").all(),
            revisions: db.prepare("SELECT * FROM revisions").all(),
            redirects: db.prepare("SELECT * FROM redirects").all(),
            media: db.prepare("SELECT * FROM media").all(),
            audit: db.prepare("SELECT * FROM audit").all(),
            settings: JSON.parse(
              db.prepare("SELECT data FROM settings").get().data,
            ),
          });
        }
        fail(404, "API endpoint not found");
      }
      if (pathname === "/admin" || pathname === "/admin/") {
        if (!auth(req)) {
          res.writeHead(303, { Location: "/admin/login" });
          return res.end();
        }
        return send(
          res,
          200,
          readFileSync(resolve(root, "public/admin.html")),
          "text/html; charset=utf-8",
        );
      }
      if (pathname === "/admin/login")
        return send(
          res,
          200,
          readFileSync(resolve(root, "public/login.html")),
          "text/html; charset=utf-8",
        );
      if (pathname.startsWith("/preview/")) {
        requirePerm(req, "read");
        const r = getRow(pathname.split("/")[2]);
        return send(
          res,
          200,
          renderArticle(
            db,
            { ...JSON.parse(r.data), updatedAt: r.updated_at },
            { preview: true },
          ),
          "text/html; charset=utf-8",
        );
      }
      const previewAsset = pathname.match(/^\/preview-assets\/(resource-17\/workflow\.(?:svg|png|pdf))$/);
      if (previewAsset && req.method === "GET") {
        requirePerm(req, "read");
        const asset = editorialAsset(previewAsset[1]);
        if (!asset) fail(404, "File not found");
        res.setHeader("Content-Disposition", `${asset.mime.startsWith("application/pdf") ? "attachment" : "inline"}; filename="${asset.filename}"`);
        res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
        return send(res, 200, asset.bytes, asset.mime);
      }
      if (pathname.startsWith("/media/")) {
        const id = pathname.split("/")[2],
          m = db.prepare("SELECT * FROM media WHERE id=?").get(id);
        if (!m) fail(404, "File not found");
        const publicUse = db
          .prepare(
            "SELECT published FROM articles WHERE published IS NOT NULL AND status NOT IN ('archived','deleted')",
          )
          .all()
          .some((r) => {
            const d = JSON.parse(r.published);
            return (
              (d.body || "").includes(`/media/${id}`) ||
              d.featuredImage === `/media/${id}` ||
              d.seo?.image === `/media/${id}`
            );
          });
        if (!publicUse) {
          requirePerm(req, "read");
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("X-Robots-Tag", "noindex");
        }
        res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
        res.setHeader(
          "Content-Disposition",
          `${m.mime.startsWith("image/") ? "inline" : "attachment"}; filename="${m.name.replace(/[^a-zA-Z0-9._ -]/g, "")}"`,
        );
        return send(res, 200, readFileSync(resolve(mediaPath, id)), m.mime);
      }
      if(features.discovery&&/^\/resources\/[a-z0-9-]+\/$/.test(pathname)){const rows=localPublishedRows(db);if(!rows.some(r=>new URL(r.url).pathname===pathname)){const target=db.prepare('SELECT a.slug FROM redirects r JOIN articles a ON a.id=r.article_id WHERE r.old_slug=?').get(pathname.split('/')[2]);if(target&&rows.some(r=>r.slug===target.slug)){res.writeHead(308,{'Location':'/resources/'+target.slug+'/','Cache-Control':'no-store'});return res.end();}return send(res,404,"Resource unavailable","text/plain");}}
      if (pathname === "/resources/" || pathname === "/resources")
        return send(
          res,
          200,
          renderHub(db, url.searchParams),
          "text/html; charset=utf-8",
        );
      const article = pathname.match(/^\/resources\/([a-z0-9-]+)\/?$/);
      if (article) {
        let r = db
          .prepare("SELECT * FROM articles WHERE slug=?")
          .get(article[1]);
        if (!r) {
          const redirect = db
            .prepare("SELECT article_id FROM redirects WHERE old_slug=?")
            .get(article[1]);
          if (redirect) {
            r = getRow(redirect.article_id);
            if (r.published && !["archived", "deleted"].includes(r.status)) {
              res.writeHead(308, { Location: `/resources/${r.slug}/` });
              return res.end();
            }
          }
          fail(404, "Resource not found");
        }
        if (["archived", "deleted"].includes(r.status)) {
          res.setHeader("X-Robots-Tag", "noindex");
          return send(
            res,
            410,
            '<h1>This resource has been retired</h1><a href="/resources/">Browse current resources</a>',
            "text/html; charset=utf-8",
          );
        }
        if (!r.published) fail(404, "Resource not found");
        if (!pathname.endsWith("/")) {
          res.writeHead(308, { Location: `/resources/${r.slug}/` });
          return res.end();
        }
        return send(
          res,
          200,
          addPublicCapabilities(renderArticle(db, JSON.parse(r.published)),{...features,analytics:features.analytics&&!optionalUser(req)}),
          "text/html; charset=utf-8",
        );
      }
      if (pathname === "/sitemap.xml")
        return send(res, 200, features.discovery?catalogSitemap(localPublishedRows(db)):sitemap(db), "application/xml; charset=utf-8");
      // Only explicit captured marketing assets are served. No directory traversal or source/database files.
      const staticMap = {
        "/": "evidence/live/index.html",
        "/app.js": "evidence/live/app.js",
        "/consent.js": "evidence/live/consent.js",
        "/style.css": "evidence/live/style.css",
        "/logo.svg": "evidence/live/logo.svg",
        "/llms.txt": "evidence/live/llms.txt",
        "/robots.txt": "evidence/live/robots.txt",
        "/resources/resources.css": "evidence/live/resources/resources.css",
        "/resources/resources.js": "evidence/live/resources/resources.js",
      };
      let file = staticMap[pathname];
      if (/^\/assets\/(day|night)-(768|1536)\.webp$/.test(pathname))
        file = "evidence/live" + pathname;
      if (
        [
          "/public/admin.css",
          "/public/admin.js",
          "/public/login.js",
          "/public/public.css",
          "/public/platform-admin.js",
          "/public/platform.css",
          "/public/resource-analytics.js",
          "/public/resource-assistant.js",
        ].includes(pathname)
      )
        file = pathname.slice(1);
      if (file && existsSync(resolve(root, file))) {
        const type =
          {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".svg": "image/svg+xml",
            ".webp": "image/webp",
            ".txt": "text/plain; charset=utf-8",
          }[extname(file)] || "application/octet-stream";
        const bytes = readFileSync(resolve(root, file));
        return send(
          res,
          200,
          pathname === "/resources/resources.css"
            ? Buffer.concat([
                bytes,
                Buffer.from("\n.resources-page footer{color:#42616d}\n"),
              ])
            : bytes,
          type,
        );
      }
      fail(404, "Not found");
    } catch (e) {
      if (res.headersSent) return res.end();
      const status = e.status || (e.code?.startsWith("ERR_SQLITE") ? 409 : 500);
      if (status === 500) console.error("CMS request failed:", e.message);
      send(res, status, {
        error: status === 500 ? "Request failed" : e.message,
      });
    }
  });
  server.on("close", () => {
    clearInterval(interval);
    db.close();
  });
  return { server, db, runScheduled };
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { server } = createCMS();
  server.listen(
    Number(process.env.PORT || 4173),
    process.env.HOST || "127.0.0.1",
    () =>
      console.log(
        "PoolDocAI CMS listening at " +
          (process.env.CMS_ORIGIN || "http://127.0.0.1:4173"),
      ),
  );
}
