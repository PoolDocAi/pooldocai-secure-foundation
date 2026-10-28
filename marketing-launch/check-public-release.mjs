#!/usr/bin/env node
// Public marketing launch contract — read-only checks. Never sends a form or authenticates.
import assert from 'node:assert/strict';

const baseInput = process.argv[2];
const mode = process.argv[3] ?? 'public';
if (!baseInput || !['public', 'preview'].includes(mode)) {
  console.error('Usage: node marketing-launch/check-public-release.mjs https://domain.tld public|preview');
  process.exit(2);
}
const origin = new URL(baseInput);
assert.equal(origin.protocol, 'https:', 'HTTPS required');
assert.equal(origin.pathname, '/', 'Supply an origin only');
const problems = [];
async function request(path, expectedType) {
  const u = new URL(path, origin);
  try {
    const r = await fetch(u, {redirect: 'follow', signal: AbortSignal.timeout(15000)});
    const type = (r.headers.get('content-type') || '').toLowerCase();
    if (!r.ok || (expectedType && !type.includes(expectedType))) {
      problems.push(`${path}: HTTP ${r.status}; type ${type}`);
    }
    return {html: await r.text(), status: r.status, type};
  } catch (e) {
    problems.push(`${path}: ${e.message}`);
    return {html:'', status:0, type:''};
  }
}
function check(condition, message) { if (!condition) problems.push(message); }

const [home, css, hub, green, pump, robots, sitemap] = await Promise.all([
  request('/', 'text/html'),
  request('/style.css', 'text/css'),
  request('/resources/', 'text/html'),
  request('/resources/green-pool-first-checks/', 'text/html'),
  request('/resources/pool-pump-wont-start/', 'text/html'),
  request('/robots.txt', 'text/plain'),
  request('/sitemap.xml', 'xml'),
]);
for (const name of ['day-768.webp','day-1536.webp','night-768.webp','night-1536.webp']) {
  await request('/assets/'+name, 'image/webp');
}
const h = home.html, s = css.html;
const scenes = /id=["']day["']/.test(h) && /id=["']night["']/.test(h);
check(scenes, 'Homepage must contain day/night scenery elements');
const scenery = s.match(/\.scenery\s*\{([^}]*)\}/)?.[1] || '';
const stack = scenery.match(/z-index\s*:\s*(-?\d+)/)?.[1];
check(stack !== undefined && Number(stack) >= 0, 'Scenery layer must not be behind root canvas (nonnegative z-index)');
const shell = s.match(/\.shell\s*\{([^}]*)\}/)?.[1] || '';
check(/position\s*:\s*(?:relative|absolute|fixed)/.test(shell) && /z-index\s*:\s*[1-9]/.test(shell), 'Shell must sit above scenery');
const resourceLinks = [...h.matchAll(/<a\b[^>]*\bhref=["']\/resources\/?["']/gi)].length;
check(resourceLinks === 1, `Expected one static Resources link on landing; found ${resourceLinks} (check dynamically injected links in browser too)`);
check(/<form\b/i.test(h), 'Waitlist form missing');
check(/type=["']email["']/i.test(h), 'Waitlist email input missing');
check(/<title[^>]*>/i.test(h), 'Homepage title missing');
check(!/(href|action)=["']\/(?:demo|pricing|plans|app|technician)(?:\/|["'?])/i.test(h), 'Public landing links to unfinished SaaS feature');
check(!h.includes('rzkgmvyyeclrpomrlyft'), 'Staging project ref exposed in public HTML');
check(/href=["']\/resources\/?["']/i.test(h), 'Public Resources Hub must be linked');
check(/href=["'][^"']*(?:privacy)[^"']*["']/i.test(h), 'Privacy Policy navigation missing');
check(/href=["'][^"']*(?:terms)[^"']*["']/i.test(h), 'Terms navigation missing');
check(/hello@pooldocai\.com/i.test(h), 'Approved contact email missing');
for (const [path, page] of [
  ['/resources/',hub],['/resources/green-pool-first-checks/',green],['/resources/pool-pump-wont-start/',pump]
]) check(page.html.includes('https://pooldocai.com'+path), `${path}: expected canonical/public URL missing`);
for (const path of ['/resources/','/resources/green-pool-first-checks/','/resources/pool-pump-wont-start/']) {
  check(sitemap.html.includes('https://pooldocai.com'+path), `Sitemap missing ${path}`);
}
check(/Sitemap:\s*https:\/\/pooldocai\.com\/sitemap\.xml/i.test(robots.html), 'robots.txt must declare canonical sitemap');
const noindex = /<meta\s+name=["']robots["']\s+content=["'][^"']*noindex/i.test(h);
check(mode === 'preview' ? noindex : !noindex, mode === 'preview' ? 'Preview must remain noindex' : 'Public homepage must not be noindex');
check(!/\b(?:pooldocai-resources-cms-private-owner-review|source-envelopes)\b/i.test(h), 'Private CMS path leaked into landing');
console.log('PoolDocAI public marketing contract: '+(problems.length?'FAIL':'PASS'));
if (problems.length) { for (const p of problems) console.error(' - '+p); process.exitCode = 1; }
else console.log('Read-only HTTP checks passed. Browser E2E, visual acceptance, form delivery, and CMS authorization remain separate gates.');
