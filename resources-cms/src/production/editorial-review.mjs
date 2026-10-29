import { articleChecksum } from './article-intake.mjs';
import {descriptionProposal} from './seo-description.mjs';
import {reviewProposals} from './review-proposals.mjs';
import {longSentenceFindings} from './editorial-language.mjs';

const plain = value => String(value || '').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const words = value => new Set(plain(value).toLowerCase().match(/[a-z0-9]{3,}/g) || []);

// Deterministic screening, not a factual-verification or approval authority.
// No provider, browsing, write, publication or diagnostic KB capability.
export function reviewArticle(row, peers = []) {
  const article = row.editable || row.data || {}, text = plain(article.body), findings = [];
  const add = (area,severity,evidence,suggestion,field='body') => {
    const source=field==='body'?text:field==='summary'?String(article.summary||''):field==='seo.description'?String(article.seo?.description||''):field==='sources'?String(evidence):String(article.title||'');
    const target=String(evidence||'');
    const at=source.toLowerCase().indexOf(target.toLowerCase());
    const excerpt=at>=0?source.slice(Math.max(0,at-75),Math.min(source.length,at+target.length+85)):source.slice(0,180);
    findings.push({area,severity,evidence,suggestion,field,excerpt,highlight:at>=0?target:'',why:suggestion});
  };
  if (!text) add('editorial','blocker','The saved body contains no readable text.','Add the article body.');
  if (/\b(TODO|TBD|lorem ipsum|insert citation)\b/i.test(text)) add('editorial','warning',text.match(/.{0,45}\b(TODO|TBD|lorem ipsum|insert citation)\b.{0,45}/i)[0],'Resolve the placeholder against the original source.');
  if (!article.summary) add('editorial','warning','Summary is empty.','Write a short summary describing the scope and intended reader.','summary');
  const hazards = [
    [/\b(?:mix|combine)\b.{0,80}\b(?:chlorine|bleach|acid|ammonia)\b/i,'Chemical mixing language requires qualified safety review.'],
    [/\b(?:bypass|disable|override)\b.{0,60}\b(?:interlock|safety|breaker|GFCI|switch)\b/i,'Remove instructions to defeat safety equipment; refer to a qualified professional.'],
    [/\b(?:live wire|energized|electrocution|high voltage|gas leak|suction entrapment)\b/i,'Require equipment-specific precautions and qualified professional review.'],
  ];
  for (const [pattern,suggestion] of hazards) { const match = text.match(pattern); if (match) add('safety','blocker',match[0],suggestion); }
  const technical = /\b(?:psi|ppm|volts?|amps?|dosage|dose|torque|rewire|repair|replace|backwash)\b/i.exec(text);
  if (technical) add('technical','needs-human-review',technical[0],'Verify each value and procedure against the current manufacturer manual for the stated model; record the supporting passage.');
  // Narrow syntactic linter only: suspect chemical units are NOT corrected automatically.
  const concentrationUnit = /\b((?:(?:free|total|combined)\s+)?chlorine|bromine|calcium\s+hardness|total\s+alkalinity|cyanuric\s+acid|stabilizer)\s*[:=\-]?\s*(\d+(?:\.\d+)?)\s*(m)\b/gi;
  for (const issue of text.matchAll(concentrationUnit)) {
    add('technical','needs-human-review',issue[0],
      'Possible concentration-unit error: standalone "m" is not a normal pool-water concentration unit. Check the original measurement; ppm or mg/L may be appropriate if verified. No automatic replacement is performed.');
  }

  if (!article.sources?.length) add('sources','warning','No source references are recorded.','Add primary manufacturer or recognized technical/safety sources and link each material claim to its supporting passage.','sources');
  else for (const source of article.sources) add('sources','needs-human-review',`${source.label}: ${source.url}`,'Source URL is recorded but was not verified; locate the specific statement in the cited manual and confirm that it supports the article.','sources');
  const title = article.seo?.title || '', description = article.seo?.description || '';
  if (!title || title.length > 60) add('SEO','warning',`SEO title length: ${title.length}.`,'Review the SEO title field; aim for a clear description of 60 characters or fewer.','seo.title');
  if (!description) add('SEO','warning','Meta description is absent.',descriptionProposal(article).warning || 'Consider the existing introduction as an SEO description; approve its preview before saving.','seo.description');
  else if (description.length < 90 || description.length > 200) add('SEO','warning',`Meta description length: ${description.length}.`,'Review the description for clarity; aim for about 140–160 characters without losing meaning.','seo.description');
  if (/<img\b/i.test(article.body || '') || article.featuredImage) add('safety','needs-human-review','The draft references imagery.','Verify separate image rights, provenance, alt text and technical relevance. Automated review grants no image permissions.');
  const own = words(text);
  for (const peer of peers.filter(p=>p.id!==row.id)) {
    const other = peer.editable || peer.data || {}, tokens = words(other.body);
    const union = new Set([...own,...tokens]).size, similarity = union ? [...own].filter(t=>tokens.has(t)).length / union : 0;
    if ((text && text === plain(other.body)) || (own.size >= 20 && similarity >= .7) || (article.slug && article.slug === other.slug)) add('duplicate','warning',`Potential overlap with accessible article ${peer.id}; token similarity ${Math.round(similarity*100)}%.`,'Compare both drafts, consolidate repeated material or explain the distinct audience and purpose.');
  }
  const proposals=reviewProposals(article);
  findings.push(...longSentenceFindings(article));
  for(const p of proposals.filter(p=>p.kind==='editorial-text')){
    findings.push({
      area:p.category==='repetition'?'repetition':p.category==='spacing'?'formatting':'grammar',
      severity:'suggested-edit',field:p.field,evidence:p.before,excerpt:p.context,
      highlight:p.before,why:p.why,
      suggestion:'Approve this specific change only if it improves the intended sentence: "'+p.before+'" → "'+p.after+'".'
    });
  }
  for(const p of proposals.filter(p=>p.kind==='spelling')) {
    findings.push({
      area:'spelling',severity:'suggested-edit',field:p.field,
      evidence:p.before,excerpt:p.context,highlight:p.before,
      why:p.why,suggestion:'If this is a typo, approve just this change: "'+p.before+'" → "'+p.after+'". Nothing changes unless you approve it.'
    });
  }
  return {proposals,format:'pooldocai-editorial-review-v1',engine:'deterministic-screening-v1',articleId:row.id,version:row.version,checksum:articleChecksum(article),createdAt:new Date().toISOString(),findings,coverage:{editorial:'screened',technical:'human verification required',safety:'heuristics only; human verification required',sources:'recorded references only; not externally verified',SEO:'metadata screened',duplicate:`compared with ${peers.filter(p=>p.id!==row.id).length} accessible articles`},approvalGranted:false,publicationGranted:false,diagnosticKnowledgeGranted:false};
}
