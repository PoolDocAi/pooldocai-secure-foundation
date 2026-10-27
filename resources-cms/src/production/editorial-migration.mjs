import {createHash} from 'node:crypto';
// Pure offline conversion. No credentials, network, Auth-user creation or
// publication authorizations. Immutable IDs and all revision snapshots survive.
export function editorialBackup(sqlite,verifiedOwnerId){
 if(!/^[a-f0-9-]{36}$/i.test(verifiedOwnerId||''))throw Error('Verified destination owner UUID required');
 const all=t=>sqlite.prepare(`SELECT * FROM ${t}`).all();
 const tables=['members','taxonomy','editorial_holds','publication_authorizations','articles','revisions','approval_history','knowledge_grants','outbox','redirects','media','audit','settings','taxonomy_redirects','command_receipts'];
 const data=Object.fromEntries(tables.map(t=>[t,[]]));
 data.members=[{user_id:verifiedOwnerId,role:'owner',active:true}];
 const taxonomyId=value=>{const hex=createHash('sha256').update('pooldocai-cms-taxonomy:'+value).digest('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;};
 data.taxonomy=all('taxonomy').map(t=>({...t,id:taxonomyId(t.id),archived:!!t.archived,version:1}));
 data.editorial_holds=all('editorial_holds');
 const articles=all('articles'),snapshots=all('revisions');
 for(const a of articles){
  const latest=snapshots.filter(r=>r.article_id===a.id).sort((x,y)=>y.version-x.version)[0];
  if(!latest)throw Error('Missing immutable revision');
  data.articles.push({id:a.id,slug:a.slug,state:'draft',version:a.version,working_revision_id:latest.id,published_revision_id:null,scheduled_at:null,published_at:null,created_at:a.created_at,updated_at:a.updated_at});
  if(!data.editorial_holds.some(h=>h.article_id===a.id))data.editorial_holds.push({article_id:a.id,resource_number:'legacy',source_checksum:createHash('sha256').update(a.data).digest('hex'),reason:'Historical live copy: migration does not authorize publication'});
 }
 for(const r of snapshots){const c=JSON.parse(r.data),mapped={...c,categoryId:taxonomyId(c.categoryId),tagIds:(c.tagIds||[]).map(taxonomyId)};data.revisions.push({id:r.id,article_id:r.article_id,revision_number:r.version,editable:mapped,rendered_html:c.body,content_checksum:createHash('sha256').update(r.data).digest('hex'),primary_category_id:mapped.categoryId,tag_ids:mapped.tagIds,sources:c.sources||[],audience:c.audience||'homeowners',created_by:verifiedOwnerId,created_at:r.created_at});}
 data.audit=all('audit').map(a=>({id:a.id,actor_id:verifiedOwnerId,action:a.action,article_id:a.resource_id,detail:{...JSON.parse(a.detail),originalLocalActor:a.actor_id},created_at:a.created_at}));
 data.settings=all('settings').map(s=>({...s,data:JSON.parse(s.data)}));
 return {format:'resources-cms-postgres-v2',createdAt:new Date().toISOString(),data,mediaBytesIncluded:false,indexingConnected:false};
}
