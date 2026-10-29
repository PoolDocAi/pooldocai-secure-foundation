import {
  AuthError,
  clearSessionCookies,
  requireCsrf,
  requireOrigin,
  refreshSession,
  refreshToken,
  revokeSession,
  sessionCookies,
  sessionToken,
} from "./auth.mjs";
import { normalizeArticleCommand } from "./validation.mjs";
import { randomUUID } from "node:crypto";
import { mediaGateway, safeMediaName } from "./storage.mjs";

function responseError(error) {
  if (error instanceof AuthError) return error.status;
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 600) return error.status;
  if (error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) return 422;
  if (/revision conflict|idempotency key reuse/i.test(error?.message || "")) return 409;
  if (/authorization|owner required|reviewer required|editor required|membership denied/i.test(error?.message || "")) return 403;
  return 500;
}

async function json(request, maximum = 250_000) {
  const text = await request.text();
  if (!text || Buffer.byteLength(text, "utf8") > maximum) throw new RangeError("Request body rejected");
  return JSON.parse(text);
}

function withCookies(body, cookies, status = 200) {
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(JSON.stringify(body), { status, headers });
}

export function loginRoute({ origin, signIn, memberRole, onIdentityVerified = () => {} }) {
  return async (request) => {
    try {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      requireOrigin(request, origin);
      const body = await json(request, 8_192);
      const session = await signIn(body.email, body.password);
      // Emit no credentials/tokens. This allows bootstrap verification before
      // the first owner membership exists; it does not grant access.
      onIdentityVerified({ id: session.identity.id });
      const role = await memberRole({ ...session.identity, accessToken: session.access_token });
      const cookies = sessionCookies(session);
      return withCookies({ id: session.identity.id, email: session.identity.email, role, csrf: cookies.csrf }, cookies.headers);
    } catch (error) {
      return Response.json({ error: "Login rejected" }, { status: responseError(error), headers: { "Cache-Control": "no-store" } });
    }
  };
}

export function logoutRoute({ origin, authConfig }) {
  return async (request) => {
    try {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      requireOrigin(request, origin);
      requireCsrf(request);
      await revokeSession(sessionToken(request), authConfig);
      return withCookies({ ok: true }, clearSessionCookies());
    } catch (error) {
      return withCookies({ ok: false }, clearSessionCookies(), responseError(error));
    }
  };
}

export function refreshRoute({ origin, authConfig, memberRole }) {
  return async (request) => {
    try {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      requireOrigin(request, origin);
      requireCsrf(request);
      const session = await refreshSession(refreshToken(request), authConfig);
      const role = await memberRole({ ...session.identity, accessToken: session.access_token });
      const cookies = sessionCookies(session);
      return withCookies({ id: session.identity.id, email: session.identity.email, role, csrf: cookies.csrf }, cookies.headers);
    } catch (error) {
      return withCookies({ error: "Session refresh rejected" }, clearSessionCookies(), responseError(error));
    }
  };
}

export function commandRoute({ identity, db, origin }) {
  return async (request) => {
    try {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      requireOrigin(request, origin);
      requireCsrf(request);
      const user = await identity(request);
      const { commandId, id, version, action, payload } = await json(request);
      const previous = action === 'save' ? await db.read(user,id) : null;
      const normalized = normalizeArticleCommand(action, payload, previous?.editable);
      const result = await db.command(user, id, version, action, normalized, commandId);
      return Response.json(result, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      const status = responseError(error);
      if (status === 500) console.error("CMS command failed", { name: error?.name, code: error?.code });
      return Response.json({ error: status === 500 ? "Command failed" : "Command rejected" }, {
        status,
        headers: { "Cache-Control": "no-store" },
      });
    }
  };
}

export function scheduleRoute({ secret, runDue }) {
  return async (request) => {
    try {
      if (request.method !== "GET" && request.method !== "POST") return new Response(null, { status: 405 });
      if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return new Response(null, { status: 401 });
      const result = await runDue();
      return Response.json({ ok: true, result }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      console.error("CMS scheduled publication failed", { name: error?.name, code: error?.code });
      return Response.json({ ok: false }, { status: 500, headers: { "Cache-Control": "no-store" } });
    }
  };
}

export function mediaUploadRoute({ identity, db, storage, origin }) {
  return async (request) => {
    const id = randomUUID();
    let uploaded = false;
    let token;
    try {
      if (request.method !== "POST") return new Response(null, { status: 405 });
      requireOrigin(request, origin);
      requireCsrf(request);
      token = sessionToken(request);
      const user = await identity(request);
      const name = safeMediaName(decodeURIComponent(request.headers.get("x-file-name") || ""));
      const alt = decodeURIComponent(request.headers.get("x-image-alt") || "").trim().slice(0, 300);
      const length = Number(request.headers.get("content-length") || 0);
      if (length && (!Number.isFinite(length) || length > 4 * 1024 * 1024)) throw new RangeError("Upload size rejected");
      const bytes = await request.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > 4 * 1024 * 1024) throw new RangeError("Upload size rejected");
      const image = await storage.upload(id, token, bytes);
      uploaded = true;
      const result = await db.mediaCommand(user, "register", {
        id, name, alt, mime: image.mime, sizeBytes: image.bytes.byteLength,
        objectKey: `images/${id}.webp`, checksum: image.checksum,
      });
      return Response.json(result, { status: 201, headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (uploaded) {
        try { await storage.remove(id, token); } catch (cleanupError) { console.error("CMS media orphan cleanup failed", { id, code: cleanupError?.code }); }
      }
      const status = responseError(error);
      return Response.json({ error: status === 500 ? "Upload failed" : "Upload rejected" }, { status, headers: { "Cache-Control": "no-store" } });
    }
  };
}

export function mediaReadRoute({ identity, db, storage }) {
  return async (request, id) => {
    try {
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
      const published = await db.publicMedia(id);
      if (published) return mediaGateway(id, {
        authorize: async () => published,
        readPrivate: async () => storage.downloadPublic(id),
        published: true,
        etag: published.checksum,
      });
      const token = sessionToken(request);
      const user = await identity(request);
      const privateRecord = await db.media(user, id);
      return mediaGateway(id, {
        authorize: async () => privateRecord,
        readPrivate: async () => storage.download(id, token),
        etag: privateRecord?.checksum,
      });
    } catch (error) {
      const status = error instanceof AuthError ? error.status : 404;
      return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
    }
  };
}

export function healthRoute({ db }) {
  return async (request) => {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    try {
      await db.publicIndex();
      return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return Response.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
  };
}
