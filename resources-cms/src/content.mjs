import sanitizeHtml from "./generated/sanitize-html.cjs";
export const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function safeURL(s, internal = true) {
  return (
    typeof s === "string" &&
    s.length <= 2048 &&
    (/^https:\/\/[^\s<>"'\\]+$/i.test(s) ||
      (internal && /^\/(?!\/)[^\s<>"'\\]*$/.test(s)))
  );
}
export function sanitize(body) {
  return sanitizeHtml(body, {
    allowedTags: [
      "p",
      "br",
      "h2",
      "h3",
      "h4",
      "strong",
      "b",
      "em",
      "i",
      "a",
      "ul",
      "ol",
      "li",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "caption",
      "blockquote",
      "aside",
      "div",
      "section",
      "span",
      "img",
      "figure",
      "figcaption",
      "hr",
      "sup",
      "pre",
      "code",
    ],
    allowedAttributes: {
      a: ["href", "title"],
      img: ["src", "alt", "width", "height"],
      "*": ["id"],
      aside: ["class"],
      div: ["class"],
      th: ["scope", "colspan", "rowspan"],
      td: ["colspan", "rowspan"],
    },
    allowedClasses: {
      aside: ["callout", "safety-callout"],
      div: ["callout", "safety-callout"],
    },
    allowedSchemes: ["https"],
    allowProtocolRelative: false,
    transformTags: {
      a: (tag, attrs) => ({
        tagName: "a",
        attribs: {
          ...attrs,
          ...(attrs.href &&
          !safeURL(attrs.href) &&
          !/^#[a-zA-Z0-9_-]+$/.test(attrs.href)
            ? { href: "" }
            : {}),
        },
      }),
      img: (tag, attrs) => ({
        tagName: "img",
        attribs: {
          ...attrs,
          src: /^\/media\/[a-f0-9-]+$/.test(attrs.src || "") ? attrs.src : "",
        },
      }),
    },
  });
}
export function validateContent(db, input, previous = {}) {
  const str = (key, max, required = false) => {
    const v = String(input[key] ?? previous[key] ?? "").trim();
    if (v.length > max || (required && !v))
      throw Object.assign(
        new Error(
          `${key} ${required ? "is required and " : ""}must be at most ${max} characters`,
        ),
        { status: 422 },
      );
    return v;
  };
  const title = str("title", 180, true),
    slug = str("slug", 120, true);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
    throw Object.assign(
      new Error("Use lowercase words separated by hyphens for the slug"),
      { status: 422 },
    );
  const categoryId = str("categoryId", 100, true);
  if (
    !db
      .prepare(
        "SELECT id FROM taxonomy WHERE id=? AND kind='category' AND archived=0",
      )
      .get(categoryId)
  )
    throw Object.assign(new Error("Choose one active primary category"), {
      status: 422,
    });
  const tagIds = input.tagIds ?? previous.tagIds ?? [];
  if (
    !Array.isArray(tagIds) ||
    tagIds.length > 30 ||
    tagIds.some(
      (id) =>
        !db
          .prepare(
            "SELECT id FROM taxonomy WHERE id=? AND kind='tag' AND archived=0",
          )
          .get(id),
    )
  )
    throw Object.assign(new Error("Invalid topic tags"), { status: 422 });
  const sources = input.sources ?? previous.sources ?? [];
  if (
    !Array.isArray(sources) ||
    sources.length > 100 ||
    sources.some(
      (s) => !s.label || String(s.label).length > 300 || !safeURL(s.url, false),
    )
  )
    throw Object.assign(
      new Error("Each source needs a label and an HTTPS URL"),
      { status: 422 },
    );
  const body = sanitize(str("body", 200000)),
    seo = {};
  for (const k of [
    "title",
    "description",
    "canonical",
    "ogTitle",
    "ogDescription",
    "image",
    "imageAlt",
  ])
    seo[k] = String(input.seo?.[k] ?? previous.seo?.[k] ?? "")
      .trim()
      .slice(0, 2048);
  if (seo.canonical && !safeURL(seo.canonical, false))
    throw Object.assign(new Error("Canonical URL must use HTTPS"), {
      status: 422,
    });
  if (seo.image && !/^\/media\/[a-f0-9-]+$/.test(seo.image) && !/^\/assets\/(day|night)-(768|1536)\.webp$/.test(seo.image))
    throw Object.assign(
      new Error("Choose a social image from the media library"),
      { status: 422 },
    );
  seo.noindex = Boolean(input.seo?.noindex ?? previous.seo?.noindex);
  const relatedIds = input.relatedIds ?? previous.relatedIds ?? [];
  if (
    !Array.isArray(relatedIds) ||
    relatedIds.length > 12 ||
    relatedIds.some(
      (x) => !db.prepare("SELECT id FROM articles WHERE id=?").get(x),
    )
  )
    throw Object.assign(new Error("Invalid related resources"), {
      status: 422,
    });
  const publishedAt = input.publishedAt ?? previous.publishedAt ?? null;
  if (
    publishedAt &&
    (!Number.isFinite(Date.parse(publishedAt)) ||
      Date.parse(publishedAt) > Date.now())
  )
    throw Object.assign(
      new Error("Article publication date must be a valid past date"),
      { status: 422 },
    );
  const featuredImage = str("featuredImage", 200);
  if (featuredImage && !/^\/media\/[a-f0-9-]+$/.test(featuredImage))
    throw Object.assign(
      new Error("Choose a featured image from the media library"),
      { status: 422 },
    );
  const audience = str("audience", 40) || "homeowners";
  if (!["homeowners", "professionals", "both"].includes(audience))
    throw Object.assign(new Error("Invalid audience"), { status: 422 });
  const collection = str("collection", 80);
  if (collection && !["PoolDocAI Progress Report"].includes(collection))
    throw Object.assign(new Error("Invalid editorial collection"), {
      status: 422,
    });
  const discovery=input.discovery??previous.discovery??null;
  if(discovery&&(typeof discovery!=='object'||Array.isArray(discovery)||['primaryTopicId','guideTypeId','audienceTagId'].some(k=>discovery[k]&&!tagIds.includes(discovery[k]))))throw Object.assign(Error('Primary discovery selections must be selected tags'),{status:422});
  return {
    ...(discovery?{discovery:{primaryTopicId:discovery.primaryTopicId||null,guideTypeId:discovery.guideTypeId||null,audienceTagId:discovery.audienceTagId||null}}:{}),
    manufacturer: str("manufacturer", 120),
    model: str("model", 120),
    equipmentCategory: str("equipmentCategory", 120),
    title,
    slug,
    summary: str("summary", 500),
    body,
    categoryId,
    tagIds: [...new Set(tagIds)],
    audience,
    collection,
    author: str("author", 120) || "PoolDocAI",
    sources: sources.map((s) => ({ label: String(s.label), url: s.url })),
    seo,
    featuredImage,
    featuredImageAlt: str("featuredImageAlt", 300),
    relatedIds,
    featured: Boolean(input.featured ?? previous.featured),
    publishedAt,
  };
}
export function warnings(db, d) {
  const list = [];
  if (!d.summary) list.push("Missing summary");
  if (!d.seo?.title) list.push("Missing SEO title");
  if (!d.seo?.description) list.push("Missing meta description");
  if (d.seo?.title?.length > 65) list.push("SEO title may be truncated");
  if (d.seo?.description?.length > 170)
    list.push("Meta description may be truncated");
  if (!d.sources?.length) list.push("Missing source references");
  if (!d.body?.replace(/<[^>]*>/g, "").trim())
    list.push("Article body is empty");
  if (d.featuredImage && !d.featuredImageAlt)
    list.push("Featured image needs alt text");
  for (const tag of d.body.match(/<img\b[^>]*>/g) || [])
    if (!/\balt="[^"]+"/.test(tag)) list.push("Body image needs alt text");
  for (const [, slug] of d.body.matchAll(
    /href="\/resources\/([a-z0-9-]+)\/?"/g,
  )) {
    if (
      !db
        .prepare(
          "SELECT id FROM articles WHERE slug=? AND published IS NOT NULL AND status NOT IN ('archived','deleted')",
        )
        .get(slug) &&
      !db.prepare("SELECT old_slug FROM redirects WHERE old_slug=?").get(slug)
    )
      list.push(`Broken internal resource link: ${slug}`);
  }
  return [...new Set(list)];
}
