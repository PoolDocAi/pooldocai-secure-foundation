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
test('grounds citations only from vetted search metadata and exposes editor UI route',()=>{
 const sources=groundedSources({candidates:[{groundingMetadata:{groundingChunks:[
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
