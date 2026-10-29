/* Opt-in live published-revision bridge. No owner cookies, CMS write calls, or
 * privileged keys. Existing snapshot previews remain unchanged until cutover. */
import { readFileSync } from 'node:fs';
import { assertPublicCMSDeliveryTarget } from '../src/production/public-target.mjs';
import { PublicCMSDelivery, createPublicDelivery } from '../src/production/public-delivery.mjs';
import { renderPublicArticle } from '../src/production/render.mjs';
import { discover, renderDiscovery } from '../src/platform/catalog.mjs';
import { publicNavigation, addNavigationBreadcrumbs, navigationSelection } from '../src/platform/navigation.mjs';
import { addLegalFooter } from '../scripts/footer-navigation.mjs';
import { esc } from '../src/content.mjs';

// These fixtures must have statically traceable paths so Vercel bundles them
// into the protected serverless runtime; dynamic read() paths caused hosted 500.
const seededNavigation = JSON.parse(readFileSync(new URL('../review-navigation.json', import.meta.url), 'utf8'));
const formerCatalog = JSON.parse(readFileSync(new URL('../live-catalog.json', import.meta.url), 'utf8'));
const legacyTemplates = Object.freeze({
  'pool-pump-wont-start': readFileSync(new URL('../review-pages/pool-pump-wont-start/index.html', import.meta.url), 'utf8'),
  'green-pool-first-checks': readFileSync(new URL('../review-pages/green-pool-first-checks/index.html', import.meta.url), 'utf8'),
});
const articleTemplate = legacyTemplates['pool-pump-wont-start'];
const articleStyles = '<link rel="stylesheet" href="/resources/resources.css">';
const articleHeader = articleTemplate.match(/<header class="resource-header">[\s\S]*?<\/header>/)?.[0];
if (!articleHeader || !articleStyles) throw new Error('Approved article shell missing');
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString().slice(0, 10) : '';
const script = path => `<script src="${path}" defer></script>`;

// Folder identities are retained, while historical fixture article UUIDs are
// reconciled by canonical slug to the real immutable CMS identities.
export function liveNavigation(catalog, surface = 'hub') {
  const nav = structuredClone(seededNavigation), byId = new Map(formerCatalog.map(row => [row.id, row.slug]));
  nav.document.memberships = nav.document.memberships.flatMap(member => {
    const current = catalog.find(row => row.slug === byId.get(member.articleId));
    return current ? [{ ...member, articleId: current.id }] : [];
  });
  return publicNavigation(nav, catalog, surface);
}

function datedCatalog(rows) {
  return rows.map(row => {
    // Existing reviewed discovery labels supplement only the two reconciled
    // historical articles; all actual text and public identities come from CMS.
    const reviewed = formerCatalog.find(item => item.slug === row.slug);
    return reviewed ? { ...row, tags: (row.tags || []).map(tag => reviewed.tags.find(t => t.id === tag.id) || tag) } : row;
  });
}

function query(catalog, params, surface = 'hub') {
  const navigation = liveNavigation(catalog, surface);
  const folder = params.get('folder') || '', path = params.get('path') || '';
  // Owner-reviewed folder membership controls discovery paths. Do not require
  // unapplied v3 facet rows (the launch database still has the legacy taxonomy),
  // and do not fabricate tags from folder membership.
  const selection = navigationSelection(navigation, catalog, { folder, path });
  const result = discover(selection, { query: params.get('q') || '', slug: params.get('slug') || '', tags: params.getAll('tag').filter(Boolean),
    offset: Math.max(0, Math.min(100000, Number(params.get('offset')) || 0)) });
  return { ...result, navigation, paths: navigation.paths, folder: folder || null, path };
}

const previewLinks = (html, preview) => preview ? html.replace(/(<a\b[^>]*\bhref=")https:\/\/pooldocai\.com(\/resources\/[^"]*)"/g, '$1$2"') : html;

