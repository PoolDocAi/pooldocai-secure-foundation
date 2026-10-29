import sanitizeHtml from '../generated/sanitize-html.cjs';

// Extractive authoring only: complete source sentences, no model or factual verification.
export function descriptionProposal(article) {
  const source = String(article.body || '').split(/<h2\b/i)[0];
  const body = source.replace(/<(script|style|nav|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>/gi, '').replace(/<\/(?:p|li|div|section)>/gi, '\n');
  const text = sanitizeHtml(body, {allowedTags: [], allowedAttributes: {}})
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ');
  const sentences = text.match(/[^.!?\n]+[.!?](?=\s|$)/g) || [];
  const candidates = sentences.map(s=>s.replace(/\s+/g,' ').trim()).filter(s=>s.length>=15 && s.length<=200 &&
    !/https?:|www\.|\b(?:TODO|TBD|lorem ipsum|copyright|all rights reserved)\b|&[#\w]+;/i.test(s));
  const choices = [...candidates];
  for (let i=0;i<candidates.length-1;i++) {
    const pair = candidates[i]+' '+candidates[i+1];
    if (pair.length<=200) choices.push(pair);
  }
  const topic = new Set(String(article.title || '').toLowerCase().match(/[a-z]{4,}/g) || []);
  const score = s => Math.abs(s.length-150) - [...topic].filter(w=>s.toLowerCase().includes(w)).length * 12;
  const description = choices.filter(s=>s.length>=90).sort((a,b)=>score(a)-score(b))[0] || '';
  return {engine:'deterministic-extractive-v1', description,
    warning:description ? null : 'Not enough complete article prose for an accurate meta description. Add article detail and save again, or enter a description.',
    verified:false};
}

export function populateDescription(article, sourceBody = article.body) {
  if (String(article.seo?.description || '').trim()) return article;
  const proposal = descriptionProposal({...article, body:sourceBody});
  return {...article, seo:{...article.seo, description:proposal.description}};
}
