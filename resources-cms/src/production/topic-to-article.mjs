import { normalizeArticleCommand } from './validation.mjs';
import {validResearchUrl} from './research-url.mjs';

// Stage A of Topic -> full article: only trusted source IDs supplied by the
// server-side research stage may become links. NEVER trust model-invented URLs.
// No network calls, no database writes, no publication or approvals here.
const error=message=>{throw Object.assign(new TypeError(message),{status:422});};
const clean=(v,max,required=true)=>{
  if(typeof v!=='string'||v.length>max||required&&!v.trim())error('Incomplete AI article; check or regenerate the draft');
  return v.trim();
};
const esc=s=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const wordCount=s=>(s.match(/\b[\p{L}\p{N}][\p{L}\p{N}'’-]*\b/gu)||[]).length;
const forbidden=/\b(?:lorem ipsum|insert (?:citation|content|text)|TBD|TODO|placeholder)\b/i;
const slugify=title=>title.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,105).replace(/-$/,'');

export function validateTopicRequest(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))error('Invalid topic request');
  const topic=clean(input.topic,180);
  if(topic.length<6 || /[\x00-\x1F]/.test(topic))error('Enter a specific article topic');
  const audience=input.audience??'both';
  if(!['homeowners','professionals','both'].includes(audience))error('Invalid article audience');
  return {topic,audience};
}

export function composeTopicArticle({request,draft,researchSources,categoryId}) {
  const topic=validateTopicRequest(request);
  if(!draft||typeof draft!=='object'||Array.isArray(draft))error('Full article generation did not return a draft');
  if(!Array.isArray(researchSources)||researchSources.length<2||researchSources.length>30)error('Research sources are missing');
  const sources=new Map();
  const urls=new Set();
  for(const source of researchSources){
    if(!source||typeof source.id!=='string'||!/^[a-z0-9-]{1,32}$/i.test(source.id)||sources.has(source.id))error('Invalid research source identity');
    const name=clean(source.label,200),url=clean(source.url,2048);
    if(!validResearchUrl(url))error('Untrusted research source');
    const canonical=new URL(url);canonical.hash='';
    if(urls.has(canonical.href))error('Duplicate research source');
    urls.add(canonical.href);
    sources.set(source.id,{id:source.id,label:name,url});
  }
  const title=clean(draft.title,180),intro=clean(draft.intro,2200),summary=clean(draft.summary,500);
  if(intro.length<100||summary.length<80)error('Article introduction or summary is incomplete');
  if(!Array.isArray(draft.keyTakeaways)||draft.keyTakeaways.length<3||draft.keyTakeaways.length>7)error('Key takeaways are incomplete');
  if(!Array.isArray(draft.sections)||draft.sections.length<4||draft.sections.length>14)error('A complete article needs multiple substantive sections');
  if(!Array.isArray(draft.faqs)||draft.faqs.length<2||draft.faqs.length>8)error('Article FAQ is missing');
  const takeaways=draft.keyTakeaways.map(x=>clean(x,350));
  const usedIds=new Set();
  const sectionHeadings=new Set();
  const sectionMarkup=draft.sections.map(section=>{
    if(!section||typeof section!=='object')error('Invalid article section');
    const heading=clean(section.heading,150);
    const normalizedHeading=heading.normalize('NFKC').toLowerCase().replace(/\s+/g,' ');
    if(sectionHeadings.has(normalizedHeading))error('Duplicate article section heading');
    sectionHeadings.add(normalizedHeading);
    if(!Array.isArray(section.paragraphs)||section.paragraphs.length<2||section.paragraphs.length>8)error('Section is missing finished prose');
    const paragraphs=section.paragraphs.map(p=>{
      const paragraph=clean(p,2200);
      if(wordCount(paragraph)<18)error('Article sections need complete explanatory paragraphs');
      return paragraph;
    });
    if(!Array.isArray(section.sourceIds)||section.sourceIds.length===0||section.sourceIds.length>6)error('Each substantive section needs cited research');
    const citations=[...new Set(section.sourceIds.map(x=>clean(x,32)))];
    for(const id of citations){if(!sources.has(id))error('AI article cited an unknown source');usedIds.add(id);}
    return '<section><h2>'+esc(heading)+'</h2>'+paragraphs.map(p=>'<p>'+esc(p)+'</p>').join('')+
      '<p>Sources: '+citations.map(id=>'<a href="'+esc(sources.get(id).url)+'">'+esc(sources.get(id).label)+'</a>').join('; ')+'</p></section>';
  }).join('');
  if(usedIds.size<2)error('Article must use more than one independent source');
  const faqQuestions=new Set();
  const faqMarkup=draft.faqs.map(f=>{
    if(!f||typeof f!=='object')error('Invalid FAQ');
    const question=clean(f.question,180),answer=clean(f.answer,900);
    const normalizedQuestion=question.normalize('NFKC').toLowerCase().replace(/\s+/g,' ');
    if(faqQuestions.has(normalizedQuestion))error('Duplicate article FAQ question');
    faqQuestions.add(normalizedQuestion);
    if(wordCount(answer)<18)error('FAQ answers need complete explanations');
    return '<h3>'+esc(question)+'</h3><p>'+esc(answer)+'</p>';
  }).join('');
  const seo=draft.seo;
  if(!seo||typeof seo!=='object')error('Missing complete search metadata');
  const seoTitle=clean(seo.title,70),seoDescription=clean(seo.description,200);
  if(seoDescription.length<90)error('SEO description is incomplete');
  const allProse=[intro,summary,...takeaways,...draft.sections.flatMap(x=>x.paragraphs),...draft.faqs.map(x=>x.answer)].join(' ');
  if(wordCount(allProse)<450||forbidden.test(allProse)||forbidden.test(title))error('AI returned an outline, placeholder or insufficient article text');
  const linkList=[...usedIds].map(id=>{
    const source=sources.get(id);
    return '<li><a href="'+esc(source.url)+'">'+esc(source.label)+'</a></li>';
  }).join('');
  const body='<p>'+esc(intro)+'</p><h2>Key takeaways</h2><ul>'+
    takeaways.map(s=>'<li>'+esc(s)+'</li>').join('')+'</ul>'+
    sectionMarkup+'<section><h2>Frequently asked questions</h2>'+faqMarkup+'</section>'+
    '<section><h2>Sources and further reading</h2><ul>'+linkList+'</ul></section>';
  const article=normalizeArticleCommand('create',{
    title,slug:slugify(title),summary,body,categoryId,tagIds:[],audience:topic.audience,
    seo:{title:seoTitle,description:seoDescription,noindex:true},
    sources:[...usedIds].map(id=>({label:sources.get(id).label,url:sources.get(id).url})),
    author:'PoolDocAI',relatedIds:[],featured:false
  });
  // Caller decides whether to save as a normal private draft. The generator
  // NEVER approves or publishes resources or touches diagnostic knowledge.
  return {article,review:{sourceVerificationRequired:true,technicalReviewRequired:true,
    publicationGranted:false,editorialApprovalGranted:false,topic:topic.topic,wordCount:wordCount(allProse),
    sourceCount:usedIds.size}};
}
