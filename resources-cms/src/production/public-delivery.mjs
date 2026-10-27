import { createHash } from 'node:crypto';

// Public marketing delivery only. Never forward a visitor's cookies or JWT to CMS.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PUBLIC_RPCS = new Set(['public_index', 'public_article', 'public_redirect', 'public_media']);
const UNAVAILABLE = () => Object.assign(new Error('Published resources temporarily unavailable'), { status: 503 });
const validSlug = value => typeof value === 'string' && value.length <= 120 && SLUG.test(value);
const cleanOrigin = value => {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.origin !== value || url.username || url.password) throw new TypeError('Exact HTTPS origin required');
  return url.origin;
};

function publicKey(value) {
  if (typeof value !== 'string' || !value || value.startsWith('sb_secret_')) throw new TypeError('Public publishable key required');
  if (value.startsWith('sb_publishable_')) return value;
  try {
    const claims = JSON.parse(Buffer.from(value.split('.')[1] || '', 'base64url').toString());
    if (claims.role === 'anon') return value;
  } catch {}
  throw new TypeError('Public publishable key required');
}

async function boundedJSON(response, maximum) {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw UNAVAILABLE();
  const declared = Number(response.headers.get('content-length'));
  if (declared > maximum) throw UNAVAILABLE();
  const reader = response.body?.getReader();
  if (!reader) throw UNAVAILABLE();
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum) { await reader.cancel(); throw UNAVAILABLE(); }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw UNAVAILABLE(); }
  finally { reader.releaseLock(); }
}

