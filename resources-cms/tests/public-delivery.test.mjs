import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PublicCMSDelivery, createPublicDelivery } from '../src/production/public-delivery.mjs';

const ID = 'ad286da3-50ee-4b74-a4e9-1dce14d1a151', REV1 = 'bd286da3-50ee-4b74-a4e9-1dce14d1a151', REV2 = 'cd286da3-50ee-4b74-a4e9-1dce14d1a151';
const escape = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
function fixture() {
  const state = { published: true, outage: false, publishedRevision: REV1, publishedTitle: 'Original approved pool guide', workingTitle: 'Original approved pool guide', requests: [] };
  const record = () => ({ id: ID, slug: 'pool-pump-wont-start', revisionId: state.publishedRevision, state: 'draft', version: 9, working_revision_id: REV2,
    content: { slug: 'pool-pump-wont-start', title: state.publishedTitle, summary: 'The approved public summary', body: '<p>Safe published text.</p>', sourceProvenance: { secret: 'must never be serialized' }, seo: { canonical: 'https://pooldocai.com/resources/pool-pump-wont-start/' } },
    renderedHtml: '<p>Safe published text.</p>', publishedAt: '2026-10-25T10:00:00Z', updatedAt: '2026-10-25T10:00:00Z', tagIds: [], categoryName: 'Troubleshooting', private_value: 'must not leak',
  });
  const client = new PublicCMSDelivery({ supabaseUrl: 'https://rzkgmvyyeclrpomrlyft.supabase.co', publishableKey: 'sb_publishable_test-only', fetchImpl: async (url, options) => {
    state.requests.push({ url: String(url), options });
    if (state.outage) throw new Error('Internal failure including privileged diagnostic details');
    const name = String(url).split('/').at(-1), payload = JSON.parse(options.body);
    if (name === 'public_index') return Response.json(state.published ? [record()] : []);
    if (name === 'public_article') return Response.json(state.published && payload.p_slug === 'pool-pump-wont-start' ? record() : null);
    if (name === 'public_redirect') return Response.json(payload.p_slug === 'former-pump-guide' ? 'pool-pump-wont-start' : null);
    throw new Error('Unexpected RPC');
  } });
  const app = createPublicDelivery({ client,
    renderArticle: row => `<!doctype html><title>${escape(row.content.title)}</title><link rel="canonical" href="${row.canonical}"><p>${escape(row.revisionId)}</p>${row.renderedHtml}`,
    renderHub: rows => `<!doctype html><h1>Approved marketing design</h1>${rows.map(r => `<a href="${r.url}">${escape(r.title)}</a>`).join('')}`,
    renderCollection: (rows, params, path) => path === '/resources/collections/explore-resources/learning-center/' && rows.length ? '<h1>Published learning collection</h1>' : null,
    renderSitemap: rows => `<?xml version="1.0"?><urlset>${rows.map(r => `<url><loc>${r.canonical}</loc></url>`).join('')}</urlset>`,
    discover: rows => ({ total: rows.length, items: rows }),
  });
  const get = (path, options = {}) => app(new Request(`https://marketing-preview.vercel.app${path}`, options));
  return { state, client, get };
}

test('draft saves leave public revision, article HTML and discovery unchanged without rebuilding', async () => {
  const { state, get } = fixture();
  const before = await (await get('/resources/pool-pump-wont-start/')).text();
  state.workingTitle = 'PRIVATE EDIT MUST NEVER LEAK';
  const after = await (await get('/resources/pool-pump-wont-start/')).text();
  assert.equal(after, before);
  assert.match(after, /Original approved pool guide/);
  assert.doesNotMatch(after, /PRIVATE|working_revision_id/);
  const index = await (await get('/api/public/resources')).json();
  assert.equal(index.items[0].title, state.publishedTitle);
  assert.doesNotMatch(JSON.stringify(index), /sourceProvenance|private_value|working_revision_id|secret/);
});

