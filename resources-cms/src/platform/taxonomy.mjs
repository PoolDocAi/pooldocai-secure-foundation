import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {transaction,audit} from '../store.mjs';
export const specification=JSON.parse(readFileSync(new URL('../../config/taxonomy-v3.json',import.meta.url)));
export const groups=Object.keys(specification.cms_editable_taxonomy.taxonomy_groups);
export const slugify=s=>String(s||'').normalize('NFKC').trim().toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
const error=(s,m)=>{throw Object.assign(Error(m),{status:s});};
export function stableTagId(group,slug){const h=createHash('sha256').update('pooldocai:facet:'+group+':'+slug).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;}
export function installTaxonomy(db){
 db.exec(`CREATE TABLE IF NOT EXISTS facet_tags(tag_id TEXT PRIMARY KEY REFERENCES taxonomy(id),facet TEXT NOT NULL,slug TEXT NOT NULL,label TEXT NOT NULL,aliases TEXT NOT NULL DEFAULT '[]',parent_id TEXT REFERENCES facet_tags(tag_id),evidence_url TEXT,version INTEGER NOT NULL DEFAULT 1,merged_into TEXT REFERENCES facet_tags(tag_id),UNIQUE(facet,slug));
 CREATE TABLE IF NOT EXISTS facet_requests(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,facet TEXT NOT NULL,label TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',created_at TEXT NOT NULL);`);
 transaction(db,()=>{let count=0;for(const [facet,terms] of Object.entries(specification.cms_editable_taxonomy.taxonomy_groups))for(const slug of terms){
  const id=stableTagId(facet,slug), label=slug.replaceAll('-',' '), aliases=Object.entries(specification.cms_editable_taxonomy.tag_schema.tag_alias_examples).filter(([a,b])=>b===slug&&a!==slug).map(([a])=>a);
  db.prepare('INSERT OR IGNORE INTO taxonomy(id,kind,name,position,archived) VALUES(?,?,?, ?,0)').run(id,'tag',facet+' · '+label,count++);
  db.prepare('INSERT OR IGNORE INTO facet_tags(tag_id,facet,slug,label,aliases) VALUES(?,?,?,?,?)').run(id,facet,slug,label,JSON.stringify(aliases));
 }});
}
export function facetList(db){return db.prepare('SELECT f.*,t.archived FROM facet_tags f JOIN taxonomy t ON t.id=f.tag_id ORDER BY f.facet,f.label').all().map(t=>({...t,aliases:JSON.parse(t.aliases)}));}
export function validateTag(input,existing=[]){
 const facet=String(input.facet||''),label=String(input.label||'').normalize('NFKC').trim(),slug=slugify(input.slug||label);
 if(!groups.includes(facet)||label.length<2||label.length>100||slug.length<2||slug.length>100)error(422,'Valid facet, name and slug required');
 if(!Array.isArray(input.aliases||[]))error(422,'Aliases must be an array');
 const aliases=[...new Set((input.aliases||[]).map(slugify))].filter(a=>a&&a!==slug);
 if(!Array.isArray(input.aliases||[])||aliases.length>20||aliases.some(a=>a.length>100))error(422,'At most 20 short aliases permitted');
 const names=new Set([slug,...aliases]);
 if(existing.some(t=>t.facet===facet&&t.tag_id!==input.id&&[t.slug,...t.aliases].some(a=>names.has(a))))error(409,'Tag or alias already exists in this facet');
 if(['brand','model','model_family'].includes(facet)){
  if(!/^https:\/\/[a-z0-9.-]+\//i.test(String(input.evidence_url||''))||input.catalogReviewed!==true)error(422,'Owner-reviewed manufacturer evidence required for catalog entities');
  const parent=existing.find(t=>t.tag_id===input.parent_id&&!t.archived);
  if(facet==='model_family'&&parent?.facet!=='brand'||facet==='model'&&!['brand','model_family'].includes(parent?.facet))error(422,'Verified brand or model-family parent required');
 }
 return {facet,label,slug,aliases,parent_id:input.parent_id||null,evidence_url:input.evidence_url||null};
}
export function facetCommand(db,user,input,saveRevision){
 if(user.role!=='owner')error(403,'Owner taxonomy permission required');
 return transaction(db,()=>{
  const rows=facetList(db),old=rows.find(t=>t.tag_id===input.id);
  if(input.action!=='create'&&(!old||old.version!==input.version))error(409,'Tag changed; reload before retry');
  if(input.action==='create'||input.action==='update'){
   const data=validateTag({...old,...input},rows),id=old?.tag_id||randomUUID();
   if(old&&old.facet!==data.facet)error(422,'Facet identity cannot be changed');
   if(old){db.prepare('UPDATE facet_tags SET label=?,slug=?,aliases=?,parent_id=?,evidence_url=?,version=version+1 WHERE tag_id=?').run(data.label,data.slug,JSON.stringify(data.aliases),data.parent_id,data.evidence_url,id);db.prepare('UPDATE taxonomy SET name=? WHERE id=?').run(data.facet+' · '+data.label,id);}
   else{db.prepare('INSERT INTO taxonomy(id,kind,name,position,archived) VALUES(?,\'tag\',?,999,0)').run(id,data.facet+' · '+data.label);db.prepare('INSERT INTO facet_tags(tag_id,facet,slug,label,aliases,parent_id,evidence_url) VALUES(?,?,?,?,?,?,?)').run(id,data.facet,data.slug,data.label,JSON.stringify(data.aliases),data.parent_id,data.evidence_url);}
   audit(db,user.id,'facet_'+input.action,id,{facet:data.facet,slug:data.slug});return {id};
  }
  if(input.action==='merge'){
   const target=rows.find(t=>t.tag_id===input.targetId&&!t.archived&&!t.merged_into);
   if(!target||target.facet!==old.facet||target.tag_id===old.tag_id)error(422,'Choose an active target in the same facet');
   if(rows.some(t=>t.parent_id===old.tag_id))error(409,'Reassign catalog children before merging');
   const aliases=[...new Set([...target.aliases,old.slug,...old.aliases])].filter(a=>a!==target.slug);
   for(const row of db.prepare('SELECT * FROM articles').all()) {const d=JSON.parse(row.data);if(d.tagIds?.includes(old.tag_id)){d.tagIds=[...new Set(d.tagIds.map(x=>x===old.tag_id?target.tag_id:x))];saveRevision(row,d,user.id,'facet_merge');}}
   db.prepare('UPDATE facet_tags SET aliases=?,version=version+1 WHERE tag_id=?').run(JSON.stringify(aliases),target.tag_id);
   db.prepare('UPDATE facet_tags SET merged_into=?,version=version+1 WHERE tag_id=?').run(target.tag_id,old.tag_id);db.prepare('UPDATE taxonomy SET archived=1 WHERE id=?').run(old.tag_id);
  }else if(input.action==='deprecate'){
   if(rows.some(t=>t.parent_id===old.tag_id))error(409,'Catalog entity has children');
   if(db.prepare('SELECT data,published FROM articles').all().some(r=>[r.data,r.published].filter(Boolean).some(s=>JSON.parse(s).tagIds?.includes(old.tag_id))))error(409,'Reassign working revisions and review published use before retiring');
   db.prepare('UPDATE taxonomy SET archived=1 WHERE id=?').run(old.tag_id);db.prepare('UPDATE facet_tags SET version=version+1 WHERE tag_id=?').run(old.tag_id);
  }else error(422,'Unsupported tag action');
  audit(db,user.id,'facet_'+input.action,old.tag_id,{target:input.targetId||null});return {ok:true};
 });
}
export function placement(tags,ids){const selected=tags.filter(t=>ids.includes(t.tag_id)&&!t.archived);return {publiclyVisible:false,whenPublished:{'whats-wrong':selected.filter(t=>t.facet==='issue').map(t=>t.label),'equipment-and-guides':selected.filter(t=>['equipment','content_type','brand','model','model_family','maintenance_task'].includes(t.facet)).map(t=>t.label)},missing:['equipment','content_type','audience'].filter(g=>!selected.some(t=>t.facet===g))};}
