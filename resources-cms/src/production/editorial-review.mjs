import { articleChecksum } from './article-intake.mjs';

const plain = value => String(value || '').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const words = value => new Set(plain(value).toLowerCase().match(/[a-z0-9]{3,}/g) || []);

// Deterministic screening, not a factual-verification or approval authority.
// No provider, browsing, write, publication or diagnostic KB capability.
export function reviewArticle(row, peers = []) {
  const article = row.editable || row.data || {}, text = plain(article.body), findings = [];
  const add = (area,severity,evidence,suggestion) => findings.push({area,severity,evidence,suggestion});
  if (!text) add('editorial','blocker','The saved body contains no readable text.','Add the article body.');
  if (/\b(TODO|TBD|lorem ipsum|insert citation)\b/i.test(text)) add('editorial','warning',text.match(/.{0,45}\b(TODO|TBD|lorem ipsum|insert citation)\b.{0,45}/i)[0],'Resolve the placeholder against the original source.');
  if (!article.summary) add('editorial','warning','Summary is empty.','Write a short summary describing the scope and intended reader.');
  const hazards = [
    [/\b(?:mix|combine)\b.{0,80}\b(?:chlorine|bleach|acid|ammonia)\b/i,'Chemical mixing language requires qualified safety review.'],
    [/\b(?:bypass|disable|override)\b.{0,60}\b(?:interlock|safety|breaker|GFCI|switch)\b/i,'Remove instructions to defeat safety equipment; refer to a qualified professional.'],
    [/\b(?:live wire|energized|electrocution|high voltage|gas leak|suction entrapment)\b/i,'Require equipment-specific precautions and qualified professional review.'],
  ];
  for (const [pattern,suggestion] of hazards) { const match = text.match(pattern); if (match) add('safety','blocker',match[0],suggestion); }
  const technical = /\b(?:psi|ppm|volts?|amps?|dosage|dose|torque|rewire|repair|replace|backwash)\b/i.exec(text);
  if (technical) add('technical','needs-human-review',technical[0],'Verify each value and procedure against the current manufacturer manual for the stated model; record the supporting passage.');
  if (!article.sources?.length) add('sources','warning','No source references are recorded.','Add primary manufacturer or recognized technical/safety sources and link each material claim to its supporting passage.');
  else for (const source of article.sources) add('sources','needs-human-review',`${source.label}: ${source.url}`,'Source URL is recorded, but its contents, authority, freshness and support for claims have not been fetched or verified. Check and record the exact supporting passage.');
  const title = article.seo?.title || '', description = article.seo?.description || '';
  if (!title || title.length > 60) add('SEO','warning',`SEO title length: ${title.length}.`,'Provide a descriptive SEO title; aim for 60 characters or fewer.');
  if (description.length < 70 || description.length > 160) add('SEO','warning',`Meta description length: ${description.length}.`,'Write an accurate description of about 70–160 characters.');
  if (/<img\b/i.test(article.body || '') || article.featuredImage) add('safety','needs-human-review','The draft references imagery.','Verify separate image rights, provenance, alt text and technical relevance. Automated review grants no image permissions.');
  const own = words(text);
  for (const peer of peers.filter(p=>p.id!==row.id)) {
    const other = peer.editable || peer.data || {}, tokens = words(other.body);
    const union = new Set([...own,...tokens]).size, similarity = union ? [...own].filter(t=>tokens.has(t)).length / union : 0;
    if ((text && text === plain(other.body)) || (own.size >= 20 && similarity >= .7) || (article.slug && article.slug === other.slug)) add('duplicate','warning',`Potential overlap with accessible article ${peer.id}; token similarity ${Math.round(similarity*100)}%.`,'Compare both drafts, consolidate repeated material or explain the distinct audience and purpose.');
  }
  return {format:'pooldocai-editorial-review-v1',engine:'deterministic-screening-v1',articleId:row.id,version:row.version,checksum:articleChecksum(article),createdAt:new Date().toISOString(),findings,coverage:{editorial:'screened',technical:'human verification required',safety:'heuristics only; human verification required',sources:'recorded references only; not externally verified',SEO:'metadata screened',duplicate:`compared with ${peers.filter(p=>p.id!==row.id).length} accessible articles`},approvalGranted:false,publicationGranted:false,diagnosticKnowledgeGranted:false};
}
