import { esc } from "./content.mjs";
import { injectEditorialPreviewAsset } from "./editorial-assets.mjs";
export const base = "https://pooldocai.com";
const header = `<a class="skip-link" href="#main">Skip to content</a><div class="resource-shell"><header class="resource-header"><a class="brand" href="/" aria-label="PoolDocAI home"><img src="/logo.svg" width="44" height="44" alt=""><span>PoolDoc<span class="brand-ai">AI</span></span></a><nav aria-label="Primary"><a href="/">Home</a><a href="/resources/">Resources</a><a class="nav-cta" href="/#waitlist">Get early access ↗</a></nav></header>`;
const footer = `<footer><span>© 2026 PoolDocAI</span><span>Safety-first pool knowledge, one guide at a time.</span><a href="/resources/">All resources</a></footer></div>`;
const json = (x) => JSON.stringify(x).replace(/</g, "\\u003c");
const hasInlineSources = (body = "") => /<h[2-4][^>]*>\s*(?:Sources|Manufacturer References|Verified Sources(?:\s*&amp;\s*|\s*&\s*)Citations)\s*<\/h[2-4]>/i.test(body);
function shell(
  title,
  description,
  path,
  body,
  { seo = {}, structured = null, preview = false } = {},
) {
  const url = seo.canonical || base + path;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(seo.title || title)} | PoolDocAI</title><meta name="description" content="${esc(seo.description || description)}"><meta name="robots" content="${preview || seo.noindex ? "noindex, nofollow" : "index, follow, max-image-preview:large"}"><link rel="canonical" href="${esc(url)}"><meta property="og:type" content="${structured ? "article" : "website"}"><meta property="og:site_name" content="PoolDocAI"><meta property="og:url" content="${esc(url)}"><meta property="og:title" content="${esc(seo.ogTitle || seo.title || title)}"><meta property="og:description" content="${esc(seo.ogDescription || seo.description || description)}">${seo.image ? `<meta property="og:image" content="${esc(base + seo.image)}"><meta property="og:image:alt" content="${esc(seo.imageAlt || '')}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${esc(base + seo.image)}">` : ""}<link rel="stylesheet" href="/resources/resources.css"><link rel="stylesheet" href="/public/public.css">${structured ? `<script type="application/ld+json">${json(structured)}</script>` : ""}</head><body class="resources-page article-page">${header}${preview ? '<div class="preview-banner" role="status">Private editorial preview · Not published</div>' : ""}${body}${footer}</body></html>`;
}
export function card(d, categories) {
  return `<article class="article-card"><div class="article-card-top"><span class="card-kicker">${esc(categories[d.categoryId])}</span>${d.featured ? "<span>Featured</span>" : ""}</div><h3><a href="/resources/${esc(d.slug)}/">${esc(d.title)}</a></h3><p>${esc(d.summary)}</p><div class="article-card-bottom"><span>${esc({ homeowners: "For homeowners", professionals: "For pool professionals", both: "For homeowners & professionals" }[d.audience])}</span><a href="/resources/${esc(d.slug)}/">Read resource ↗</a></div></article>`;
}
export function renderHub(db, params) {
  const cats = db
      .prepare(
        "SELECT * FROM taxonomy WHERE kind='category' AND archived=0 ORDER BY position,name",
      )
      .all(),
    names = Object.fromEntries(cats.map((x) => [x.id, x.name]));
  const tags = db
    .prepare(
      "SELECT * FROM taxonomy WHERE kind='tag' AND archived=0 ORDER BY position,name",
    )
    .all();
  const all = db
    .prepare(
      "SELECT published FROM articles WHERE published IS NOT NULL AND status NOT IN ('archived','deleted') ORDER BY updated_at DESC",
    )
    .all()
    .map((r) => JSON.parse(r.published));
  let entries = all.filter(
    (d) =>
      (!params.get("q") ||
        `${d.title} ${d.summary}`
          .toLowerCase()
          .includes(params.get("q").toLowerCase())) &&
      (!params.get("category") || d.categoryId === params.get("category")) &&
      (!params.get("tag") || d.tagIds.includes(params.get("tag"))),
  );
  const select = (key, values) =>
    `<select name="${key}" aria-label="${key}"><option value="">All ${key === "tag" ? "topics" : "categories"}</option>${values
      .filter((v) =>
        all.some((d) =>
          key === "tag" ? d.tagIds.includes(v.id) : d.categoryId === v.id,
        ),
      )
      .map(
        (v) =>
          `<option value="${esc(v.id)}" ${params.get(key) === v.id ? "selected" : ""}>${esc(v.name)}</option>`,
      )
      .join("")}</select>`;
  return shell(
    "Resources",
    "Practical pool knowledge for homeowners and professionals.",
    "/resources/",
    `<main id="main"><section class="hub-hero"><p class="section-kicker">THE POOLDOCAI KNOWLEDGE HUB</p><h1>Clearer water.<br>Clearer answers.</h1><p>Practical guides, careful first checks, and insights for the people who care for pools.</p></section><form class="hub-search" action="/resources/" method="get"><label>Search resources<input name="q" value="${esc(params.get("q"))}" placeholder="What can we help you find?"></label>${select("category", cats)}${select("tag", tags)}<button>Find resources</button></form>${
      !params.size && all.some((d) => d.featured)
        ? `<section><h2>Featured resources</h2><div class="article-grid">${all
            .filter((d) => d.featured)
            .map((d) => card(d, names))
            .join("")}</div></section>`
        : ""
    }${cats
      .filter((c) => entries.some((d) => d.categoryId === c.id))
      .map(
        (c) =>
          `<section class="hub-category"><h2>${esc(c.name)}</h2><div class="article-grid">${entries
            .filter((d) => d.categoryId === c.id)
            .map((d) => card(d, names))
            .join("")}</div></section>`,
      )
      .join(
        "",
      )}${!entries.length ? '<p role="status">No resources match your search. Try another topic.</p>' : ""}</main>`,
    { seo: { noindex: params.size > 0 } },
  );
}
export function renderArticle(db, d, { preview = false } = {}) {
  if (d.legacyHtml && !preview) return d.legacyHtml;
  const category =
      db.prepare("SELECT name FROM taxonomy WHERE id=?").get(d.categoryId)
        ?.name || "",
    url = base + `/resources/${d.slug}/`;
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Article",
        headline: d.title,
        description: d.summary,
        datePublished: d.publishedAt || undefined,
        dateModified: d.updatedAt || undefined,
        author: { "@type": "Organization", name: d.author },
        mainEntityOfPage: url,
        articleSection: category,
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          ["Home", base + "/"],
          ["Resources", base + "/resources/"],
          [d.title, url],
        ].map(([name, item], i) => ({
          "@type": "ListItem",
          position: i + 1,
          name,
          item,
        })),
      },
    ],
  };
  return shell(
    d.title,
    d.summary,
    `/resources/${d.slug}/`,
    `<main id="main"><nav class="breadcrumbs" aria-label="Breadcrumb"><a href="/">Home</a> / <a href="/resources/">Resources</a> / <span aria-current="page">${esc(d.title)}</span></nav><article class="article-main"><header class="article-header"><p class="section-kicker">${esc(category)}</p><h1>${esc(d.title)}</h1><p class="summary">${esc(d.summary)}</p><p class="article-meta">${esc(d.author)} ${d.publishedAt ? ` · Published <time datetime="${esc(d.publishedAt)}">${esc(d.publishedAt.slice(0, 10))}</time>` : ""}${d.updatedAt ? ` · Updated <time datetime="${esc(d.updatedAt)}">${esc(d.updatedAt.slice(0, 10))}</time>` : ""}</p></header>${d.featuredImage ? `<img class="feature-image" src="${esc(d.featuredImage)}" alt="${esc(d.featuredImageAlt)}">` : ""}<div class="article-body">${injectEditorialPreviewAsset(d.body, d.slug, preview)}</div>${d.sources.length && !hasInlineSources(d.body) ? `<section><h2>Sources</h2><ol>${d.sources.map((s) => `<li><a href="${esc(s.url)}">${esc(s.label)}</a></li>`).join("")}</ol></section>` : ""}${
      d.relatedIds?.length
        ? `<section><h2>Related resources</h2><ul>${d.relatedIds
            .map((id) => {
              const row = db
                .prepare(
                  "SELECT published FROM articles WHERE id=? AND published IS NOT NULL AND status NOT IN ('archived','deleted')",
                )
                .get(id);
              if (!row) return "";
              const r = JSON.parse(row.published);
              return `<li><a href="/resources/${esc(r.slug)}/">${esc(r.title)}</a></li>`;
            })
            .join("")}</ul></section>`
        : ""
    }<p class="article-note">PoolDocAI is in development. This resource is general education, not a product diagnosis.</p><a href="/resources/">← All resources</a></article></main>`,
    { seo: d.seo, structured: graph, preview },
  );
}
export function sitemap(db) {
  const rows = db
    .prepare(
      "SELECT published FROM articles WHERE published IS NOT NULL AND status NOT IN ('archived','deleted')",
    )
    .all()
    .map((x) => JSON.parse(x.published))
    .filter(
      (d) =>
        !d.seo?.noindex &&
        (!d.seo?.canonical ||
          d.seo.canonical === `${base}/resources/${d.slug}/`),
    );
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}/</loc></url><url><loc>${base}/resources/</loc></url>${rows.map((d) => `<url><loc>${base}/resources/${esc(d.slug)}/</loc>${d.updatedAt ? `<lastmod>${esc(d.updatedAt)}</lastmod>` : ""}</url>`).join("")}</urlset>`;
}