function approvedArticle(record, preview, related = []) {
  // legacyHtml remains immutable provenance, never a shortcut around fresh body
  // sanitation or the currently approved article presentation.
  const content = { ...record.content, ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}) }; delete content.legacyHtml;
  let html = renderPublicArticle({ ...record, content });
  html = html.replace('<link rel="stylesheet" href="/public/public.css">', articleStyles + '<link rel="stylesheet" href="/platform.css"><link rel="stylesheet" href="/resource-design.css">');
  html = html.replace('<body class="resources-page">', '<body class="resources-page article-page">').replace('</a><header class="resource-header">', '</a><div class="resource-shell"><header class="resource-header">');
  html = html.replace(/<header class="resource-header">[\s\S]*?<\/header>/, articleHeader);
  const note = articleTemplate.match(/<p class="article-note">[\s\S]*?<\/p>/)?.[0] || '';
  const cta = articleTemplate.match(/<div class="article-cta">[\s\S]*?<\/div>/)?.[0] || '';
  const links = related.filter(row => row.id !== record.id).slice(0, 3);
  const relatedHTML = links.length ? '<section class="article-related" aria-labelledby="related-title"><p class="section-kicker">KEEP READING</p><h2 id="related-title">Related resources</h2><div class="article-grid">' + links.map(row => `<article class="article-card"><div class="article-card-top"><span class="card-kicker">${esc(row.categoryName)}</span></div><h3><a href="${esc(row.canonical)}" data-analytics-id="article.related.open" data-analytics-event="resource_open" data-content-id="${esc(row.id)}">${esc(row.content.title)}</a></h3><p>${esc(row.content.summary || '')}</p><a href="${esc(row.canonical)}">Read guide ↗</a></article>`).join('') + '</div></section>' : '';
  const headings = [...String(record.renderedHtml).matchAll(/<section\b[^>]*\bid="([A-Za-z0-9_:-]+)"[^>]*>\s*<h2[^>]*>([\s\S]*?)<\/h2>/g)].slice(0, 12);
  const toc = headings.length ? '<aside class="article-side" aria-label="On this page"><h2>On this page</h2>' + headings.map(([, id, heading]) => `<a href="#${esc(id)}">${esc(heading.replace(/<[^>]*>/g, ''))}</a>`).join('') + '</aside>' : '';
  html = html.replace('<article class="article-main">', '<div class="article-layout"><article class="article-main">').replace('</article></main>', `${note}${relatedHTML}${cta}<p><a class="text-link" href="/resources/">← Back to all resources</a></p></article>${toc}</div></main>`);
  const times = [['Published', record.publishedAt], ['Updated', record.updatedAt]].filter(([, value]) => date(value)).map(([label, value]) => `<span>${label} <time datetime="${date(value)}">${date(value)}</time></span>`).join('');
  html = html.replace('</p></header><div class="article-body">', `</p><div class="article-meta">${times}</div></header><div class="article-body">`);
  html = html.replace(/<footer>[\s\S]*?<\/footer>/, '<footer><a href="/resources/">Resources</a><span>© 2026 PoolDocAI</span></footer>');
  html = addLegalFooter(html).replace('</body>', `${script('/resource-reading.js')}${script('/resource-assistant.js')}</div></body>`);
  if (preview) html = html.replace(/<meta name="robots"[^>]*>/, '<meta name="robots" content="noindex, nofollow, noarchive">');
  return previewLinks(html, preview);
}

