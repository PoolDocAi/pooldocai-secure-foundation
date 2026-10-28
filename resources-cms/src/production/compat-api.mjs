import { randomUUID } from "node:crypto";
import { AuthError, CSRF_COOKIE, parseCookies, requireCsrf, requireOrigin } from "./auth.mjs";
import { normalizeArticleCommand } from "./validation.mjs";
import {readMediaRights,reviewMediaRights} from "./media-rights-review.mjs";
import {validateApprovedImport} from "./approved-import.mjs";
import {sanitize,safeURL} from '../content.mjs';

const json = (value, status = 200, headers = {}) => Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } });
async function body(request, maximum = 250_000) {
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maximum) throw Object.assign(new Error("Request too large"), { status: 413 });
  return text ? JSON.parse(text) : {};
}
function warningList(data) {
  const result = [];
  if (!data.summary) result.push("Missing summary");
  if (!data.seo?.title) result.push("Missing SEO title");
  if (!data.seo?.description) result.push("Missing meta description");
  if (!data.sources?.length) result.push("Missing source references");
  if (!String(data.body || "").replace(/<[^>]+>/g, "").trim()) result.push("Article body is empty");
  for (const tag of String(data.body || "").match(/<img\b[^>]*>/g) || []) if (!/\balt="[^"]+"/.test(tag)) result.push("Body image needs alt text");
  return result;
}
function formatted(row, knowledge = null) {
  const raw = row.editable || row.data || {};
  const data = {...raw,body:sanitize(raw.body||''),sources:(raw.sources||[]).filter(s=>safeURL(s.url,false))};
  return {
    id: row.id, slug: row.slug, status: row.state || row.status, data,
    version: row.version, created_at: row.created_at, updated_at: row.updated_at,
    scheduled_at: row.scheduled_at, published: Boolean(row.published_revision_id || row.published),
    warnings: [...warningList(data),...(row.editorial_hold?['Publication hold: '+row.editorial_hold]:[])],
    knowledge: knowledge || { status: "not_submitted", classification: "unverified_hypothesis" },
  };
}
function status(error) {
  if (error instanceof AuthError) return error.status;
  if (Number.isInteger(error?.status)) return error.status;
  if (/conflict|duplicate|idempotency/i.test(error?.message || "")) return 409;
  if (/required|rejected|invalid|missing|unsupported/i.test(error?.message || "")) return 422;
  if (/owner|editor|reviewer|authorization|permission/i.test(error?.message || "")) return 403;
  return 500;
}

