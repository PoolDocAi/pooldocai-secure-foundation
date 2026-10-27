import { esc, sanitize, safeURL } from "../content.mjs";
import { injectEditorialPreviewAsset } from "../editorial-assets.mjs";

const ORIGIN = "https://pooldocai.com";
const json = (value) => JSON.stringify(value).replace(/</g, "\\u003c");
const hasInlineSources = (body = "") => /<h[2-4][^>]*>\s*(?:Sources|Manufacturer References|Verified Sources(?:\s*&amp;\s*|\s*&\s*)Citations)\s*<\/h[2-4]>/i.test(body);
const layout = ({ title, description, canonical, body, noindex = false, structured = null, ogTitle = title, ogDescription = description, image = "", imageAlt = "", publishedAt = "", updatedAt = "" }) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} | PoolDocAI</title><meta name="description" content="${esc(description || "Practical pool knowledge for homeowners and professionals.")}"><meta name="robots" content="${noindex ? "noindex, nofollow" : "index, follow, max-image-preview:large"}"><link rel="canonical" href="${esc(canonical)}"><meta property="og:site_name" content="PoolDocAI"><meta property="og:type" content="${structured ? "article" : "website"}"><meta property="og:title" content="${esc(ogTitle)}"><meta property="og:description" content="${esc(ogDescription || "")}"><meta property="og:url" content="${esc(canonical)}">${image ? `<meta property="og:image" content="${esc(ORIGIN + image)}"><meta property="og:image:alt" content="${esc(imageAlt)}"><meta name="twitter:card" content="summary_large_image">` : ""}${publishedAt ? `<meta property="article:published_time" content="${esc(publishedAt)}">` : ""}${updatedAt ? `<meta property="article:modified_time" content="${esc(updatedAt)}">` : ""}<link rel="stylesheet" href="/public/public.css"><link rel="stylesheet" href="/public/resource-design.css">${structured ? `<script type="application/ld+json">${json(structured)}</script>` : ""}</head><body class="resources-page ${structured?'article-page':''}"><a class="skip-link" href="#main">Skip to content</a><header class="resource-header"><a class="brand" href="/">PoolDocAI</a><nav aria-label="Primary"><a href="/">Home</a><a href="/resources/">Resources</a></nav></header>${body}<footer><p>© 2026 PoolDocAI</p></footer><script src="/public/resource-reading.js" defer></script></body></html>`;

function contentOf(record) {
  return record?.content && typeof record.content === "object" ? record.content : {};
}

export function renderPublicArticle(record, { preview = false } = {}) {
  const data = contentOf(record);
  if (!preview && typeof data.legacyHtml === "string" && data.legacyHtml.startsWith("<!doctype html>")) return data.legacyHtml;
  const title = data.title || "Resource";
  const summary = data.summary || "";
  const slug = data.slug || record.slug;
  const canonical = preview ? `${ORIGIN}/resources/${esc(slug)}/` : (data.seo?.canonical || `${ORIGIN}/resources/${slug}/`);
  const structured = preview ? null : { "@context": "https://schema.org", "@graph": [
    { "@type": "Article", headline: title, description: summary, datePublished: record.publishedAt || record.published_at, dateModified: record.updatedAt || data.updatedAt || record.publishedAt || record.published_at, mainEntityOfPage: canonical, author: { "@type": "Organization", name: data.author || "PoolDocAI" }, articleSection: record.categoryName || record.category_name || undefined },
    { "@type": "BreadcrumbList", itemListElement: [["Home", `${ORIGIN}/`], ["Resources", `${ORIGIN}/resources/`], [title, canonical]].map(([name, item], index) => ({ "@type": "ListItem", position: index + 1, name, item })) },
  ] };
  return layout({
    title: data.seo?.title || title, description: data.seo?.description || summary, canonical,
    noindex: preview || Boolean(data.seo?.noindex), structured, ogTitle: data.seo?.ogTitle || data.seo?.title || title,
    ogDescription: data.seo?.ogDescription || data.seo?.description || summary, image: data.seo?.image || "", imageAlt: data.seo?.imageAlt || "",
    publishedAt: record.publishedAt || record.published_at || "", updatedAt: record.updatedAt || data.updatedAt || record.publishedAt || record.published_at || "",
    body: `${preview ? '<div class="preview-banner" role="status">Private editorial preview · Not published</div>' : ""}<main id="main"><nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a> / <a href="/resources/">Resources</a> / <span aria-current="page">${esc(title)}</span></nav><article class="article-main"><header class="article-header"><p class="section-kicker">${esc(record.categoryName || record.category_name || "Resources")}</p><h1>${esc(title)}</h1><p class="summary">${esc(summary)}</p></header><div class="article-body">${injectEditorialPreviewAsset(sanitize(record.renderedHtml || record.rendered_html || data.body || ""), slug, preview)}</div>${(record.sources || data.sources || []).length && !hasInlineSources(record.renderedHtml || record.rendered_html || data.body || "") ? `<section><h2>Sources</h2><ol>${(record.sources || data.sources).filter(s=>safeURL(s.url,false)).map((source) => `<li><a href="${esc(source.url)}">${esc(source.label)}</a></li>`).join("")}</ol></section>` : ""}</article></main>`,
  });
}

export function renderPublicHub(rows, params = new URLSearchParams()) {
  const query = String(params.get("q") || "").trim().toLowerCase().slice(0, 200);
  const category = String(params.get("category") || "");
  const tag = String(params.get("tag") || "");
  const entries = rows.filter((row) => {
    const data = contentOf(row);
    return (!query || `${data.title || ""} ${data.summary || ""}`.toLowerCase().includes(query)) && (!category || String(row.category_id) === category) && (!tag || (row.tag_ids || []).map(String).includes(tag));
  });
  const groups = new Map();
  for (const row of entries) {
    const name = row.category_name || "Resources";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(row);
  }
  const cards = (items) => items.map((row) => { const data = contentOf(row); return `<article class="article-card"><h3><a href="/resources/${esc(row.slug)}/">${esc(data.title)}</a></h3><p>${esc(data.summary)}</p><a href="/resources/${esc(row.slug)}/">Read resource</a></article>`; }).join("");
  const categories = [...new Map(rows.map((row) => [String(row.category_id), row.category_name || "Resources"]))];
  const tags = new Map();
  for (const row of rows) (row.tag_ids || []).forEach((id, index) => tags.set(String(id), row.tag_names?.[index] || "Topic"));
  const options = (values, selected, label) => `<option value="">All ${label}</option>${[...values].map(([id, name]) => `<option value="${esc(id)}" ${id === selected ? "selected" : ""}>${esc(name)}</option>`).join("")}`;
  return layout({ title: "Resources", description: "Practical pool knowledge for homeowners and professionals.", canonical: `${ORIGIN}/resources/`, noindex: Boolean(query || category || tag), body: `<main id="main"><section class="hub-hero"><h1>Clearer water. Clearer answers.</h1><p>Practical guides, careful first checks, and insights for people who care for pools.</p></section><form class="hub-search" method="get"><label>Search resources<input name="q" value="${esc(params.get("q") || "")}"></label><label>Category<select name="category">${options(categories, category, "categories")}</select></label><label>Topic<select name="tag">${options(tags, tag, "topics")}</select></label><button>Search</button></form>${[...groups].map(([name, items]) => `<section><h2>${esc(name)}</h2><div class="article-grid">${cards(items)}</div></section>`).join("") || '<p role="status">No resources match your search.</p>'}</main>` });
}

export function renderSitemap(rows) {
  const urls = rows.filter((row) => !contentOf(row).seo?.noindex).map((row) => `<url><loc>${ORIGIN}/resources/${esc(row.slug)}/</loc>${row.updated_at ? `<lastmod>${new Date(row.updated_at).toISOString()}</lastmod>` : ""}</url>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${ORIGIN}/</loc></url><url><loc>${ORIGIN}/resources/</loc></url>${urls}</urlset>`;
}
