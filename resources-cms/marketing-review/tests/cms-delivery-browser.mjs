import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { PublicCMSDelivery } from '../src/production/public-delivery.mjs';
import { createMarketingCMSDelivery } from '../api/cms-public.mjs';

const fixtureCatalog = JSON.parse(readFileSync('live-catalog.json', 'utf8'));
const identity = { 'pool-pump-wont-start': '97e621c5-f2d3-4243-838c-64abaca547fc', 'green-pool-first-checks': '4beb45f7-5768-422f-99a8-04d06d93c82d' };
const rows = fixtureCatalog.map(row => {
  const html = readFileSync(`review-pages/${row.slug}/index.html`, 'utf8');
  const body = html.split('<div class="article-body">')[1].split('</div><p class="article-note">')[0];
  return { id: identity[row.slug], slug: row.slug, revisionId: row.revisionId, content: { title: row.title, slug: row.slug, summary: row.summary, body, seo: { title: row.title, description: row.summary, canonical: row.url } }, renderedHtml: body, categoryName: html.match(/<p class="section-kicker">([^<]+)<\/p>/)?.[1] || 'Resources', tagIds: row.tagIds, tag_names: row.tags.map(t => t.name), publishedAt: '2026-10-25T12:00:00Z', updatedAt: '2026-10-25T12:00:00Z' };
});
const client = new PublicCMSDelivery({ supabaseUrl: 'https://rzkgmvyyeclrpomrlyft.supabase.co', publishableKey: 'sb_publishable_local-browser-test', fetchImpl: async (url, options) => {
  const name = String(url).split('/').at(-1), body = JSON.parse(options.body);
  return Response.json(name === 'public_index' ? rows : name === 'public_article' ? rows.find(r => r.slug === body.p_slug) || null : null);
} });
const app = createMarketingCMSDelivery({ client, preview: true }), root = resolve('public');
const server = createServer(async (req, res) => {
  try {
    const result = await app(new Request('http://127.0.0.1:4317' + req.url, { method: req.method }));
    if (result) { res.writeHead(result.status, Object.fromEntries(result.headers)); return res.end(Buffer.from(await result.arrayBuffer())); }
    let path = new URL(req.url, 'http://127.0.0.1:4317').pathname.replace(/^\/public\//, '/'); if (path.endsWith('/')) path += 'index.html';
    const file = resolve(root, '.' + path);
    if (!file.startsWith(root + '/') || !existsSync(file)) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp' })[extname(file)] || 'application/octet-stream'); res.end(readFileSync(file));
  } catch { res.writeHead(500); res.end(); }
});
await new Promise(r => server.listen(4317, '127.0.0.1', r));
const browser = await chromium.launch({ executablePath: resolve('../../browser-runtime/chromium'), args: ['--no-sandbox'] });
const checks = [], errors = [], dir = resolve('../../evidence'); mkdirSync(dir, { recursive: true });
try {
  const context = await browser.newContext(), page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
  await page.route('https://**/*', route => route.abort());
  for (const width of [320, 360, 390, 430, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 950 }); await page.goto('http://127.0.0.1:4317/resources/');
    assert.equal(await page.locator('.pd-path-card').count(), 3); assert.equal(await page.locator('.pd-resource-grid>.pd-resource-card').count(), 2);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    const a = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze(); assert.deepEqual(a.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), []);
    if ([390, 1440].includes(width)) await page.screenshot({ path: dir + `/cms-hub-${width}.png`, fullPage: true });
    checks.push(`${width}px live-revision Hub: approved design, three paths, no overflow, axe`);
  }
  for (const width of [390, 1440]) for (const row of rows) {
    await page.setViewportSize({ width, height: 950 }); await page.goto('http://127.0.0.1:4317/resources/' + row.slug + '/');
    assert.equal(await page.locator('.article-page .article-main').count(), 1); assert.equal(await page.locator('link[rel=canonical]').getAttribute('href'), `https://pooldocai.com/resources/${row.slug}/`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    const a = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze(); assert.deepEqual(a.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })), []);
    await page.screenshot({ path: dir + `/cms-${row.slug}-${width}.png`, fullPage: true }); checks.push(`${width}px ${row.slug}: dynamic approved article shell, metadata and axe`);
  }
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('http://127.0.0.1:4317/resources/');
  await page.getByRole('button', { name: 'Explore with PoolDocAI', exact: true }).click(); await page.locator('dialog.resource-assistant').waitFor();
  await page.locator('.assistant-results .pd-widget-card').first().waitFor(); assert.equal(await page.locator('.assistant-results .pd-widget-card').count(), 2);
  assert.equal(await page.locator('.assistant-results a').first().getAttribute('href'), '/resources/pool-pump-wont-start/');
  await page.screenshot({ path: dir + '/cms-assistant-390.png', fullPage: true }); await page.getByRole('button', { name: 'Close resource assistant', exact: true }).click();
  assert.equal(await page.locator('dialog.resource-assistant').isVisible(), false); checks.push('Mobile assistant consumes dynamic API with local protected links and closes');
  await page.goto('http://127.0.0.1:4317/resources/collections/explore-resources/learning-center/'); assert.equal(await page.locator('.pd-resource-grid>.pd-resource-card').count(), 2); checks.push('Collection membership remapped to actual CMS UUIDs');
  assert.deepEqual(errors, []); await context.close();
} finally {
  writeFileSync(dir + '/cms-delivery-browser.json', JSON.stringify({ checks, errors, scope: 'Local rendered browser with real Node router and mocked published RPC transport. Exact two approved live article snapshots. No hosted Auth or Supabase writes; not owner acceptance.' }, null, 2));
  await browser.close(); await new Promise(r => server.close(r));
}
console.log(`${checks.length}/${checks.length} local rendered CMS-delivery checks passed`);
