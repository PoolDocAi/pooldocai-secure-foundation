import { randomBytes, timingSafeEqual } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ACCESS_COOKIE = "__Host-pooldocai-cms-access";
export const REFRESH_COOKIE = "__Host-pooldocai-cms-refresh";
export const CSRF_COOKIE = "__Host-pooldocai-cms-csrf";

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

export function parseCookies(header = "") {
  const result = {};
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    try {
      result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      // Ignore malformed cookie fragments.
    }
  }
  return result;
}

function same(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export function requireOrigin(request, origin) {
  if (!origin || request.headers.get("origin") !== origin) {
    throw new AuthError("Origin rejected", 403);
  }
}

export function requireCsrf(request) {
  const cookies = parseCookies(request.headers.get("cookie"));
  if (!same(cookies[CSRF_COOKIE], request.headers.get("x-csrf-token"))) {
    throw new AuthError("CSRF rejected", 403);
  }
}

export function sessionToken(request) {
  const token = parseCookies(request.headers.get("cookie"))[ACCESS_COOKIE];
  if (!token || token.length > 8192) throw new AuthError("Authentication required");
  return token;
}

export async function verifiedIdentity(token, { url, publishableKey, fetchImpl = fetch }) {
  if (!token || token.length > 8192 || !url || !publishableKey) throw new AuthError("Authentication required");
  const response = await fetchImpl(new URL("/auth/v1/user", url), {
    headers: { Authorization: `Bearer ${token}`, apikey: publishableKey },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new AuthError("Authentication rejected");
  const user = await response.json();
  if (!UUID.test(String(user.id || "")) || user.is_anonymous) {
    throw new AuthError("Verified non-anonymous user required");
  }
  // Authorization deliberately ignores email and all user-editable metadata.
  return { id: user.id, email: typeof user.email === "string" ? user.email : "", sessionId: user.session_id || null };
}

export async function signInWithPassword(email, password, { url, publishableKey, fetchImpl = fetch }) {
  const normalized = String(email || "").trim().toLowerCase();
  if (normalized.length > 320 || !normalized.includes("@") || String(password || "").length > 1024) {
    throw new AuthError("Invalid credentials");
  }
  const response = await fetchImpl(new URL("/auth/v1/token?grant_type=password", url), {
    method: "POST",
    headers: { apikey: publishableKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email: normalized, password: String(password || "") }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new AuthError("Invalid credentials");
  const session = await response.json();
  if (!session.access_token || !session.refresh_token || !Number.isFinite(session.expires_in)) {
    throw new AuthError("Invalid authentication response");
  }
  const identity = await verifiedIdentity(session.access_token, { url, publishableKey, fetchImpl });
  return { ...session, identity };
}

export async function revokeSession(token, { url, publishableKey, fetchImpl = fetch }) {
  if (!token) return;
  const response = await fetchImpl(new URL("/auth/v1/logout?scope=local", url), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, apikey: publishableKey },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok && response.status !== 401) throw new AuthError("Logout failed", 503);
}

export async function refreshSession(refreshToken, { url, publishableKey, fetchImpl = fetch }) {
  if (!refreshToken || refreshToken.length > 8192) throw new AuthError("Refresh rejected");
  const response = await fetchImpl(new URL("/auth/v1/token?grant_type=refresh_token", url), {
    method: "POST",
    headers: { apikey: publishableKey, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new AuthError("Refresh rejected");
  const session = await response.json();
  if (!session.access_token || !session.refresh_token || !Number.isFinite(session.expires_in)) throw new AuthError("Invalid refresh response");
  const identity = await verifiedIdentity(session.access_token, { url, publishableKey, fetchImpl });
  return { ...session, identity };
}

export function refreshToken(request) {
  const token = parseCookies(request.headers.get("cookie"))[REFRESH_COOKIE];
  if (!token || token.length > 8192) throw new AuthError("Refresh required");
  return token;
}

const cookie = (name, value, { maxAge, httpOnly = true } = {}) =>
  `${name}=${encodeURIComponent(value)}; Path=/; Secure; SameSite=Strict${httpOnly ? "; HttpOnly" : ""}${Number.isFinite(maxAge) ? `; Max-Age=${Math.max(0, Math.floor(maxAge))}` : ""}`;

export function sessionCookies(session) {
  const csrf = randomBytes(32).toString("base64url");
  return {
    csrf,
    headers: [
      cookie(ACCESS_COOKIE, session.access_token, { maxAge: session.expires_in }),
      cookie(REFRESH_COOKIE, session.refresh_token, { maxAge: 60 * 60 * 24 * 30 }),
      cookie(CSRF_COOKIE, csrf, { maxAge: session.expires_in, httpOnly: false }),
    ],
  };
}

export function clearSessionCookies() {
  return [
    cookie(ACCESS_COOKIE, "", { maxAge: 0 }),
    cookie(REFRESH_COOKIE, "", { maxAge: 0 }),
    cookie(CSRF_COOKIE, "", { maxAge: 0, httpOnly: false }),
  ];
}

export async function membership(db, id, allowed = ["owner", "editor", "reviewer", "viewer"]) {
  const actorId = typeof id === "object" ? id?.id : id;
  if (!UUID.test(String(actorId || ""))) throw new AuthError("CMS membership denied", 403);
  if (typeof db.memberRole === "function") {
    const role = await db.memberRole(id);
    if (!allowed.includes(role)) throw new AuthError("CMS membership denied", 403);
    return role;
  }
  return db.transaction(actorId, async (client) => {
    const result = await client.query("SELECT role FROM resources_cms.members WHERE user_id=$1 AND active=true", [actorId]);
    const role = result.rows[0]?.role;
    if (!allowed.includes(role)) throw new AuthError("CMS membership denied", 403);
    return role;
  }, { readOnly: true });
}

// No fallback to the general query RPC: a missing bootstrap deployment fails closed.
export async function mfaMembership(db, user, { bootstrap = false } = {}) {
  if (!UUID.test(String(user?.id || "")) || !user?.accessToken) throw new AuthError("CMS membership denied", 403);
  const method = bootstrap ? "mfaBootstrapRole" : "mfaPrivateRole";
  if (typeof db[method] !== "function") throw new AuthError("MFA authorization unavailable", 503);
  let role;
  try { role = await db[method](user); }
  catch (error) {
    throw new AuthError("MFA authorization rejected", [401,403].includes(error?.status) || error?.code === "42501" ? 403 : 503);
  }
  if (!["owner", "editor", "reviewer", "viewer"].includes(role)) throw new AuthError("CMS membership denied", 403);
  return role;
}
