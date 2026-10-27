import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { recoveryRoutes, VERIFIER, ACCESS, CSRF } from '../src/production/recovery.mjs';
import { loginRoute } from '../src/production/serverless.mjs';
const id = '4ab7d56e-57f4-4aed-9244-26ee801afab2';
const config = { origin: 'https://cms.example', supabaseUrl: 'https://staging.example', publishableKey: 'publishable', recoveryOwnerId: id, recoveryOwnerEmail: 'support@pooldocai.com' };
const request = (path, body, extra = {}) => new Request(config.origin + path, { method: 'POST', headers: { origin: config.origin, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
const callback = () => new Request(config.origin + '/admin/recovery/callback?code=one-time', { headers: { cookie: `${VERIFIER}=${'a'.repeat(43)}` } });
const password = (pw = 'synthetic-password-only', extra = {}) => request('/api/recovery/password', { password: pw }, { cookie: `${ACCESS}=synthetic-access; ${CSRF}=test-csrf`, 'x-recovery-csrf': 'test-csrf', ...extra });

test('verified owner bootstrap evidence contains UUID only and cannot grant CMS access', async () => {
  let evidence;
  const route = loginRoute({ origin: config.origin,
    signIn: async () => ({ identity: { id }, access_token: 'synthetic-secret', refresh_token: 'synthetic-refresh', expires_in: 300 }),
    memberRole: async () => { throw new Error('CMS membership denied'); },
    onIdentityVerified: data => { evidence = data; },
  });
  const r = await route(request('/api/login', { email: config.recoveryOwnerEmail, password: 'synthetic-only' }));
  assert.deepEqual(evidence, { id }); assert.equal(r.status, 403);
  assert.equal(r.headers.get('set-cookie'), null);
  assert.doesNotMatch(await r.text(), /synthetic-secret|synthetic-refresh/);
});

test('recovery is disabled without explicit owner configuration', async () => {
  const r = await recoveryRoutes({ ...config, recoveryOwnerId: undefined }, () => { throw Error('unexpected'); })(request('/api/recovery/request', {}));
  assert.equal(r.status, 503);
});
test('recovery request binds PKCE to fixed owner and callback, using secure verifier cookie', async () => {
  let call;
  const route = recoveryRoutes(config, async (url, options) => { call = { url, options }; return Response.json({}); });
  const r = await route(request('/api/recovery/request', { email: 'support@pooldocai.com', redirectTo: 'https://evil.example' }));
  assert.equal(r.status, 200);
  const cookies = r.headers.getSetCookie();
  const verifier = cookies.find(c => c.startsWith(VERIFIER + '=')).split(';')[0].split('=')[1];
  const data = JSON.parse(call.options.body);
  assert.equal(data.code_challenge, createHash('sha256').update(verifier).digest('base64url'));
  assert.equal(data.code_challenge_method, 's256');
  assert.equal(call.url.searchParams.get('redirect_to'), config.origin + '/admin/recovery/callback');
  assert.match(cookies[0], /Secure; SameSite=Lax; Max-Age=900; HttpOnly/);
  assert.deepEqual(await r.json(), { ok: true });
});
test('ineligible address creates no mail request and has generic response', async () => {
  let calls = 0;
  const r = await recoveryRoutes(config, async () => { calls++; })(request('/api/recovery/request', { email: 'other@example.com' }));
  assert.equal(calls, 0); assert.deepEqual(await r.json(), { ok: true });
});
test('cross-origin recovery requests fail before Auth call', async () => {
  const r = await recoveryRoutes(config, () => { throw Error('unexpected'); })(request('/api/recovery/request', { email: config.recoveryOwnerEmail }, { origin: 'https://evil.example' }));
  assert.equal(r.status, 403);
});
test('email provider failure cannot report successful dispatch', async () => {
  const r = await recoveryRoutes(config, async () => Response.json({}, { status: 500 }))(request('/api/recovery/request', { email: config.recoveryOwnerEmail }));
  assert.equal(r.status, 503); assert.equal((await r.json()).ok, undefined);
});
test('callback without verifier fails closed without exchanging code', async () => {
  const r = await recoveryRoutes(config, () => { throw Error('unexpected'); })(new Request(config.origin + '/admin/recovery/callback?code=x'));
  assert.equal(r.headers.get('location'), '/admin/recover?failed=1');
});
test('valid callback verifies immutable user ID and never creates CMS session cookies', async () => {
  const calls = [];
  const r = await recoveryRoutes(config, async (url, options) => {
    calls.push([url, options]);
    return url.pathname.endsWith('/token') ? Response.json({ access_token: 'synthetic-access', expires_in: 3600 }) : Response.json({ id, email: config.recoveryOwnerEmail });
  })(callback());
  assert.equal(r.status, 303); assert.equal(r.headers.get('location'), '/admin/reset-password');
  assert.equal(calls[0][0].search, '?grant_type=pkce');
  assert.equal(calls[1][0].pathname, '/auth/v1/user');
  assert.match(r.headers.get('set-cookie'), /__Host-cms-recovery-access=/);
  assert.doesNotMatch(r.headers.get('set-cookie'), /__Host-pooldocai-cms-access=/);
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
});
test('wrong callback identity revokes only recovery session and grants no cookie', async () => {
  const calls = [];
  const r = await recoveryRoutes(config, async (url) => {
    calls.push(url);
    if (url.pathname.endsWith('/token')) return Response.json({ access_token: 'wrong-user', expires_in: 300 });
    if (url.pathname.endsWith('/logout')) return Response.json({});
    return Response.json({ id: '00000000-0000-4000-8000-000000000001' });
  })(callback());
  assert.equal(r.headers.get('location'), '/admin/recover?failed=1');
  assert.equal(calls.at(-1).search, '?scope=local');
  assert.doesNotMatch(r.headers.get('set-cookie'), /wrong-user/);
});
test('password update requires recovery CSRF and current verified owner', async () => {
  const route = recoveryRoutes(config, () => { throw Error('unexpected'); });
  assert.equal((await route(password('synthetic-password-only', { 'x-recovery-csrf': 'wrong' }))).status, 403);
});
test('password policy cannot be weakened by local validation', async () => {
  let updates = 0;
  const route = recoveryRoutes(config, async (_url, options) => {
    if (options.method === 'PUT') updates++;
    return Response.json({ id });
  });
  assert.equal((await route(password('short'))).status, 422); assert.equal(updates, 0);
});
test('password update forwards only password, revokes local session, and clears cookies', async () => {
  const calls = [];
  const r = await recoveryRoutes(config, async (url, options) => { calls.push([url, options]); return Response.json({ id }); })(password());
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(calls.find(c => c[1].method === 'PUT')[1].body), { password: 'synthetic-password-only' });
  assert.equal(calls.at(-1)[0].search, '?scope=local');
  assert.ok(r.headers.getSetCookie().every(c => c.includes('Max-Age=0')));
  assert.deepEqual(await r.json(), { ok: true });
});
test('password update failure never reports success or revokes unrelated sessions', async () => {
  const r = await recoveryRoutes(config, async (_url, options) => options.method === 'PUT' ? Response.json({ error_code: 'weak_password', message: 'untrusted upstream detail' }, { status: 422 }) : Response.json({ id }))(password());
  assert.equal(r.status, 422); const result = await r.json(); assert.equal(result.ok, undefined);
  assert.equal(result.code, 'weak_password'); assert.doesNotMatch(JSON.stringify(result), /untrusted upstream detail/);
});
test('partial password success and logout failure is explicitly surfaced', async () => {
  const r = await recoveryRoutes(config, async (url) => url.pathname.endsWith('/logout') ? Response.json({}, { status: 503 }) : Response.json({ id }))(password());
  assert.equal(r.status, 503); assert.equal((await r.json()).passwordUpdated, true);
});
