import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AuthError, clearSessionCookies, parseCookies, requireOrigin, verifiedIdentity } from './auth.mjs';

export const VERIFIER = '__Host-cms-recovery-verifier';
export const ACCESS = '__Host-cms-recovery-access';
export const CSRF = '__Host-cms-recovery-csrf';
const cookie = (name, value, age, httpOnly = true) => `${name}=${encodeURIComponent(value)}; Path=/; Secure; SameSite=Lax; Max-Age=${age}${httpOnly ? '; HttpOnly' : ''}`;
const clear = () => [cookie(VERIFIER, '', 0), cookie(ACCESS, '', 0), cookie(CSRF, '', 0)];
const headers = () => new Headers({ 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
function answer(data, status = 200, cookies = [], redirect) {
  const h = headers(); for (const c of cookies) h.append('Set-Cookie', c);
  if (redirect) { h.set('Location', redirect); return new Response(null, { status: 303, headers: h }); }
  h.set('Content-Type', 'application/json'); return new Response(JSON.stringify(data), { status, headers: h });
}
async function body(request) {
  const raw = await request.text();
  if (Buffer.byteLength(raw) > 8192) throw new AuthError('Request rejected', 413);
  try { return JSON.parse(raw); } catch { throw new AuthError('Request rejected', 422); }
}

// Disabled unless both the immutable owner ID and owner address are configured.
// No database, membership, publication, or service-role capability is used here.
export function recoveryRoutes(config, fetchImpl = fetch) {
  const auth = { url: config.supabaseUrl, publishableKey: config.publishableKey, fetchImpl };
  const callback = `${config.origin}/admin/recovery/callback`;
  const enabled = /^[0-9a-f-]{36}$/i.test(config.recoveryOwnerId || '') && typeof config.recoveryOwnerEmail === 'string' && config.recoveryOwnerEmail.includes('@');
  async function upstream(path, payload, token) {
    return fetchImpl(new URL(path, config.supabaseUrl), { method: 'POST', headers: {
      apikey: config.publishableKey, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }, body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(8000) });
  }
  async function revoke(token) {
    if (!token) return;
    const r = await upstream('/auth/v1/logout?scope=local', undefined, token);
    if (!r.ok && r.status !== 401) throw new AuthError('Session cleanup failed', 503);
  }
  return async (request) => {
    const url = new URL(request.url), path = url.pathname;
    if (!enabled) return answer({ error: 'Recovery is not enabled' }, 503);
    if (path === '/api/recovery/request') {
      try {
        if (request.method !== 'POST') return answer({}, 405);
        requireOrigin(request, config.origin);
        const input = await body(request);
        if (String(input.email || '').trim().toLowerCase() !== config.recoveryOwnerEmail.toLowerCase()) return answer({ ok: true });
        const verifier = randomBytes(32).toString('base64url');
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        const r = await upstream(`/auth/v1/recover?redirect_to=${encodeURIComponent(callback)}`, {
          email: config.recoveryOwnerEmail, code_challenge: challenge, code_challenge_method: 's256',
        });
        if (!r.ok) return answer({ error: 'Recovery request unavailable; try later' }, r.status === 429 ? 429 : 503, clear());
        return answer({ ok: true }, 200, [cookie(VERIFIER, verifier, 900), cookie(ACCESS, '', 0), cookie(CSRF, '', 0)]);
      } catch (e) { return answer({ error: 'Recovery request rejected' }, e instanceof AuthError ? e.status : 503, clear()); }
    }
    if (path === '/admin/recovery/callback') {
      let token;
      try {
        if (request.method !== 'GET') return answer({}, 405);
        const verifier = parseCookies(request.headers.get('cookie'))[VERIFIER];
        const code = url.searchParams.get('code');
        if (!/^[A-Za-z0-9_-]{43}$/.test(verifier || '') || !code || code.length > 2048 || url.searchParams.has('error')) throw new AuthError('Recovery link rejected');
        const r = await upstream('/auth/v1/token?grant_type=pkce', { auth_code: code, code_verifier: verifier });
        if (!r.ok) throw new AuthError('Recovery link rejected');
        const session = await r.json(); token = session.access_token;
        const user = await verifiedIdentity(token, auth);
        if (user.id !== config.recoveryOwnerId || !Number.isFinite(session.expires_in) || session.expires_in <= 0) throw new AuthError('Recovery identity rejected');
        return answer(null, 200, [cookie(VERIFIER, '', 0), cookie(ACCESS, token, Math.min(600, Math.floor(session.expires_in))), cookie(CSRF, randomBytes(32).toString('base64url'), 600)], '/admin/reset-password');
      } catch {
        try { await revoke(token); } catch { return answer({ error: 'Recovery cleanup failed' }, 503, clear()); }
        return answer(null, 200, clear(), '/admin/recover?failed=1');
      }
    }
    if (path === '/api/recovery/password') {
      let updated = false;
      try {
        if (request.method !== 'POST') return answer({}, 405);
        requireOrigin(request, config.origin);
        const cookies = parseCookies(request.headers.get('cookie'));
        const expected = Buffer.from(cookies[CSRF] || ''), supplied = Buffer.from(request.headers.get('x-recovery-csrf') || '');
        if (!expected.length || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new AuthError('CSRF rejected', 403);
        const token = cookies[ACCESS], user = await verifiedIdentity(token, auth);
        if (user.id !== config.recoveryOwnerId) throw new AuthError('Recovery identity rejected', 403);
        const input = await body(request);
        if (typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 1024) throw new AuthError('Password does not meet length requirements', 422);
        const r = await fetchImpl(new URL('/auth/v1/user', config.supabaseUrl), {
          method: 'PUT', headers: { apikey: config.publishableKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: input.password }), signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) {
          const failure = await r.json().catch(() => ({}));
          const allowed = ['weak_password', 'same_password', 'reauthentication_needed', 'reauthentication_not_valid', 'session_not_found'];
          return answer({ error: 'Password update rejected by authentication service', code: allowed.includes(failure.error_code) ? failure.error_code : 'password_update_rejected' }, 422);
        }
        updated = true; await revoke(token);
        return answer({ ok: true }, 200, [...clear(), ...clearSessionCookies()]);
      } catch (e) {
        return answer({ error: updated ? 'Password updated; session cleanup could not be confirmed' : 'Password update rejected', passwordUpdated: updated }, e instanceof AuthError ? e.status : 503, clear());
      }
    }
    return answer({}, 404);
  };
}
