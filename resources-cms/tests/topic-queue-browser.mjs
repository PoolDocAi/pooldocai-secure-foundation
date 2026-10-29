import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import {compatibilityRoute} from '../src/production/compat-api.mjs';
import {sendWebResponse} from '../src/production/node-http.mjs';
const categoryId=randomUUID(),topics=new Map(),articles=new Map(),commands=[],errors=[];
let generations=0;
const db={list:async()=>[...articles.values()],knowledgeStatuses:async()=>[],recentAudit:async()=>[],
 taxonomy:async()=>[{id:categoryId,kind:'category',name:'Pool care',archived:false}],read:async(_u,id)=>articles.get(id),
 topicList:async()=>[...topics.values()].filter(t=>t.status!=='archived').map(t=>structuredClone(t)),
 revisions:async(_u,id)=>{
  const saved=articles.get(id)?.editable;
  assert(saved,'Comparison must reference a saved article');
  return [
   {id:'00000000-0000-4000-8000-000000000092',version:2,created_at:'2026-10-29T10:00:00Z',
    data:{...saved,title:saved.title+' (reviewed)',summary:'Reviewer clarified the summary',
      body:'<p>Reviewed text &amp; safety caveat.</p><img src="/not-a-request" onerror="alert(1)">'}},
   {id:'00000000-0000-4000-8000-000000000091',version:1,created_at:'2026-10-29T09:00:00Z',data:saved}
  ];
 },
 topicCommand:async(_u,action,id,version,payload)=>{
  if(action==='add')topics.set(id,{id,...payload,status:'queued',version:1,attempts:0,articleId:randomUUID()});
  else{const t=topics.get(id);assert.equal(t.version,version);
   if(action==='claim'){assert.equal(t.status,'queued');t.status='generating';t.attempts++;}
   if(action==='complete'){assert(articles.has(t.articleId));t.status='drafted';}
   if(action==='archive')t.status='archived';t.version++;
  }return structuredClone(topics.get(id));
 },command:async(_u,id,version,action,payload)=>{
  assert.equal(action,'create');assert.equal(version,0);assert(!articles.has(id));commands.push(action);
  const row={id,version:1,state:'draft',editable:payload};articles.set(id,row);return row;
 }};
const generator=async({topic,categoryId})=>{generations++;return{article:{title:topic,slug:'weekly-care',summary:'Synthetic completed draft',categoryId,audience:'homeowners',tagIds:[],relatedIds:[],sources:[],seo:{title:topic,description:'Synthetic metadata'},body:'<h2>Weekly care</h2><p>'+('Test water before maintenance and follow equipment documentation. '.repeat(100))+'</p>'}};};
let route,origin;
const server=createServer(async(req,res)=>{
 try{const path=new URL(req.url,origin).pathname;
  if(path==='/api/platform/capabilities')return sendWebResponse(res,Response.json({features:{}}));
  if(path.startsWith('/api/')){const chunks=[];for await(const c of req)chunks.push(c);return sendWebResponse(res,await route(new Request(new URL(req.url,origin),{method:req.method,headers:req.headers,...(req.method!=='GET'?{body:Buffer.concat(chunks)}:{})})));}
  const file={'/admin/':'public/admin.html','/public/admin.js':'public/admin.js','/public/admin.css':'public/admin.css'}[path];
  if(!file){res.writeHead(404);return res.end();}
  res.writeHead(200,{'Content-Type':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html','Set-Cookie':'__Host-pooldocai-cms-csrf=synthetic-csrf; Path=/; Secure; SameSite=Lax'});res.end(readFileSync(file));
 }catch(e){errors.push(e.message);res.writeHead(500);res.end('Synthetic test failure');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
route=compatibilityRoute({db,identity:async()=>({id:'synthetic-owner'}),memberRole:async()=> 'owner',origin,topicPipeline:{queueEnabled:true,generator}});
let browser;
try{browser=await chromium.launch({headless:true,...(process.env.CMS_CHROMIUM?{executablePath:process.env.CMS_CHROMIUM}:{})});
 for(const width of [390,1440]){
  const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin+'/admin/#topics');await page.locator('#topic-add').click();
  await page.locator('[name=topic]').fill('Weekly care of your pool '+width);await page.locator('[name=brief]').fill('Test before additives.');
  await page.getByRole('button',{name:'Add to topic queue'}).click();
  await page.locator('#dialog').waitFor({state:'hidden'});
  const item=[...topics.values()].find(t=>t.topic.endsWith(String(width)));
  await page.locator('[data-topic-pick="'+item.id+'"]').click();assert.equal(await page.locator('#topic-create').isEnabled(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(axe.violations.map(v=>v.id),[]);
  await page.locator('#topic-create').click();await page.locator('#title').waitFor();assert.equal(await page.locator('#title').inputValue(),item.topic);
  assert.equal(articles.get(item.articleId).state,'draft');assert.equal(articles.get(item.articleId).editable.seo.noindex,true);
  // Review two immutable snapshots without rendering historical HTML or
  // changing the draft. Verify usable controls on both phone and desktop.
  const savedBefore=structuredClone(articles.get(item.articleId));
  const writesBefore=commands.length;
  await page.locator('#revisions').click();
  await page.locator('#compare-revisions').click();
  const compare=page.locator('#revision-comparison');
  assert.match(await compare.innerText(),/Changed fields/);
  assert.match(await compare.innerText(),/Reviewer clarified the summary/);
  assert.match(await compare.innerText(),/Reviewed text &amp; safety caveat/);
  assert.equal(await compare.locator('img').count(),0,'Saved HTML must not be interpreted as image markup');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  await page.locator('#compare-from').selectOption('00000000-0000-4000-8000-000000000092');
  await page.locator('#compare-revisions').click();
  assert.match(await compare.innerText(),/Choose two different saved revisions/);
  await page.locator('.dialog-close').click();
  assert.deepEqual(articles.get(item.articleId),savedBefore);
  assert.equal(commands.length,writesBefore);
  const before=generations;await page.goto(origin+'/admin/#topics');await page.locator('[data-topic-open="'+item.articleId+'"]').click();
  await page.locator('#title').waitFor();assert.equal(generations,before);await context.close();
  console.log(width+'px: add -> select -> create -> private editor -> reopen; accessibility passed');
 }assert.equal(generations,2);assert.deepEqual(commands,['create','create']);assert.deepEqual(errors,[]);
}finally{await browser?.close();await new Promise(r=>server.close(r));}
