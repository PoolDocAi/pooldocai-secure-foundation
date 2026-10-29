import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {handleTopicApi} from '../src/production/topic-queue-api.mjs';
import {groundedSources} from '../src/production/gemini-article-generator.mjs';

const ID='00000000-0000-4000-8000-000000000010';
const ARTICLE='00000000-0000-4000-8000-000000000011';
const CAT='00000000-0000-4000-8000-000000000012';
const user={id:'00000000-0000-4000-8000-000000000001'};
function fixture(){
 const row={id:ID,topic:'Weekly care of your pool',brief:'Discuss convenience features; recommend chemicals based on test results.',audience:'homeowners',status:'queued',articleId:ARTICLE,version:1,attempts:0};
 let saved=null;const actions=[];
 const db={
   get saved(){return saved;},get actions(){return actions;},
   topicList:async()=>[structuredClone(row)],
   taxonomy:async()=>[{id:CAT,name:'Pool care',kind:'category',archived:false}],
   read:async()=>saved?{id:ARTICLE,state:'draft',editable:saved}:null,
   command:async(_user,id,v,action,payload)=>{
     assert.equal(id,ARTICLE);assert.equal(v,0);assert.equal(action,'create');
     saved=structuredClone(payload);
   },
   topicCommand:async(_user,action,id,v,payload)=>{
     actions.push(action);assert.equal(id,ID);assert.equal(v,row.version);
     if(action==='claim'){row.status='generating';row.version++;row.attempts++;}
     if(action==='release'){row.status='queued';row.version++;}
     if(action==='complete'){assert(saved);row.status='drafted';row.version++;}
     if(action==='archive'){row.status='archived';row.version++;}
     if(action==='add'){row.topic=payload.topic;}
     return structuredClone(row);
   }
 };
 return db;
}
async function call(db,{role='owner',flag=true,generator=null,method='GET',path='/api/topics',payload}={}){
 const request=new Request('https://cms.example'+path,{method,
   headers:{'Content-Type':'application/json'},
   ...(payload?{body:JSON.stringify(payload)}:{})});
 return handleTopicApi({request,db,user,role,topicPipeline:{queueEnabled:flag,generator}});
}
test('owner-only queue rejects unauthorized roles, disabled feature and stale versions',async()=>{
 const db=fixture();
 assert.equal((await call(db,{role:'viewer'})).status,403);
 assert.equal((await call(db,{flag:false})).status,503);
 assert.equal((await call(db)).status,200);
 assert.equal((await call(db,{method:'POST',path:'/api/topics/'+ID+'/create-article',payload:{version:4}})).status,409);
 assert.equal(db.actions.length,0);
});
test('one selected queued topic creates one private draft and opens existing editor ID',async()=>{
 const db=fixture();
 let count=0;
 const generator=async()=>{
  count++;assert.deepEqual(db.actions,['claim']);
  return{article:{title:'Weekly care',slug:'weekly-care',body:'<p>Completed article</p>',seo:{},featured:false}};
 };
 const response=await call(db,{method:'POST',path:'/api/topics/'+ID+'/create-article',payload:{version:1},generator});
 assert.equal(response.status,201);
 assert.equal((await response.json()).articleId,ARTICLE);
 assert.equal(count,1);assert.deepEqual(db.actions,['claim','complete']);
 assert.equal(db.saved.seo.noindex,true);
 assert.equal(db.saved.publishedAt,null);
 assert.match(db.saved.slug,/weekly-care-00000000/);
});
test('failed writer releases claimed topic without creating incomplete article',async()=>{
 const db=fixture();
 const fail=await call(db,{method:'POST',path:'/api/topics/'+ID+'/create-article',
   payload:{version:1},generator:async()=>{throw Object.assign(Error('Unavailable'),{status:503});}});
 assert.equal(fail.status,503);assert.equal(db.saved,null);
 assert.deepEqual(db.actions,['claim','release']);
});
test('grounds citations only from supported search metadata and exposes editor UI route',()=>{
 const sources=groundedSources({candidates:[{content:{parts:[{text:'Verified research'}]},groundingMetadata:{groundingSupports:[{segment:{startIndex:0,endIndex:17,text:'Verified research'},groundingChunkIndices:[0,1,2]}],groundingChunks:[
  {web:{uri:'https://www.cdc.gov/healthy-swimming/',title:'CDC'}},
  {web:{uri:'https://www.phta.org/',title:'PHTA'}},
  {web:{uri:'http://localhost/private',title:'Not allowed'}}
 ]}}]});
 assert.equal(sources.length,2);
 const html=readFileSync(new URL('../public/admin.html',import.meta.url),'utf8');
 const js=readFileSync(new URL('../public/admin.js',import.meta.url),'utf8');
 assert.match(html,/data-page="topics"/);
 assert.match(js,/id="topic-choice"/);
 assert.match(js,/id="topic-create"/);
 assert.match(js,/data-topic-open/);
});

