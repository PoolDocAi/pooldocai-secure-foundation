// LOCAL acceptance evidence only: real loopback HTTP + PGlite SQL. Supabase
// Auth signing and the PostgREST transport are mocked; no hosted claim is made.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {PGlite} from '@electric-sql/pglite';
import {SupabaseDataCMS} from '../src/production/supabase-data.mjs';
import {createProductionApp} from '../src/production/app.mjs';
import {toWebRequest,sendWebResponse} from '../src/production/node-http.mjs';
import {ownerRecoveryProposal} from '../scripts/owner-recovery-proposal.mjs';
import {importDigest} from '../src/production/approved-import.mjs';

const owner='00000000-0000-4000-8000-000000000001',nonmember='00000000-0000-4000-8000-000000000099';
const origin='https://owner-cms.example.test',sourcePath=resolve('../private-imports/private-catalog.json');
const catalog=JSON.parse(readFileSync(sourcePath,'utf8'));
const localV2=s=>s.replace(/DO \$guard\$ BEGIN\n IF current_user<>'postgres'[\s\S]*?END \$guard\$;\n/,'').replace(/-- This is a second, grantor-specific row\.[\s\S]*?END \$guard\$;\n/,'').replace(/-- Remove only the temporary row granted by postgres\.[\s\S]*?END \$guard\$;\n/,'');
const localProposal=s=>s.replace(/DO \$preflight\$[\s\S]*?\$preflight\$;/,'').replace('GRANT resources_cms_command_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;','').replace('REVOKE resources_cms_command_owner FROM postgres GRANTED BY postgres RESTRICT;','').replace(/DO \$postflight\$[\s\S]*?\$postflight\$;/,'');