// The three existing RPCs must be strengthened by the separately approved release
// migration. They join ONLY the authorized published revision, never working_revision_id.
export class PublicCMSDelivery {
  constructor({ supabaseUrl, publishableKey, publicOrigin = 'https://pooldocai.com', fetchImpl = fetch, timeoutMs = 4000, maximumBytes = 2_000_000 }) {
    this.origin = cleanOrigin(publicOrigin);
    this.url = new URL(cleanOrigin(supabaseUrl));
    if (!/^[a-z0-9-]+\.supabase\.co$/.test(this.url.hostname)) throw new TypeError('Approved Supabase project origin required');
    this.key = publicKey(publishableKey);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000 || !Number.isInteger(maximumBytes) || maximumBytes < 1000 || maximumBytes > 8_000_000) throw new TypeError('Bounded delivery limits required');
    this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs; this.maximumBytes = maximumBytes;
  }

  async rpc(name, payload = {}) {
    if (!PUBLIC_RPCS.has(name)) throw new TypeError('Public RPC unavailable');
    try {
      const response = await this.fetchImpl(new URL(`/rest/v1/rpc/${name}`, this.url), {
        method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit',
        headers: { apikey: this.key, Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', 'Content-Profile': 'resources_cms', 'Accept-Profile': 'resources_cms', Accept: 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(this.timeoutMs),
      });
      return await boundedJSON(response, this.maximumBytes);
    } catch { throw UNAVAILABLE(); }
  }

  normalize(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record) || ['archived', 'deleted'].includes(record.state)) throw UNAVAILABLE();
    const id = record.id || record.article_id, revisionId = record.revisionId || record.revision_id;
    const content = record.content;
    if (!UUID.test(id || '') || !UUID.test(revisionId || '') || !validSlug(record.slug) || !content || typeof content !== 'object' || Array.isArray(content) || typeof content.title !== 'string' || !content.title.trim()) throw UNAVAILABLE();
    if (content.slug !== record.slug) throw UNAVAILABLE();
    const canonical = `${this.origin}/resources/${record.slug}/`;
    if (content.seo?.canonical && content.seo.canonical !== canonical) throw UNAVAILABLE();
    // Explicit allowlist: a public payload never contains working revision IDs,
    // audit actors, membership, release tokens, or private import provenance.
    const data = {};
    for (const key of ['title', 'slug', 'summary', 'body', 'seo', 'author', 'publishedAt', 'updatedAt', 'featuredImage', 'featuredImageAlt', 'manufacturer', 'model', 'equipmentCategory', 'relatedIds', 'legacyHtml']) {
      if (Object.hasOwn(content, key)) data[key] = structuredClone(content[key]);
    }
    return { id, slug: record.slug, revisionId, content: data,
      renderedHtml: record.renderedHtml ?? record.rendered_html ?? data.body ?? '',
      sources: Array.isArray(record.sources) ? record.sources : [],
      publishedAt: record.publishedAt ?? record.published_at ?? null,
      updatedAt: record.updatedAt || record.updated_at || data.updatedAt || null,
      categoryId: record.categoryId ?? record.category_id ?? null,
      categoryName: record.categoryName ?? record.category_name ?? 'Resources',
      tagIds: record.tagIds ?? record.tag_ids ?? [], tagNames: record.tag_names ?? [],
      audience: record.audience ?? 'both', canonical,
    };
  }

  async index() {
    const rows = await this.rpc('public_index');
    if (!Array.isArray(rows) || rows.length > 2000) throw UNAVAILABLE();
    const records = rows.map(row => this.normalize(row));
    if (new Set(records.map(r => r.slug)).size !== records.length) throw UNAVAILABLE();
    return records;
  }

  async article(slug) {
    if (!validSlug(slug)) return null;
    const result = await this.rpc('public_article', { p_slug: slug });
    if (result === null) return null;
    const record = this.normalize(result);
    if (record.slug !== slug) throw UNAVAILABLE();
    return record;
  }

  async media(id) {
    if (!UUID.test(id || '')) return null;
    const metadata = await this.rpc('public_media', { p_id: id });
    if (metadata === null) return null;
    if (metadata.id !== id || metadata.objectKey !== `images/${id}.webp` || metadata.mime !== 'image/webp' || !/^[a-f0-9]{64}$/.test(metadata.checksum || '') || !Number.isInteger(metadata.sizeBytes) || metadata.sizeBytes < 12 || metadata.sizeBytes > 4 * 1024 * 1024) throw UNAVAILABLE();
    // The private bucket's RLS checks the same current publication projection.
    // A UUID never becomes permission to read a tenant object or arbitrary path.
    const response = await this.fetchImpl(new URL(`/storage/v1/object/resources-cms-media/images/${id}.webp`, this.url), {
      method: 'GET', redirect: 'error', cache: 'no-store', credentials: 'omit',
      headers: { apikey: this.key }, signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim() !== 'image/webp' || Number(response.headers.get('content-length')) > 4 * 1024 * 1024) throw UNAVAILABLE();
    const reader = response.body?.getReader(); if (!reader) throw UNAVAILABLE();
    const chunks = []; let length = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > 4 * 1024 * 1024) { await reader.cancel(); throw UNAVAILABLE(); } chunks.push(Buffer.from(value)); }
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== metadata.sizeBytes || bytes.subarray(0, 4).toString() !== 'RIFF' || bytes.subarray(8, 12).toString() !== 'WEBP' || createHash('sha256').update(bytes).digest('hex') !== metadata.checksum) throw UNAVAILABLE();
    return { bytes, checksum: metadata.checksum };
  }

  async redirect(slug) {
    if (!validSlug(slug)) return null;
    const target = await this.rpc('public_redirect', { p_slug: slug });
    if (target === null) return null;
    if (!validSlug(target) || target === slug) throw UNAVAILABLE();
    // A stale redirect cannot point at a draft or withdrawn resource.
    return (await this.article(target)) ? target : null;
  }
}

export function publicCatalog(rows) {
  return rows.map(row => ({ id: row.id, revisionId: row.revisionId, slug: row.slug, url: row.canonical,
    title: row.content.title, summary: row.content.summary || '', categoryId: row.categoryId,
    categoryName: row.categoryName, audience: row.audience, manufacturer: row.content.manufacturer || null, model: row.content.model || null, publishedAt: row.publishedAt,
    updatedAt: row.updatedAt, tagIds: row.tagIds, tags: row.tagIds.map((id, index) => ({ id, name: row.tagNames[index] || 'Topic', group: 'topic', aliases: [] })),
  }));
}

const deliveryHeaders = (type, preview) => ({
  'Content-Type': type, 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store', 'Vercel-CDN-Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff', ...(preview ? { 'X-Robots-Tag': 'noindex, nofollow, noarchive' } : {}),
});

