import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createTopicGenerationHandler} from '../api/topic-generate.mjs';

const config=JSON.parse(readFileSync(new URL('../vercel.json',import.meta.url),'utf8'));
const path='/api/topics/00000000-0000-4000-8000-000000000010/create-article';
const url='/api/topic-generate?__cms_path='+encodeURIComponent(path);
function res(){
  return {statusCode:200,headers:{},finished:false,
    setHeader(name,value){this.headers[name.toLowerCase()]=value;},
    end(value){this.finished=true;this.body=value;}};
}

test('dedicated article generation uses 120s, regular CMS remains 30s',()=>{
  assert.equal(config.functions?.['api/resources.mjs']?.maxDuration,30);
  assert.equal(config.functions?.['api/topic-generate.mjs']?.maxDuration,120);
  const routes=config.rewrites;
  const specific=routes.findIndex(r=>r.source==='/api/topics/:id/create-article');
  const general=routes.findIndex(r=>r.source==='/api/:path*');
  assert(specific>=0&&specific<general,'generate route must precede generic CMS API rewrite');
  assert.equal(routes[specific].destination,
    '/api/topic-generate?__cms_path=/api/topics/:id/create-article');
  assert.equal(routes.filter(r=>r.destination.startsWith('/api/topic-generate?')).length,1,
    'only one operation uses the expensive-function route');
});

test('generation function delegates exactly one canonical owner create operation',async()=>{
  const observed=[];
  const handler=createTopicGenerationHandler({delegate:async(req,response)=>{
    observed.push({method:req.method,url:req.url});
    response.statusCode=201;response.end('created');
  }});
  const response=res();
  await handler({method:'POST',url},response);
  assert.equal(response.statusCode,201);
  assert.equal(response.body,'created');
  assert.deepEqual(observed,[{method:'POST',url}]);
});

test('generation function fails closed on GET, bogus path, unknown actions and parameter smuggling',async()=>{
  const called=[];
  const handler=createTopicGenerationHandler({delegate:async(req)=>called.push(req)});
  const bad=[
    {method:'GET',url},
    {method:'POST',url:'/api/topic-generate'},
    {method:'POST',url:'/api/topic-generate?__cms_path=/api/content'},
    {method:'POST',url:'/api/topic-generate?__cms_path=/api/topics/not-uuid/create-article'},
    {method:'POST',url:'/api/topic-generate?__cms_path=/api/topics/00000000-0000-4000-8000-000000000010/publish'},
    {method:'POST',url:url+'&__cms_path='+encodeURIComponent(path)},
    {method:'POST',url:'/api/resources?__cms_path='+encodeURIComponent(path)}
  ];
  for(const req of bad){
    const response=res();await handler(req,response);
    assert.equal(response.statusCode,404,req.url);
    assert.equal(response.headers['cache-control'],'no-store');
    assert.equal(response.finished,true);
  }
  assert.equal(called.length,0);
});