test('published pointer changes update the same handler immediately; withdrawal never serves stale content', async () => {
  const { state, get } = fixture();
  assert.match(await (await get('/resources/pool-pump-wont-start/')).text(), /Original approved/);
  state.publishedRevision = REV2; state.publishedTitle = 'Explicitly released new revision';
  const published = await get('/resources/pool-pump-wont-start/');
  assert.equal(published.status, 200); assert.match(await published.text(), /Explicitly released new revision/);
  assert.equal(published.headers.get('cache-control'), 'no-store');
  assert.equal(published.headers.get('vercel-cdn-cache-control'), 'no-store');
  assert.match(await (await get('/resources/')).text(), /Explicitly released new revision/);
  state.published = false;
  assert.equal((await get('/resources/pool-pump-wont-start/')).status, 404);
  assert.equal((await (await get('/api/public/resources')).json()).total, 0);
  assert.doesNotMatch(await (await get('/resources-sitemap.xml')).text(), /pool-pump-wont-start/);
  assert.doesNotMatch(await (await get('/llms.txt')).text(), /pool-pump-wont-start/);
});

test('visitor cookies, owner JWTs, spoofed identities and arbitrary RPCs never reach the public source', async () => {
  const { state, client, get } = fixture();
  await get('/resources/pool-pump-wont-start/', { headers: { Cookie: 'cms_access_token=private-owner-token', Authorization: 'Bearer forged-owner', 'X-User-Id': ID } });
  assert.ok(state.requests.length);
  for (const { url, options } of state.requests) {
    assert.match(url, /^https:\/\/rzkgmvyyeclrpomrlyft\.supabase\.co\/rest\/v1\/rpc\/public_/);
    assert.equal(options.headers.Authorization, 'Bearer sb_publishable_test-only');
    assert.equal(options.headers.Cookie, undefined); assert.equal(options.headers['X-User-Id'], undefined);
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
  }
  await assert.rejects(client.rpc('dispatch', {}), /Public RPC unavailable/);
  assert.equal(await get('/api/cms/command'), null);
  assert.equal(await get('/preview/' + ID), null);
});

test('upstream failure is a controlled retryable 503 without stale article fallback or secret details', async () => {
  const { state, get } = fixture();
  await get('/resources/pool-pump-wont-start/'); state.outage = true;
  const response = await get('/resources/pool-pump-wont-start/');
  assert.equal(response.status, 503); assert.equal(response.headers.get('retry-after'), '10');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.doesNotMatch(await response.text(), /Original approved|privileged|Internal failure/);
  assert.equal(await get('/'), null); // Static marketing homepage continues on its existing route.
});

test('both collection URL forms use the same published-only renderer and nonexistent collections are 404', async () => {
  const { state, get } = fixture();
  for (const suffix of ['', '/']) assert.equal((await get('/resources/collections/explore-resources/learning-center' + suffix)).status, 200);
  assert.equal((await get('/resources/collections/explore-resources/not-real/')).status, 404);
  state.published = false;
  assert.equal((await get('/resources/collections/explore-resources/learning-center/')).status, 404);
});

test('canonical redirects validate live targets, never redirect to withdrawn resources or external URLs', async () => {
  const { state, get } = fixture();
  const slashless = await get('/resources/pool-pump-wont-start');
  assert.equal(slashless.status, 308); assert.equal(slashless.headers.get('location'), '/resources/pool-pump-wont-start/');
  const former = await get('/resources/former-pump-guide/');
  assert.equal(former.status, 308); assert.equal(former.headers.get('location'), '/resources/pool-pump-wont-start/');
  state.published = false;
  assert.equal((await get('/resources/former-pump-guide/')).status, 404);
});

