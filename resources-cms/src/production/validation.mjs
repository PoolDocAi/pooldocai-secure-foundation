import { sanitize, safeURL } from "../content.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function reject(message) {
  throw Object.assign(new TypeError(message), { status: 422 });
}

function short(value, maximum, required = false) {
  const text = String(value ?? "").trim();
  if ((required && !text) || text.length > maximum) reject("Invalid article field");
  return text;
}

// This is the untrusted-input boundary. Database procedures repeat the
// authorization and state-transition checks; neither layer is trusted alone.
export function normalizeArticleCommand(action, input = {}, previous = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) reject("Invalid payload");
  if (!["create", "save"].includes(action)) return structuredClone(input);
  const slug = short(input.slug, 120, true);
  const categoryId = short(input.categoryId, 36, true);
  if (!SLUG.test(slug) || !UUID.test(categoryId)) reject("Invalid slug or category");
  const tagIds = input.tagIds ?? [];
  if (!Array.isArray(tagIds) || tagIds.length > 30 || tagIds.some((id) => !UUID.test(String(id)))) reject("Invalid tags");
  const sources = input.sources ?? [];
  if (!Array.isArray(sources) || sources.length > 100) reject("Sources must be a list of at most 100 references");
  for (const [index, source] of sources.entries()) {
    if (!source || typeof source !== "object" || typeof source.label !== "string" ||
      !source.label.trim() || source.label.trim().length > 300 || !safeURL(source.url, false)) {
      reject(`Source ${index + 1} requires a name and a valid HTTPS URL`);
    }
  }
  const body = sanitize(short(input.body, 200_000));
  const seo = input.seo && typeof input.seo === "object" && !Array.isArray(input.seo) ? input.seo : {};
  const canonical = short(seo.canonical, 2_048);
  if (canonical && !safeURL(canonical, false)) reject("Invalid canonical URL");
  const audience = short(input.audience, 40) || "homeowners";
  if (!["homeowners", "professionals", "both"].includes(audience)) reject("Invalid audience");
  const discovery=input.discovery;
  if(discovery&&(typeof discovery!=='object'||Array.isArray(discovery)||['primaryTopicId','guideTypeId','audienceTagId'].some(k=>discovery[k]&&!tagIds.includes(discovery[k]))))reject('Discovery selections must be selected tags');
  return {
    ...(discovery?{discovery:{primaryTopicId:discovery.primaryTopicId||null,guideTypeId:discovery.guideTypeId||null,audienceTagId:discovery.audienceTagId||null}}:{}),
    manufacturer: short(input.manufacturer, 120),
    model: short(input.model, 120),
    equipmentCategory: short(input.equipmentCategory, 120),
    title: short(input.title, 180, true),
    slug,
    summary: short(input.summary, 500),
    body,
    categoryId,
    tagIds: [...new Set(tagIds.map(String))],
    audience,
    collection: short(input.collection, 80),
    author: short(input.author, 120) || "PoolDocAI",
    sources: sources.map(({ label, url }) => ({ label: short(label, 300, true), url: String(url) })),
    seo: {
      title: short(seo.title, 180), description: short(seo.description || previous.seo?.description, 500), canonical,
      ogTitle: short(seo.ogTitle, 180), ogDescription: short(seo.ogDescription, 500),
      image: short(seo.image, 200), imageAlt: short(seo.imageAlt, 300), noindex: Boolean(seo.noindex),
    },
    featuredImage: short(input.featuredImage, 200),
    featuredImageAlt: short(input.featuredImageAlt, 300),
    relatedIds: Array.isArray(input.relatedIds) ? input.relatedIds.filter((id) => UUID.test(String(id))).slice(0, 12) : [],
    featured: Boolean(input.featured),
    publishedAt: input.publishedAt || null,
  };
}