test('owner launch acceptance over real local HTTP and SQL: two live snapshots, one approved import, release/recovery and draft privacy',{timeout:60000},async t=>{
 const pg=new PGlite();const originalFetch=globalThis.fetch;let server,transport;let sequence=Promise.resolve();const tokens=new Map([['fixture-owner',owner],['fixture-nonmember',nonmember]]);
 const serialized=operation=>{const next=sequence.then(operation);sequence=next.catch(()=>{});return next;};
 try{
  await pg.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE ROLE authenticator;GRANT anon,authenticated TO authenticator;');
  await pg.exec(readFileSync('supabase/migrations/20261026035555_resources_cms_isolated_v1.sql','utf8'));
  await pg.exec(localV2(readFileSync('supabase/migrations/20261026042156_resources_cms_commands_v2.sql','utf8')));
  await pg.exec(localProposal(ownerRecoveryProposal()));
  for(const e of catalog)await pg.query('INSERT INTO resources_cms.approved_import_allowlist VALUES($1,$2)',[e.source.identity,importDigest(e)]);
  await pg.query('INSERT INTO resources_cms.members VALUES($1,\'owner\',true)',[owner]);
  const mockFetch=async(input,options={})=>{
   const url=new URL(input),headers=new Headers(options.headers),bearer=headers.get('authorization')?.replace(/^Bearer /,'');
   if(url.hostname==='127.0.0.1')return originalFetch(input,options);
   if(url.pathname==='/auth/v1/token')return Response.json({access_token:'fixture-owner',refresh_token:'fixture-refresh',expires_in:3600});
   if(url.pathname==='/auth/v1/user')return tokens.has(bearer)?Response.json({id:tokens.get(bearer),email:'owner@example.invalid',is_anonymous:false}):Response.json({error:'invalid fixture token'},{status:401});
   if(url.pathname==='/auth/v1/logout'){tokens.delete(bearer);return Response.json({});}
   if(!url.pathname.startsWith('/rest/v1/rpc/'))return Response.json({error:'Unsupported fixture route'},{status:404});
   const name=url.pathname.split('/').at(-1),payload=JSON.parse(options.body||'{}');
   assert.match(name,/^[a-z_]+$/);for(const key of Object.keys(payload))assert.match(key,/^[a-z_]+$/);
   return serialized(async()=>{
    const role=bearer==='fixture-publishable'?'anon':tokens.has(bearer)?'authenticated':null;
    if(!role)return Response.json({message:'Invalid fixture JWT'},{status:401});
    await pg.exec('SET SESSION AUTHORIZATION postgres;RESET ROLE;SET SESSION AUTHORIZATION authenticator;SET ROLE '+role);
    await pg.query("SELECT set_config('request.jwt.claims',$1,false)",[JSON.stringify({role,...(role==='authenticated'?{sub:tokens.get(bearer)}:{})})]);
    try{
     const keys=Object.keys(payload),values=Object.values(payload).map(x=>x&&typeof x==='object'?JSON.stringify(x):x);
     const sql=`SELECT resources_cms.${name}(${keys.map((key,i)=>`${key} => $${i+1}`).join(',')}) result`;
     if(name==='public_index')return Response.json((await pg.query(`SELECT * FROM resources_cms.${name}(${keys.map((key,i)=>`${key} => $${i+1}`).join(',')})`,values)).rows);
     return Response.json((await pg.query(sql,values)).rows[0].result);
    }catch(error){return Response.json({message:error.message,code:error.code},{status:error.code==='42501'?403:400});}
   });
  };
  globalThis.fetch=mockFetch;
  const db=new SupabaseDataCMS({url:'https://fixture.supabase.invalid',publishableKey:'fixture-publishable',fetchImpl:mockFetch});
  const app=createProductionApp({db,config:{supabaseUrl:'https://fixture.supabase.invalid',publishableKey:'fixture-publishable',origin,ownerPublishing:true,approvedImportCatalogPath:sourcePath,features:{}}});
  server=createServer(async(req,res)=>{try{await sendWebResponse(res,await app(await toWebRequest(req)));}catch(error){res.statusCode=500;res.end(JSON.stringify({error:error.message}));}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));transport='http://127.0.0.1:'+server.address().port;
  let cookie='',csrf='';
  const call=(path,method='GET',body,options={})=>originalFetch(transport+path,{method,headers:{host:new URL(origin).host,origin,...(!options.anonymous&&cookie?{cookie}:{}),...(method!=='GET'?{'content-type':'application/json','x-csrf-token':csrf}:{}),...(options.headers||{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const json=async(response,status=200)=>{const text=await response.text();assert.equal(response.status,status,text);return JSON.parse(text);};
  // Keep response parsing explicit to prevent promises being mistaken for Responses.
  const readArticle=async id=>json(await call(`/api/content/${id}`));
  const action=async(a,name)=>json(await call(`/api/content/${a.id}/${name}`,'POST',{version:a.version}));
  const importOne=async resourceId=>{const e=catalog.find(x=>x.resourceId===resourceId);return json(await call('/api/approved-resources','POST',{sourceIdentity:e.source.identity,sourceChecksum:e.source.sha256}));};
  const publish=async a=>{
   a=await action(a,'review');a=await action(a,'approve');const info=await json(await call(`/api/content/${a.id}/release`));
   return json(await call(`/api/content/${a.id}/publish`,'POST',{commandId:randomUUID(),version:info.version,revisionId:info.revisionId,checksum:info.checksum,destination:info.destination,confirm:true,holdChecksum:info.holdChecksum}));
  };
  let pump,green,additional;
  await t.test('owner login UUID and member role verified; unauthenticated and forged-session API denied',async()=>{
   assert.equal((await call('/api/content','GET',undefined,{anonymous:true})).status,401);
   assert.equal((await call('/api/approved-resources','GET',undefined,{headers:{cookie:'__Host-pooldocai-cms-access=forged'}})).status,401);
   const login=await call('/api/login','POST',{email:'owner@example.invalid',password:'synthetic-fixture-only'});const data=await json(login);assert.equal(data.id,owner);assert.equal(data.role,'owner');csrf=data.csrf;cookie=login.headers.getSetCookie().map(x=>x.split(';',1)[0]).join('; ');
   assert.equal((await json(await call('/api/me'))).id,owner);
   const list=await json(await call('/api/approved-resources'));assert.equal(list.length,34);assert.ok(!list.some(x=>x.resourceId==='30'));assert.ok(!JSON.stringify(list).includes('base64'));
  });
  await t.test('both original live article snapshots load with preserved identities and remain private before owner release',async()=>{
   pump=await importOne('legacy-pump');green=await importOne('legacy-green');assert.equal(pump.id,catalog.find(x=>x.resourceId==='legacy-pump').articleId);assert.equal(green.id,catalog.find(x=>x.resourceId==='legacy-green').articleId);
   assert.equal(pump.published,false);assert.equal((await call('/resources/pool-pump-wont-start/','GET',undefined,{anonymous:true})).status,404);
   assert.equal((await call('/preview/'+pump.id,'GET',undefined,{anonymous:true})).status,401);
   const preview=await call('/preview/'+pump.id);assert.equal(preview.status,200);assert.match(preview.headers.get('x-robots-tag'),/noindex/);
   assert.equal((await importOne('legacy-pump')).version,pump.version);
  });
  await t.test('explicit owner revision release publishes both original snapshots with their canonical URLs',async()=>{
   pump=await publish(pump);green=await publish(green);for(const slug of['pool-pump-wont-start','green-pool-first-checks']){const response=await call('/resources/'+slug+'/','GET',undefined,{anonymous:true});assert.equal(response.status,200);assert.match(await response.text(),new RegExp('https://pooldocai.com/resources/'+slug+'/'));}
  });
  await t.test('pump draft/release/rollback and later approved replacement preserve public state and immutable history',async()=>{
   const old=await(await call('/resources/pool-pump-wont-start/','GET',undefined,{anonymous:true})).text();const marker='Synthetic local owner editing acceptance marker';
   pump=await json(await call('/api/content/'+pump.id,'PUT',{...pump.data,body:pump.data.body+'<p>'+marker+'</p>',version:pump.version}));
   const persisted=await readArticle(pump.id);assert.match(persisted.data.body,new RegExp(marker));assert.ok(!(await(await call('/resources/pool-pump-wont-start/','GET',undefined,{anonymous:true})).text()).includes(marker));assert.equal(await(await call('/resources/pool-pump-wont-start/','GET',undefined,{anonymous:true})).text(),old);
   assert.match(await(await call('/preview/'+pump.id)).text(),new RegExp(marker));pump=await publish(pump);assert.match(await(await call('/resources/pool-pump-wont-start/','GET',undefined,{anonymous:true})).text(),new RegExp(marker));const publishedAfterEdit=await(await call('/resources/pool-pump-wont-start/','GET',undefined,{anonymous:true})).text();const originalRevision=catalog.find(e=>e.resourceId==='legacy-pump').history[0].id;pump=await json(await call('/api/content/'+pump.id+'/rollback','POST',{version:pump.version,revisionId:originalRevision}));assert.equal(pump.status,'draft');assert.ok(!pump.data.body.includes(marker));assert.equal(await(await call('/resources/pool-pump-wont-start/','GET',undefined,{anonymous:true})).text(),publishedAfterEdit);assert.equal((await json(await call('/api/content/'+pump.id+'/revisions'))).length,3);const beforeApprovedImport=pump.version;const beforeApprovedPublic=await(await call('/resources/pool-pump-wont-start/','GET',undefined,{anonymous:true})).text();const preservedRows=await serialized(async()=>{await pg.exec('SET SESSION AUTHORIZATION postgres;RESET ROLE');return(await pg.query('SELECT * FROM resources_cms.revisions WHERE article_id=$1 ORDER BY revision_number',[pump.id])).rows;});pump=await importOne('01');const approvedSource=catalog.find(e=>e.resourceId==='01');assert.equal(pump.id,approvedSource.articleId);assert.equal(pump.status,'draft');assert.deepEqual(pump.data,approvedSource.article);assert.ok(pump.version>beforeApprovedImport);assert.equal(await(await call('/resources/pool-pump-wont-start/','GET',undefined,{anonymous:true})).text(),beforeApprovedPublic);await serialized(async()=>{await pg.exec('SET SESSION AUTHORIZATION postgres;RESET ROLE');const rows=(await pg.query('SELECT * FROM resources_cms.revisions WHERE article_id=$1 ORDER BY revision_number',[pump.id])).rows;assert.deepEqual(rows.slice(0,preservedRows.length),preservedRows);const newRow=rows.find(r=>r.id===approvedSource.history.at(-1).id);assert.ok(newRow.revision_number>beforeApprovedImport);const provenance=(await pg.query('SELECT envelope FROM resources_cms.owner_import_sources WHERE article_id=$1 AND source_checksum=$2',[pump.id,approvedSource.source.sha256])).rows[0].envelope;assert.equal(provenance.history.at(-1).revision_number,2);const event=(await pg.query("SELECT detail FROM resources_cms.audit WHERE article_id=$1 AND action='owner_approved_draft_import' ORDER BY created_at DESC LIMIT 1",[pump.id])).rows[0].detail;assert.ok(event.revisionMapping.some(m=>m.revisionId===newRow.id&&m.sourceRevisionNumber===2&&m.storedRevisionNumber===newRow.revision_number));});const repeated=await importOne('01');assert.equal(repeated.version,pump.version);
  });
  await t.test('green article saves a separate draft while its original public revision remains unchanged',async()=>{
   const old=await(await call('/resources/green-pool-first-checks/','GET',undefined,{anonymous:true})).text();green=await json(await call('/api/content/'+green.id,'PUT',{...green.data,body:green.data.body+'<p>Private green acceptance marker</p>',version:green.version}));assert.match((await readArticle(green.id)).data.body,/Private green acceptance/);assert.equal(await(await call('/resources/green-pool-first-checks/','GET',undefined,{anonymous:true})).text(),old);
  });
  await t.test('one approved resource is individually imported and published without importing the remaining collection',async()=>{
   additional=await importOne('11');assert.equal((await call('/resources/'+additional.data.slug+'/','GET',undefined,{anonymous:true})).status,404);assert.equal(additional.data.seo.noindex,true);additional=await json(await call('/api/content/'+additional.id,'PUT',{...additional.data,seo:{...additional.data.seo,noindex:false},version:additional.version}));const draftPreview=await call('/preview/'+additional.id);assert.equal(draftPreview.status,200);assert.match(draftPreview.headers.get('x-robots-tag'),/noindex/);additional=await publish(additional);assert.equal((await call('/resources/'+additional.data.slug+'/','GET',undefined,{anonymous:true})).status,200);assert.equal((await json(await call('/api/content'))).length,3);const sitemap=await(await call('/resources-sitemap.xml','GET',undefined,{anonymous:true})).text();assert.match(sitemap,new RegExp(additional.data.slug));
  });
  await t.test('unpublish and archive/restore fail closed; stale publication and nonmember privileges remain denied',async()=>{
   const info=await json(await call(`/api/content/${additional.id}/release`));additional=await action(additional,'unpublish');assert.equal((await call('/resources/'+additional.data.slug+'/','GET',undefined,{anonymous:true})).status,404);additional=await action(additional,'archive');additional=await action(additional,'restore');assert.equal(additional.status,'draft');assert.equal(additional.published,false);assert.equal((await call('/resources/'+additional.data.slug+'/','GET',undefined,{anonymous:true})).status,404);
   const stale=await call(`/api/content/${additional.id}/publish`,'POST',{commandId:randomUUID(),version:info.version,revisionId:info.revisionId,checksum:info.checksum,destination:'staging',confirm:true,holdChecksum:info.holdChecksum});assert.ok(stale.status>=400);
   const denied=await call('/api/approved-resources','GET',undefined,{headers:{cookie:'__Host-pooldocai-cms-access=fixture-nonmember'}});assert.ok([400,403].includes(denied.status));assert.match(await denied.text(),/authorization|membership|Owner required/i);
   assert.equal((await json(await call('/api/content'))).filter(x=>x.knowledge?.status==='approved').length,0);
   const logout=await call('/api/logout','POST',{});assert.equal(logout.status,200);assert.ok(logout.headers.getSetCookie().every(x=>x.includes('Max-Age=0')));assert.equal((await call('/api/me')).status,401);
  });
 }finally{globalThis.fetch=originalFetch;if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await sequence;await pg.close();}
});