export function createMarketingCMSDelivery({ client, preview = true }) {
  const source = client;
  return createPublicDelivery({ client: source, preview,
    renderArticle: async record => {
      let related = [];
      try {
        if (record.content.relatedIds?.length) {
          const ids = new Set(record.content.relatedIds);
          related = (await source.index()).filter(row => row.id !== record.id && ids.has(row.id)).slice(0, 3);
        } else if (formerCatalog.some(row => row.slug === record.slug)) {
          // Retain the approved two legacy related-guide links, but recheck each
          // target's current published pointer. Avoid downloading every body on
          // every article view merely to build one existing recommendation.
          const legacy = legacyTemplates[record.slug] || '';
          const section = legacy.match(/<section class="article-related"[\s\S]*?<\/section>/)?.[0] || '';
          const slugs = [...new Set([...section.matchAll(/href="\/resources\/([a-z0-9-]+)\/"/g)].map(match => match[1]))].slice(0, 3);
          related = (await Promise.all(slugs.map(slug => source.article(slug)))).filter(Boolean);
        }
      } catch { related = []; } // A missing recommendation cannot serve stale text or take down a freshly verified article.
      const catalog = [{ id: record.id, slug: record.slug, title: record.content.title, url: record.canonical }];
      return addNavigationBreadcrumbs(approvedArticle(record, preview, related), liveNavigation(catalog), { id: record.id, title: record.content.title, url: record.canonical });
    },
    renderHub: (rows, params) => previewLinks(addLegalFooter(renderDiscovery(query(datedCatalog(rows), params), params, { assistant: true, analytics: false })), preview),
    renderCollection: (rows, params, path) => {
      const catalog = datedCatalog(rows), nav = liveNavigation(catalog), folder = nav.folders.find(item => item.url === path);
      if (!folder) return null;
      const selection = new URLSearchParams(params); selection.set('folder', folder.id); selection.set('path', folder.pathId);
      return previewLinks(addLegalFooter(renderDiscovery(query(catalog, selection), selection, { assistant: true, analytics: false })), preview);
    },
    discover: (rows, params) => {
      const surface = ['assistant', 'header'].includes(params.get('surface')) ? params.get('surface') : 'hub';
      const result = query(datedCatalog(rows), params, surface);
      // Canonical identity remains explicit; Preview clicks stay in the protected
      // site rather than accidentally opening an as-yet unpublished live URL.
      return preview ? { ...result, items: result.items.map(row => ({ ...row, canonicalUrl: row.url, url: new URL(row.url).pathname })) } : result;
    },
    renderSitemap: rows => `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['https://pooldocai.com/', 'https://pooldocai.com/resources/', 'https://pooldocai.com/privacy.html', 'https://pooldocai.com/terms.html', ...rows.map(row => row.canonical)].map(url => `<url><loc>${esc(url)}</loc></url>`).join('')}</urlset>`,
  });
}

let configured;
export default async function handler(req, res) {
  try {
    if (process.env.CMS_PUBLISHED_DELIVERY_ENABLED !== '1') { res.statusCode = 404; res.setHeader('Cache-Control', 'no-store'); return res.end('Not found'); }
    if (process.env.CMS_DATABASE_URL || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY) throw new Error('Privileged public credentials forbidden');
    assertPublicCMSDeliveryTarget(process.env);
    const preview = process.env.VERCEL_ENV !== 'production';
    configured ||= createMarketingCMSDelivery({ preview, client: new PublicCMSDelivery({ supabaseUrl: process.env.PUBLIC_RESOURCES_SUPABASE_URL, publishableKey: process.env.PUBLIC_RESOURCES_PUBLISHABLE_KEY }) });
    const incoming = new URL(req.url, `https://${req.headers.host || 'pooldocai.com'}`), path = incoming.searchParams.get('__path') || incoming.pathname;
    incoming.pathname = path; incoming.searchParams.delete('__path');
    const response = await configured(new Request(incoming, { method: req.method, headers: { accept: req.headers.accept || '*/*' } }));
    if (!response) { res.statusCode = 404; res.setHeader('Cache-Control', 'no-store'); return res.end('Not found'); }
    res.statusCode = response.status; for (const [key, value] of response.headers) res.setHeader(key, value);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.statusCode = 503; res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Robots-Tag', 'noindex'); res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Published resources temporarily unavailable' }));
  }
}