test('sitemaps, HEAD and Preview noindex work and public routes cannot mutate publication', async () => {
  const { get, state } = fixture();
  const xml = await get('/resources-sitemap.xml');
  const llms = await get('/llms.txt'); assert.equal(llms.headers.get('content-type'), 'text/plain; charset=utf-8'); assert.match(await llms.text(), /https:\/\/pooldocai.com\/resources\/pool-pump-wont-start\//);
  assert.equal(xml.headers.get('content-type'), 'application/xml; charset=utf-8');
  assert.match(await xml.text(), /https:\/\/pooldocai\.com\/resources\/pool-pump-wont-start\//);
  const head = await get('/resources/pool-pump-wont-start/', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  assert.match(head.headers.get('x-robots-tag'), /noindex/);
  const count = state.requests.length;
  const rejected = await get('/api/public/resources', { method: 'POST', body: '{"action":"publish"}' });
  assert.equal(rejected.status, 405); assert.equal(state.requests.length, count);
});

test('privileged credentials, wrong upstreams, malformed public records and oversized responses fail closed', async () => {
  const options = { supabaseUrl: 'https://rzkgmvyyeclrpomrlyft.supabase.co', publishableKey: 'sb_publishable_test-only' };
  for (const publishableKey of ['sb_secret_no', 'random', `header.${Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url')}.signature`]) assert.throws(() => new PublicCMSDelivery({ ...options, publishableKey }), /publishable key/);
  assert.throws(() => new PublicCMSDelivery({ ...options, supabaseUrl: 'https://private-cms.vercel.app' }), /Supabase project/);
  assert.throws(() => new PublicCMSDelivery({ ...options, publicOrigin: 'https://pooldocai.com/path' }), /HTTPS origin/);
  const bad = new PublicCMSDelivery({ ...options, fetchImpl: async () => Response.json([{ id: ID, revision_id: REV1, slug: 'private', content: { title: 'Private', slug: 'private', seo: { canonical: 'https://evil.example/private/' } } }]) });
  await assert.rejects(bad.index(), /temporarily unavailable/);
  const huge = new PublicCMSDelivery({ ...options, maximumBytes: 1000, fetchImpl: async () => Response.json({ body: 'x'.repeat(2000) }) });
  await assert.rejects(huge.index(), /temporarily unavailable/);
});

test('public media rechecks published authorization and serves only exact canonical checksum bytes', async () => {
  const bytes = Buffer.from('RIFF----WEBPtest'); // Mock byte envelope, not an upload/image-validation test.
  const checksum = createHash('sha256').update(bytes).digest('hex'), requests = [];
  let withdrawn = false, wrongHash = false, wrongPath = false;
  const client = new PublicCMSDelivery({ supabaseUrl: 'https://rzkgmvyyeclrpomrlyft.supabase.co', publishableKey: 'sb_publishable_test', fetchImpl: async (url, options) => {
    requests.push({ url: String(url), headers: options.headers });
    if (String(url).includes('/rpc/')) return Response.json(withdrawn ? null : { id: ID, objectKey: wrongPath ? 'tenant/private-manual.pdf' : `images/${ID}.webp`, mime: 'image/webp', sizeBytes: bytes.length, checksum: wrongHash ? '0'.repeat(64) : checksum });
    return new Response(bytes, { headers: { 'Content-Type': 'image/webp' } });
  } });
  const f = fixture(); f.client.media = client.media.bind(client);
  const response = await f.get('/media/' + ID);
  assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-security-policy'), /sandbox/);
  assert.ok(requests.some(r => r.url.endsWith(`/storage/v1/object/resources-cms-media/images/${ID}.webp`)));
  assert.equal(requests.at(-1).headers.Authorization, undefined);
  wrongHash = true; assert.equal((await f.get('/media/' + ID)).status, 404);
  wrongHash = false; wrongPath = true; const before = requests.length; assert.equal((await f.get('/media/' + ID)).status, 404); assert.equal(requests.length, before + 1);
  wrongPath = false; withdrawn = true; assert.equal((await f.get('/media/' + ID)).status, 404);
});
