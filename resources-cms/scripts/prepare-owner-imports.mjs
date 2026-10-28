import {readFileSync,readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve,join,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {importDigest,importUUID,validateApprovedImport} from '../src/production/approved-import.mjs';

export function prepareOwnerImports({gateSQL,archiveDirectory,liveDirectory,outputDirectory}) {
 const sql=readFileSync(gateSQL,'utf8');
 if(importDigest(sql)!=='3cd78aa79896d9fb5f148d398cfd57ec115d28a173ee67749ac648b3d10304e7')throw Error('Existing Gate 3B source fingerprint mismatch');
 const tables={};
 for(const match of sql.matchAll(/INSERT INTO resources_cms\.(\w+)[^\n]*?\$cmsdata\$([\s\S]*?)\$cmsdata\$::jsonb/g))tables[match[1]]=JSON.parse(match[2]);
 if(tables.articles?.length!==33||tables.revisions?.length!==41||tables.editorial_holds?.length!==33)throw Error('Gate 3B immutable source inventory mismatch');
 const handoff=JSON.parse(readFileSync(join(archiveDirectory,'PUBLICATION_HANDOFF.json'),'utf8'));
 if(handoff.resource_ids.length!==32||handoff.resource_ids.includes('30'))throw Error('Approved resource register mismatch');
 const envelopes=[];
 const build=(article,history,resourceId,file,approvalStatus,assetStatus,holdReason)=>{
  const bytes=readFileSync(file),source={identity:`${approvalStatus}:${resourceId}:${importDigest(bytes)}`,filename:basename(file),sha256:importDigest(bytes),base64:bytes.toString('base64'),approvalStatus};
  const editable=history.at(-1).editable,bodyChecksum=importDigest(editable.body);
  const blocks=assetStatus==='not-required'?[]:[{key:'asset-review',reason:resourceId==='13'?'Approved PDF delivery and accessibility remain gated':'Required image, diagram or download rights/delivery review remains pending'}];
  const envelope={format:'pooldocai-owner-import-v1',articleId:article.id,resourceId,source,bodyChecksum,article:editable,history,taxonomy:tables.taxonomy,state:'draft',hold:true,holdReason,publicationAuthorized:false,knowledgeEligible:false,assetStatus,blocks};
  envelope.commandId=importUUID(`${article.id}:${source.identity}:${source.sha256}:${bodyChecksum}`);envelopes.push(envelope);return envelope;
 };
 for(const resourceId of handoff.resource_ids){
  const hold=tables.editorial_holds.find(x=>x.resource_number===resourceId);if(!hold)throw Error('Missing protected resource '+resourceId);
  const article=tables.articles.find(a=>a.id===hold.article_id),history=tables.revisions.filter(r=>r.article_id===article.id).sort((a,b)=>a.revision_number-b.revision_number);
  const filename=resourceId==='13'?'Resource_13_Pre_Service_Checklist_approved.pdf':readdirSync(archiveDirectory).find(f=>new RegExp(`^Resource_${resourceId}_.*_approved\\.md$`).test(f));
  if(!filename)throw Error('Missing approved manuscript '+resourceId);
  build(article,history,resourceId,join(archiveDirectory,filename),'editorial-approved',resourceId==='13'?'blocked':['05','14','15','16','17'].includes(resourceId)?'pending-review':'not-required',hold.reason);
 }
 for(const [slug,number]of[['pool-pump-wont-start','legacy-pump'],['green-pool-first-checks','legacy-green']]){
  const article=tables.articles.find(a=>a.slug===slug),history=tables.revisions.filter(r=>r.article_id===article.id&&r.revision_number===1);
  build(article,history,number,join(liveDirectory,slug+'.html'),'historical-live-snapshot','not-required','Historical live copy: migration does not authorize publication');
 }
 for(const entry of envelopes)validateApprovedImport(entry,envelopes);
 const manifest={format:'pooldocai-private-owner-import-index-v1',approvedResourceCount:32,liveSnapshotCount:2,excluded:['30'],gate3BSqlSha256:importDigest(sql),publicationAuthorized:false,knowledgeEligible:false,entries:envelopes.map(e=>({resourceId:e.resourceId,articleId:e.articleId,slug:e.article.slug,title:e.article.title,filename:`${e.resourceId}-${e.article.slug}.json`,sourceChecksum:e.source.sha256,bodyChecksum:e.bodyChecksum,historyRevisionIds:e.history.map(r=>r.id),assetStatus:e.assetStatus,reconcilesExistingLive:e.article.slug==='pool-pump-wont-start',publicationAuthorized:false}))};
 if(outputDirectory){mkdirSync(outputDirectory,{recursive:true});for(const entry of envelopes)writeFileSync(join(outputDirectory,`${entry.resourceId}-${entry.article.slug}.json`),JSON.stringify(entry,null,2)+'\n');writeFileSync(join(outputDirectory,'private-catalog.json'),JSON.stringify(envelopes,null,2)+'\n');writeFileSync(join(outputDirectory,'RECONCILIATION.json'),JSON.stringify(manifest,null,2)+'\n');const literal=s=>"'"+s.replaceAll("'","''")+"'";writeFileSync(join(outputDirectory,'PROPOSED-PRIVATE-IMPORT-ALLOWLIST.sql'),'-- PRIVATE METADATA ONLY. Separate Staging authorization required.\nBEGIN;\nINSERT INTO resources_cms.approved_import_allowlist(source_identity,envelope_checksum) VALUES\n'+envelopes.map(e=>'('+literal(e.source.identity)+','+literal(importDigest(e))+')').join(',\n')+';\nCOMMIT;\n');}
 return{envelopes,manifest};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const root=resolve(new URL('..',import.meta.url).pathname),base=resolve(root,'../baseline/PoolDocAI_Resources_Platform_Local');
 const {manifest}=prepareOwnerImports({gateSQL:process.argv[2]||join(base,'Gate3B/PROPOSED-COMMITTED-IMPORT.sql'),archiveDirectory:process.argv[3]||join(root,'source-archive/approved-v31'),liveDirectory:join(root,'evidence/live'),outputDirectory:process.argv[4]||resolve(root,'../private-imports')});
 console.log(JSON.stringify({approvedResources:manifest.approvedResourceCount,liveSnapshots:manifest.liveSnapshotCount,excluded:manifest.excluded,publicationAuthorized:false}));
}
