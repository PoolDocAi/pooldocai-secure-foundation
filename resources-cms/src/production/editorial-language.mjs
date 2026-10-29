// Read-only, conservative editorial suggestions. These are drafting hints, not
// proof that the original language is incorrect, and never trigger a write.
const fields=['title','summary','body','seo.title','seo.description'];
const sourceValue=(article,field)=>String(field.startsWith('seo.')?article.seo?.[field.slice(4)]??'':article[field]??'');
const sections=(article,field)=>{
  const raw=sourceValue(article,field);
  return field==='body'
    ? [...raw.matchAll(/>([^<]*)</g)].map(m=>({text:m[1],offset:m.index+1}))
    : [{text:raw,offset:0}];
};
const phraseRules=[
  {re:/\b(?:could|should|would)\s+of\b/gi,after:match=>match[0].replace(/\bof\b/i,'have'),
   why:'"Could of", "should of", or "would of" is usually written with "have". Confirm that the sentence is intended as a statement about possibility or obligation.'},
  {re:/\b(a)\s+(algae|acid|equipment|inspection|inlet|outlet|overflow)\b/gi,
   after:match=>match[0].replace(/\b[aA]\b/,m=>m==='A'?'An':'an'),
   why:'A word beginning with a vowel sound normally takes "an" rather than "a". Verify the phrase still describes the intended equipment or procedure.'},
];
function proposal(field,segment,start,before,after,why,kind) {
  if(before===after)return null;
  const local=start-segment.offset;
  return {
    id:'language-'+field.replace('.','-')+'-'+start,
    kind:'editorial-text', field,start,before,after,
    context:segment.text.slice(Math.max(0,local-55),Math.min(segment.text.length,local+before.length+65)),
    highlightOffset:local-Math.max(0,local-55),
    why,category:kind,requiresSourceCheck:false
  };
}
export function languageSuggestions(article,limit=20) {
  const all=[];
  for(const field of fields)for(const section of sections(article,field)){
    const found=[];
    const add=(match,after,why,category)=>{
      const start=section.offset+match.index;
      // Never present two conflicting corrections for the same exact span.
      if(found.some(p=>start<p.start+p.before.length&&p.start<start+match[0].length))return;
      const p=proposal(field,section,start,match[0],after,why,category);
      if(p)found.push(p);
    };
    for(const rule of phraseRules)for(const m of section.text.matchAll(rule.re)){
      add(m,rule.after(m),rule.why,'grammar');
    }
    // Repeated words are strong clues but may occasionally be intentional.
    const repeats=/\b([A-Za-z]{2,})[ \t]+\1\b/gi;
    for(const match of section.text.matchAll(repeats)){
      add(match,match[1],'The same word occurs twice consecutively. Check whether the repetition was intentional; otherwise approve removing the second copy.','repetition');
    }
    // Skip tabs/newlines and nontext HTML; visual alignment may be deliberate.
    const spaces=/\b[A-Za-z]{2,}\b([ \t]{2,})\b[A-Za-z]{2,}\b/g;
    for(const match of section.text.matchAll(spaces)){
      const before=match[1],local=match.index+match[0].indexOf(before);
      add({index:local,0:before},' ','There are several spaces between words. Check whether this is intentional before replacing them with one space.','spacing');
    }
    found.sort((a,b)=>a.start-b.start);
    for(const item of found){
      all.push(item);
      if(all.length>=limit)return all;
    }
  }
  return all;
}

export function longSentenceFindings(article,max=3) {
  const value=String(article.body||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
  const sentences=value.split(/(?<=[.!?])\s+/);
  return sentences.filter(s=>s.length>200&&s.split(/\s+/).length>=55&&/[.!?]$/.test(s))
    .slice(0,max).map(s=>({
      area:'readability',severity:'needs-human-review',field:'body',
      evidence:s.slice(0,120),excerpt:s.slice(0,230),highlight:s.slice(0,Math.min(55,s.length)),
      why:'This sentence has more than 55 words. Consider splitting it into smaller steps without changing the technical meaning.',
      suggestion:'Review the entire sentence for clarity and accuracy; any rewrite requires your manual approval.'
    }));
}
