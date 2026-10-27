import {createHash} from 'node:crypto';
import {esc} from '../content.mjs';
import {facetList} from './taxonomy.mjs';
export const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export function installCatalog(db){db.exec('CREATE TABLE IF NOT EXISTS live_verifications(article_id TEXT PRIMARY KEY REFERENCES articles(id),revision_id TEXT NOT NULL REFERENCES revisions(id),canonical TEXT NOT NULL,checksum TEXT NOT NULL,verified_at TEXT NOT NULL,revoked_at TEXT)');}
// Offline release-verifier entry point only. Deliberately has no HTTP admin command.
export function verifyLocalPublication(db,id,revisionId,{canonical,checksum,verifiedAt}){
 const row=db.prepare('SELECT * FROM articles WHERE id=?').get(id),revision=db.prepare('SELECT * FROM revisions WHERE id=? AND article_id=?').get(revisionId,id);
 if(!row||row.status!=='published'||!row.published||!revision||row.version!==revision.version||digest(row.published)!==checksum||!/^https:\/\/pooldocai\.com\/resources\/[a-z0-9-]+\/$/.test(canonical)||!Number.isFinite(Date.parse(verifiedAt)))throw Error('Exact published revision and independent verification receipt required');
 db.prepare('INSERT INTO live_verifications VALUES(?,?,?,?,?,NULL) ON CONFLICT(article_id) DO UPDATE SET revision_id=excluded.revision_id,canonical=excluded.canonical,checksum=excluded.checksum,verified_at=excluded.verified_at,revoked_at=NULL').run(id,revisionId,canonical,checksum,verifiedAt);
}
export function localPublishedRows(db){
 const tags=facetList(db),byId=new Map(tags.map(t=>[t.tag_id,t]));
 return db.prepare("SELECT a.*,v.revision_id,v.canonical,v.checksum FROM articles a JOIN live_verifications v ON v.article_id=a.id JOIN revisions r ON r.id=v.revision_id AND r.article_id=a.id WHERE a.status='published' AND a.published IS NOT NULL AND v.revoked_at IS NULL").all().flatMap(row=>{
  if(digest(row.published)!==row.checksum)return [];
  const d=JSON.parse(row.published);if(d.seo?.noindex)return [];
  const expected=`https://pooldocai.com/resources/${row.slug}/`;if(row.canonical!==expected)return [];
  const ids=[...new Set((d.tagIds||[]))];
  const facets=ids.map(id=>byId.get(id)).filter(t=>t&&!t.archived&&!t.merged_into).map(t=>({id:t.tag_id,group:t.facet,slug:t.slug,name:t.label,aliases:t.aliases}));
  return [{id:row.id,revisionId:row.revision_id,slug:row.slug,url:row.canonical,title:d.title,summary:d.summary,tagIds:ids,tags:facets,audience:d.audience,categoryId:d.categoryId,manufacturer:d.manufacturer||null,model:d.model||null,publishedAt:d.publishedAt||null,updatedAt:d.updatedAt||null}];
 });
}
export function discover(rows,{query='',tags=[],path='',slug='',limit=50,offset=0}={}){
 const safeQuery=String(query).normalize('NFKC').toLowerCase().trim().slice(0,120), selected=[...new Set(tags)].slice(0,20);
 const result=rows.filter(r=>(!slug||r.slug===slug)&&(path!=='whats-wrong'||r.tags.some(t=>t.group==='issue'))&&(!safeQuery||[r.title,r.summary,...r.tags.flatMap(t=>[t.name,t.slug,...t.aliases])].join(' ').toLowerCase().includes(safeQuery))&&selected.every(id=>r.tagIds.includes(id)));
 const facets=[...new Map(rows.flatMap(r=>r.tags).map(t=>[t.id,t])).values()].map(t=>({...t,count:rows.filter(r=>r.tagIds.includes(t.id)).length}));
 return {items:result.slice(offset,offset+Math.min(100,limit)),nextOffset:offset+limit<result.length?offset+limit:null,total:result.length,facets:facets.filter(t=>path!=='whats-wrong'||t.group==='issue'),paths:[{id:'whats-wrong',name:"What's wrong?"},{id:'equipment-and-guides',name:'Equipment & guides'}],measurement:'Only verified published revisions; no draft-derived facets'};
}
export function renderDiscovery(result,params=new URLSearchParams(),{assistant=false,analytics=false}={}){
 const next=new URLSearchParams(params);if(result.nextOffset!==null)next.set('offset',String(result.nextOffset));
 const card=r=>`<article><h2><a data-analytics-id="hub.resource.open" data-analytics-event="resource_open" data-content-id="${esc(r.id)}" href="${esc(r.url)}">${esc(r.title)}</a></h2><p>${esc(r.summary)}</p></article>`;
 return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pool resources · PoolDocAI</title><meta name="description" content="Find verified published pool care resources by symptom, equipment or guide type."><meta name="robots" content="${params.size?'noindex, follow':'index, follow'}"><link rel="canonical" href="https://pooldocai.com/resources/"><link rel="stylesheet" href="/public/platform.css"></head><body class="platform-public" data-resource-total="${result.total}"><a class="skip" href="#main">Skip to resources</a><header><a href="/">PoolDocAI</a><nav aria-label="Find resources">${result.paths.map(p=>`<a data-analytics-id="hub.nav.${p.id}" data-analytics-event="nav_section_select" href="?path=${p.id}">${esc(p.name)}</a>`).join('')}</nav></header><main id="main"><h1>Clearer water. Clearer answers.</h1><form method="get" data-analytics-id="hub.search"><input type="hidden" name="path" value="${esc(params.get('path')||'')}"><label>Search resources<input name="q" maxlength="120" value="${esc(params.get('q')||'')}"></label><label>Published topic<select name="tag" data-analytics-id="hub.filter.topic" data-analytics-event="nav_filter_apply"><option value="">All topics</option>${result.facets.map(t=>`<option value="${esc(t.id)}" ${params.get('tag')===t.id?'selected':''}>${esc(t.group)}: ${esc(t.name)} (${t.count})</option>`).join('')}</select></label><button data-analytics-id="hub.search.submit" data-analytics-event="search_submit">Search</button></form><p role="status">${result.total} verified published resources</p><div class="resource-grid">${result.items.map(card).join('')||'<p>No verified guide is available yet. Try a broader topic.</p>'}</div>${result.nextOffset!==null?`<a data-analytics-id="hub.next" href="?${esc(next.toString())}">More resources</a>`:''}</main><footer><a href="/privacy.html">Privacy</a></footer>${analytics?'<script src="/public/resource-analytics.js" defer></script>':''}${assistant?'<script src="/public/resource-assistant.js" defer></script>':''}</body></html>`;
}

export function catalogSitemap(rows){return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${["https://pooldocai.com/","https://pooldocai.com/resources/",...rows.map(r=>r.url)].map(u=>`<url><loc>${esc(u)}</loc></url>`).join("")}</urlset>`;}

// Disabled flags preserve legacy bytes. Called only after the public revision gate.
export function addPublicCapabilities(html,{analytics=false,assistant=false}={}){if(!analytics&&!assistant)return html;const scripts=(analytics?'<script src="/public/resource-analytics.js" defer></script>':'')+(assistant?'<script src="/public/resource-assistant.js" defer></script>':'');if(assistant)html=html.replace(/<\/head>/i,'<link rel="stylesheet" href="/public/platform.css"></head>');return html.replace(/<\/body>\s*<\/html>\s*$/i,scripts+'</body></html>');}
