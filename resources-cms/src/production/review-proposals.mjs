import { descriptionProposal } from './seo-description.mjs';

// Proposals never mutate input. Candidate edits are re-derived from a saved
// revision on approval, rather than trusted from a browser-supplied diff.
const unitPattern = /\b((?:(?:free|total|combined)\s+)?chlorine|bromine|calcium\s+hardness|total\s+alkalinity|cyanuric\s+acid|stabilizer)\s*[:=\-]?\s*(\d+(?:\.\d+)?)\s*(m)\b/gi;
const plain = html => String(html || '').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const reject = (message, status = 422) => { throw Object.assign(new Error(message), {status}); };

function textNodeHits(html, needle) {
  let hits=0;
  for (const segment of String(html || '').matchAll(/>([^<]*)</g)) {
    hits += segment[1].split(needle).length - 1;
  }
  return hits;
}

export function reviewProposals(article) {
  const proposals=[];
  const seo=String(article?.seo?.description || '').trim();
  if (!seo) {
    const desc=descriptionProposal(article).description;
    if (desc) proposals.push({
      id:'seo-description', kind:'seo-description', field:'seo.description',
      before:'(empty)', after:desc,
      why:'This draft is missing a search description. This suggestion quotes the existing article; it does not verify its technical claims.',
      requiresSourceCheck:false,
    });
  }
  const html=String(article?.body || '');
  const text=plain(html);
  let i=0;
  for (const match of text.matchAll(unitPattern)) {
    const token=match[0].match(/\d+(?:\.\d+)?\s*m\b/i)?.[0];
    if(!token || textNodeHits(html,token)!==1) continue;
    proposals.push({
      id:'unit-'+(i++), kind:'verified-unit', field:'body',
      before:token, after:null, options:['ppm','mg/L'], context:match[0],
      why:'The highlighted pool-water concentration ends with "m", which may be an incomplete or incorrect unit. Check the source before choosing any replacement; the numeric value is not independently verified.',
      requiresSourceCheck:true,
    });
    if(i>=20)break;
  }
  return proposals;
}

function replaceUniqueTextNode(html, token, replacement) {
  let matches=0;
  const result=html.replace(/>([^<]*)</g, (segment, inner) => {
    const count=inner.split(token).length-1;
    matches+=count;
    return count ? '>'+inner.replace(token,replacement)+'<' : segment;
  });
  if(matches!==1)reject('Suggested passage is missing or ambiguous. Review the current article manually.',409);
  return result;
}

export function applyApprovedProposals(article, approvals, proposals = reviewProposals(article)) {
  if(!Array.isArray(approvals)||approvals.length===0||approvals.length>20)reject('Select at least one change to approve');
  if(!approvals.every(a=>a && typeof a==='object' && typeof a.id==='string'))reject('Invalid approval');
  const ids=new Set(), allowed=new Map(proposals.map(p=>[p.id,p])), changed=structuredClone(article), applied=[];
  for(const approval of approvals) {
    if(ids.has(approval.id))reject('Duplicate proposal approval');ids.add(approval.id);
    const proposal=allowed.get(approval.id);
    if(!proposal)reject('Proposal expired or not available for this saved version',409);
    if(proposal.kind==='seo-description') {
      if(Object.keys(approval).some(k=>!['id'].includes(k)))reject('Unsupported description approval');
      changed.seo={...(changed.seo||{}),description:proposal.after};
      applied.push({id:proposal.id,before:proposal.before,after:proposal.after,field:proposal.field});
    } else if(proposal.kind==='verified-unit') {
      if(Object.keys(approval).some(k=>!['id','verifiedUnit','sourceVerified'].includes(k)))reject('Unsupported unit approval');
      if(approval.sourceVerified!==true || !proposal.options.includes(approval.verifiedUnit))reject('Verify the original measurement and choose a supported unit before approval');
      const number=proposal.before.match(/^\d+(?:\.\d+)?/)?.[0];
      if(!number)reject('Unit suggestion changed',409);
      const replacement=number+' '+approval.verifiedUnit;
      changed.body=replaceUniqueTextNode(changed.body,proposal.before,replacement);
      applied.push({id:proposal.id,before:proposal.before,after:replacement,field:proposal.field});
    } else reject('Unsupported proposal');
  }
  return {changed,applied};
}