// Inject the CURRENT approved marketing renderers; no older design is imported
// or silently substituted. Hook this route into the marketing project's function,
// not the protected CMS deployment. Static homepage / waitlist remain untouched.
export function createPublicDelivery({ client, renderArticle, renderHub, renderSitemap, renderCollection, renderLLMs, discover, preview = true }) {
  if (!client || [renderArticle, renderHub, renderSitemap, discover].some(fn => typeof fn !== 'function')) throw new TypeError('Published client and approved marketing renderers required');
  return async request => {
    const url = new URL(request.url), path = url.pathname;
    const articleMatch = path.match(/^\/resources\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/);
    const mediaMatch = path.match(/^\/media\/([0-9a-f-]{36})$/i);
    const collection = /^\/resources\/collections\/[a-z0-9-]+(?:\/[a-z0-9-]+)+\/?$/.test(path);
    const index = ['/resources', '/resources/', '/api/public/resources', '/resources-sitemap.xml', '/sitemap.xml', '/llms.txt'].includes(path);
    if (!index && !articleMatch && !collection && !mediaMatch) return null;
    const headers = deliveryHeaders('text/html; charset=utf-8', preview);
    if (!['GET', 'HEAD'].includes(request.method)) return Response.json({ error: 'Method not allowed' }, { status: 405, headers: { ...headers, 'Content-Type': 'application/json', Allow: 'GET, HEAD' } });
    const response = (body, status = 200, extra = {}) => new Response(request.method === 'HEAD' ? null : body, { status, headers: { ...headers, ...extra } });
    try {
      if (mediaMatch) {
        const value = await client.media(mediaMatch[1]);
        return value ? response(value.bytes, 200, { 'Content-Type': 'image/webp', 'Content-Length': String(value.bytes.length), 'Content-Disposition': 'inline', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-site' }) : response(null, 404);
      }
      if (articleMatch) {
        const record = await client.article(articleMatch[1]);
        if (record) {
          if (!path.endsWith('/')) return response(null, 308, { Location: `/resources/${record.slug}/` });
          return response(await renderArticle(record));
        }
        const target = await client.redirect(articleMatch[1]);
        return target ? response(null, 308, { Location: `/resources/${target}/` }) : response('Resource not found', 404, { 'X-Robots-Tag': 'noindex' });
      }
      const rows = await client.index();
      if (path === '/llms.txt') return response(renderLLMs ? await renderLLMs(rows.filter(r => !r.content.seo?.noindex)) : '# PoolDocAI Resources\n\n' + rows.filter(r => !r.content.seo?.noindex).map(row => `- ${row.content.title.replace(/\s+/g, ' ')}: ${row.canonical}`).join('\n') + '\n', 200, { 'Content-Type': 'text/plain; charset=utf-8' });
      if (path === '/resources-sitemap.xml' || path === '/sitemap.xml') return response(await renderSitemap(rows.filter(r => !r.content.seo?.noindex)), 200, { 'Content-Type': 'application/xml; charset=utf-8' });
      const catalog = publicCatalog(rows.filter(r => !r.content.seo?.noindex));
      if (path === '/api/public/resources') return response(JSON.stringify(await discover(catalog, url.searchParams)), 200, { 'Content-Type': 'application/json; charset=utf-8', 'X-Robots-Tag': 'noindex' });
      if (collection) {
        const body = renderCollection && await renderCollection(catalog, url.searchParams, path.replace(/\/+$/, '') + '/');
        return body === null || body === undefined ? response('Collection not found', 404, { 'X-Robots-Tag': 'noindex' }) : response(body);
      }
      return response(await renderHub(catalog, url.searchParams));
    } catch {
      // No stale article fallback: a withdrawal must never be defeated by cache
      // or by an upstream outage. The unaffected static marketing pages stay up.
      if (mediaMatch) return response(null, 404);
      return response('Published resources temporarily unavailable. Please try again shortly.', 503, { 'Retry-After': '10', 'X-Robots-Tag': 'noindex' });
    }
  };
}