export function compatibilityRoute({ db, identity, memberRole, origin, uploadRoute, approvedImports=null, ownerPublishing=false }) {
  return async (request) => {
    try {
      const url = new URL(request.url), path = url.pathname;
      if (request.method !== "GET") { requireOrigin(request, origin); requireCsrf(request); }
      const user = await identity(request), role = await memberRole(user);
      if (path === "/api/me" && request.method === "GET") return json({ id: user.id, email: user.email || "", role, ownerPublishing, approvedCollectionInstalled:Array.isArray(approvedImports), csrf: parseCookies(request.headers.get("cookie"))[CSRF_COOKIE] || null });
      if(path === "/api/approved-resources") {
        if(role!=="owner") return json({error:"Owner required"},403);
        if(!Array.isArray(approvedImports))return json({error:"Private approved collection is not installed"},503);
        if(request.method==="GET") return json(approvedImports.map(e=>({resourceId:e.resourceId,title:e.article.title,slug:e.article.slug,sourceIdentity:e.source.identity,sourceChecksum:e.source.sha256,assetStatus:e.assetStatus})));
        if(request.method==="POST") {
          const incoming=await body(request),selected=approvedImports.find(e=>e.source.identity===incoming.sourceIdentity&&e.source.sha256===incoming.sourceChecksum);
          if(!selected)return json({error:"Approved source not found"},404);
          const entry=validateApprovedImport(selected,approvedImports),result=await db.ownerImport(user,entry);
          return json(formatted(await db.read(user,result.id)),200);
        }
      }
      if (path === "/api/content" && request.method === "GET") {
        const [rows, statuses] = await Promise.all([db.list(user, { limit: 200 }), db.knowledgeStatuses(user)]);
        const map = new Map(statuses.map((item) => [item.article_id, item]));
        return json(rows.map((row) => formatted(row, map.get(row.id))));
      }
      if (["/api/content", "/api/import"].includes(path) && request.method === "POST") {
        const incoming = await body(request,2_000_000), value = path === "/api/import" ? incoming.article : incoming;
        if(path==="/api/import"&&incoming.format==="pooldocai-owner-import-v1") {
          if(role!=="owner")return json({error:"Owner required"},403);
          if(!Array.isArray(approvedImports))return json({error:"Private approved collection is not installed"},503);
          const entry=validateApprovedImport(incoming,approvedImports),result=await db.ownerImport(user,entry);
          return json(formatted(await db.read(user,result.id)),200);
        }
        if (path === "/api/import" && incoming.format !== "pooldocai-resource-v1") throw Object.assign(new Error("Invalid import format"), { status: 422 });
        const id = randomUUID();
        const result = await db.command(user, id, 0, "create", normalizeArticleCommand("create", value), randomUUID());
        return json(formatted({ ...result, editable: value }), 201);
      }
      const content = path.match(/^\/api\/content\/([0-9a-f-]{36})(?:\/([a-z-]+))?$/i);
      if (content) {
        const [, id, action] = content;
        if (!action && request.method === "GET") return json(formatted(await db.read(user, id)));
        if (!action && request.method === "PUT") {
          const incoming = await body(request), result = await db.command(user, id, incoming.version, "save", normalizeArticleCommand("save", incoming), randomUUID());
          return json(formatted(await db.read(user, result.id)));
        }
        if(action === "release" && request.method === "GET") {
          if(role!=="owner")return json({error:"Owner required"},403);
          if(!ownerPublishing)return json({error:"Owner publication gate is not installed"},503);
          return json(await db.releaseInfo(user,id));
        }
        if(action === "publish" && request.method === "POST" && ownerPublishing) {
          if(role!=="owner")return json({error:"Owner required"},403);
          const incoming=await body(request),result=await db.ownerPublish(user,id,incoming);
          return json(formatted(await db.read(user,result.id)));
        }
        if (action === "revisions" && request.method === "GET") return json((await db.revisions(user, id)).map((row) => ({ ...row, reason: "immutable_snapshot" })));
        if (request.method === "POST") {
          const incoming = await body(request), payload = action === "rollback" ? { revisionId: incoming.revisionId } : action === "schedule" ? { scheduledAt: incoming.scheduledAt } : action === "knowledge-approve" ? incoming : action === "knowledge-revoke" ? { reason: incoming.reason } : {};
          if (action === "duplicate") {
            const source = await db.read(user, id), newId = randomUUID();
            const duplicate = normalizeArticleCommand("create", { ...source.editable, title: `${source.editable.title} (Copy)`, slug: `${source.editable.slug.slice(0, 100)}-copy-${newId.slice(0, 8)}`, publishedAt: null });
            const created = await db.command(user, newId, 0, "create", duplicate, randomUUID());
            return json(formatted(await db.read(user, created.id)), 201);
          }
          const result = await db.command(user, id, incoming.version, action, payload, randomUUID());
          return json(formatted(await db.read(user, result.id)));
        }
      }
      if (path === "/api/taxonomy" && request.method === "GET") return json(await db.taxonomy(user));
      if (path === "/api/taxonomy" && request.method === "POST") { const incoming = await body(request); return json(await db.taxonomyCommand(user, 0, "create", incoming), 201); }
      const taxonomy = path.match(/^\/api\/taxonomy\/([0-9a-f-]{36})$/i);
      if (taxonomy && request.method === "PUT") {
        const incoming = await body(request), current = (await db.taxonomy(user)).find((item) => item.id === taxonomy[1]);
        if (!current) return json({ error: "Not found" }, 404);
        const action = incoming.mergeInto ? "merge" : incoming.archived === true ? "archive" : incoming.archived === false ? "restore" : Object.hasOwn(incoming, "name") ? "rename" : "reorder";
        const payload = { id: current.id, ...(action === "merge" ? { targetId: incoming.mergeInto } : action === "rename" ? { name: incoming.name } : action === "reorder" ? { position: incoming.position } : {}) };
        return json(await db.taxonomyCommand(user, current.version, action, payload));
      }
      if (path === "/api/media" && request.method === "GET") return json(await db.mediaList(user));
      if (path === "/api/media" && request.method === "POST") {
        const incoming = await body(request, 4_300_000);
        if (!incoming.base64 || !["image/jpeg","image/png","image/webp"].includes(incoming.mime)) throw Object.assign(new Error("Invalid image upload"), { status: 422 });
        const bytes = Buffer.from(incoming.base64, "base64");
        if (!bytes.length || bytes.length > 3 * 1024 * 1024) throw Object.assign(new Error("Image size rejected"), { status: 413 });
        const headers = new Headers(request.headers);
        headers.set("content-type", incoming.mime);
        headers.set("content-length", String(bytes.length));
        headers.set("x-file-name", encodeURIComponent(incoming.name || "image"));
        headers.set("x-image-alt", encodeURIComponent(incoming.alt || ""));
        return uploadRoute(new Request(request.url, { method: "POST", headers, body: bytes }));
      }
      const rights=path.match(/^\/api\/media\/([0-9a-f-]{36})\/rights$/i);
      if(rights){
        if(!ownerPublishing)return json({error:"Image rights review gate is not installed"},503);
        if(request.method==="GET")return json(await readMediaRights(db,user,rights[1]));
        if(request.method==="POST"){const incoming=await body(request,25000);return json(await reviewMediaRights(db,user,incoming.action,{...incoming,mediaId:rights[1]}));}
      }
      const media = path.match(/^\/api\/media\/([0-9a-f-]{36})$/i);
      if (media && request.method === "PUT") { const incoming = await body(request); return json(await db.mediaCommand(user, "update-alt", { id: media[1], alt: incoming.alt })); }
      if(media && request.method==="DELETE")return json(await db.mediaCommand(user,"archive",{id:media[1]}));
      if (path === "/api/settings" && request.method === "GET") return json({ ...(await db.settings(user)), permissions: { owner: ["write", "review", "publish", "knowledge"], editor: ["write"], reviewer: ["review", "knowledge"], viewer: ["read"] } });
      if (path === "/api/settings" && request.method === "PUT") return json(await db.settingsCommand(user, await body(request)));
      if (path === "/api/dashboard" && request.method === "GET") {
        const rows = await db.list(user, { limit: 200 }), counts = {};
        for (const state of ["published", "draft", "scheduled", "archived", "review", "approved", "deleted"]) counts[state] = rows.filter((row) => row.state === state).length;
        return json({ counts, warnings: rows.flatMap((row) => warningList(row.editable).map((message) => ({ id: row.id, title: row.editable.title, message }))), recent: await db.recentAudit(user) });
      }
      if (path === "/api/bulk/archive" && request.method === "POST") return json(await db.bulkArchive(user, (await body(request)).items));
      if (path === "/api/export" && request.method === "GET") return json(await db.exportAll(user), 200, { "Content-Disposition": 'attachment; filename="pooldocai-resources-backup.json"' });
      if (path === "/api/knowledge/export" && request.method === "GET") return json(await db.knowledgeExport(user), 200, { "Content-Disposition": 'attachment; filename="pooldocai-knowledge-export.json"' });
      return json({ error: "Not found" }, 404);
    } catch (error) {
      const code = status(error);
      if (code === 500) console.error("CMS compatibility route failed", { name: error?.name, code: error?.code });
      return json({ error: code === 500 ? "Request failed" : (error.message || "Request rejected") }, code);
    }
  };
}