test('replayed create returns existing draft without regenerating or overwriting revisions',async()=>{
 const db=fixture();let count=0;
 const generator=async()=>{count++;return{article:{title:'Weekly care',slug:'weekly-care',body:'<p>Finished</p>',seo:{}}};};
 const args={method:'POST',path:'/api/topics/'+ID+'/create-article',payload:{version:1},generator};
 assert.equal((await call(db,args)).status,201);
 const original=structuredClone(db.saved),actions=[...db.actions];
 const replay=await call(db,args);assert.equal(replay.status,200);assert.equal((await replay.json()).articleId,ARTICLE);
 assert.equal(count,1);assert.deepEqual(db.saved,original);assert.deepEqual(db.actions,actions);
});
test('oversized streaming topic body is rejected before DB writes',async()=>{
 const db=fixture();const response=await call(db,{method:'POST',payload:{topic:'x'.repeat(5000)}});
 assert.equal(response.status,413);assert.deepEqual(db.actions,[]);
});

test('add requires stable request identity and passes it unchanged to the durable command',async()=>{
 let received;
 const db={topicCommand:async(_u,action,id,version,payload)=>{received={action,id,version,payload};return received;}};
 assert.equal((await call(db,{method:'POST',payload:{topic:'Weekly care of your pool'}})).status,422);
 const r=await call(db,{method:'POST',payload:{id:ID,topic:'Weekly care of your pool'}});
 assert.equal(r.status,201);assert.equal(received.id,ID);assert.equal(received.version,0);assert.equal(received.action,'add');
});

test('SQL quota and stale-version errors become safe actionable HTTP errors',async()=>{
 for(const [code,detail,status] of [['22023','Daily editorial generation budget exhausted',429],['40001','Topic changed',409],['23505','duplicate key',409]]){
  const db=fixture();db.topicCommand=async()=>{throw Object.assign(Error(detail),{code,status:400});};
  const r=await call(db,{method:'POST',path:'/api/topics/'+ID+'/create-article',payload:{version:1},generator:async()=>{throw Error('Must not run');}});
  assert.equal(r.status,status);assert.doesNotMatch(JSON.stringify(await r.json()),/duplicate key|SQL/);
 }
});

test('lost article-create acknowledgement recovers the committed draft without another paid call',async()=>{
 const db=fixture(),original=db.command;let calls=0;
 db.command=async(...args)=>{await original(...args);throw Error('Lost response');};
 const args={method:'POST',path:'/api/topics/'+ID+'/create-article',payload:{version:1},generator:async()=>{calls++;return{article:{title:'Finished weekly care',slug:'weekly-care',body:'<p>Finished</p>',seo:{}}};}};
 assert.equal((await call(db,args)).status,500);assert(db.saved);
 const rows=await db.topicList();
 const retry=await call(db,{...args,payload:{version:rows[0].version}});
 assert.equal(retry.status,201);assert.equal(calls,1);
});
