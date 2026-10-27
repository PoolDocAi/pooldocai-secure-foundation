import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMarketingCMSDelivery, liveNavigation } from '../api/cms-public.mjs';
import { PublicCMSDelivery } from '../src/production/public-delivery.mjs';

const id = '97e621c5-f2d3-4243-838c-64abaca547fc', revision = 'ba3e4305-2570-4195-8175-5c149b0fb937';
const original = readFileSync(new URL('../review-pages/pool-pump-wont-start/index.html', import.meta.url), 'utf8');
const body = original.split('<div class="article-body">')[1].split('</div><p class="article-note">')[0];
function fixture() {
  const state = { published: true, title: "Pool pump won't start: safe first checks", workingTitle: 'Private draft', fail: false };
  const client = new PublicCMSDelivery({ supabaseUrl: 'https://rzkgmvyyeclrpomrlyft.supabase.co', publishableKey: 'sb_publishable_test', fetchImpl: async (url, options) => {
    if (state.fail) throw Error('Server detail');
    const record = { id, slug: 'pool-pump-wont-start', revisionId: revision, state: 'draft', content: { slug: 'pool-pump-wont-start', title: state.title, summary: 'The original safe first checks.', body, legacyHtml: '<script>must not render</script>', seo: { title: state.title, description: 'Original summary', canonical: 'https://pooldocai.com/resources/pool-pump-wont-start/' } }, renderedHtml: body, publishedAt: '2026-10-25T12:00:00Z', updatedAt: '2026-10-25T12:00:00Z', categoryName: 'Troubleshooting Tips', tagIds: [], tag_names: [] };
    return Response.json(String(url).endsWith('/public_index') ? state.published ? [record] : [] : String(url).endsWith('/public_article') ? state.published && JSON.parse(options.body).p_slug === record.slug ? record : null : null);
  } });
  const app = createMarketingCMSDelivery({ client, preview: true });
  return { state, client, app, get: path => app(new Request('https://preview.vercel.app' + path)) };
}

test('real approved article shell, legal footer, canonical and technical content survive dynamic delivery', async () => {
  const { get } = fixture(); const response = await get('/resources/pool-pump-wont-start/'); const html = await response.text();
  assert.equal(response.status, 200); assert.match(html, /class="resources-page article-page"/); assert.match(html, /class="resource-shell"/);
  assert.match(html, /href="\/resource-design.css"/); assert.match(html, /class="article-layout"/); assert.match(html, /class="article-meta"/);
  assert.match(html, /https:\/\/pooldocai.com\/resources\/pool-pump-wont-start\//); assert.match(html, /Do not open a junction box or motor housing/);
  for (const href of ['/resources/', '/privacy.html', '/terms.html', 'mailto:hello@pooldocai.com']) assert.ok(html.includes(`href="${href}"`));
  assert.doesNotMatch(html, /must not render|Private draft/); assert.match(html, /noindex, nofollow/);
});

test('legacy fixture navigation UUIDs map to actual immutable CMS identity without changing folder IDs', async () => {
  const { client, get } = fixture(); const rows = await client.index();
  const nav = liveNavigation(rows.map(row => ({ id: row.id, slug: row.slug })));
  assert.ok(nav.memberships.some(member => member.articleId === id));
  assert.ok(nav.folders.some(folder => folder.url === '/resources/collections/explore-resources/learning-center/'));
  for (const suffix of ['', '/']) assert.equal((await get('/resources/collections/explore-resources/learning-center' + suffix)).status, 200);
  assert.equal((await get('/resources/collections/explore-resources/missing/')).status, 404);
  const legacyTagsPath = await (await get('/api/public/resources?path=whats-wrong')).json(); assert.equal(legacyTagsPath.total, 1); assert.equal(legacyTagsPath.items[0].tags.length, 0); // Folder routing does not invent facet tags.
});

test('dynamic Hub keeps approved branding and all three paths, and every Preview article link stays protected', async () => {
  const { get } = fixture(); const html = await (await get('/resources/')).text();
  for (const text of ['Know your pool.', 'What&#39;s Wrong?', 'Equipment &amp; Guides', 'Explore Resources', 'Privacy Policy', 'Terms of Service', 'Contact']) assert.ok(html.includes(text), text);
  assert.match(html, /href="\/resources\/pool-pump-wont-start\/"/);
  assert.doesNotMatch(html, /<a[^>]*href="https:\/\/pooldocai.com\/resources\/pool-pump-wont-start/);
  const api = await (await get('/api/public/resources')).json(); assert.equal(api.total, 1);
  assert.equal(api.items[0].url, '/resources/pool-pump-wont-start/'); assert.equal(api.items[0].canonicalUrl, 'https://pooldocai.com/resources/pool-pump-wont-start/');
});

test('same running handler updates public title after release, preserves private draft and withdraws cleanly', async () => {
  const { state, get } = fixture(); const before = await (await get('/resources/pool-pump-wont-start/')).text();
  state.workingTitle = 'Do not publish this'; assert.equal(await (await get('/resources/pool-pump-wont-start/')).text(), before);
  state.title = 'Owner explicitly published update'; assert.match(await (await get('/resources/pool-pump-wont-start/')).text(), /Owner explicitly published update/);
  state.published = false; assert.equal((await get('/resources/pool-pump-wont-start/')).status, 404);
  assert.equal((await (await get('/api/public/resources')).json()).total, 0);
  assert.doesNotMatch(await (await get('/resources-sitemap.xml')).text(), /pool-pump-wont-start/);
});

test('routing cutover has no stale static article fallback and retains old acceptance build', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.cms-preview.json', import.meta.url)));
  assert.ok(config.rewrites.some(r => r.source === '/resources/:articleSlug([a-z0-9-]+)/' && r.destination.includes('/api/cms-public')));
  assert.ok(config.rewrites.some(r => r.source === '/sitemap.xml' && r.destination.includes('/api/cms-public')));
  assert.ok(readFileSync(new URL('../scripts/build-cms-preview.mjs', import.meta.url), 'utf8').includes('rmSync(`public/resources/${slug}`'));
  assert.match(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'), /api\/review/);
  assert.match(readFileSync(new URL('../index.html', import.meta.url), 'utf8'), /class="footer-resources"/);
});
