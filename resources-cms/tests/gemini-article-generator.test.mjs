import test from 'node:test';
import assert from 'node:assert/strict';
import {createGeminiArticleGenerator,groundedSources} from '../src/production/gemini-article-generator.mjs';
import {validResearchUrl} from '../src/production/research-url.mjs';
import {readRuntimeConfig} from '../src/production/runtime.mjs';
import {compatibilityRoute} from '../src/production/compat-api.mjs';
const categoryId='00000000-0000-4000-8000-000000000012';
const notes='Equipment model documentation should guide maintenance, with chemistry testing and appropriate safety precautions before any intervention. '.repeat(4);
const research=()=>({candidates:[{finishReason:'STOP',content:{parts:[{text:notes}]},groundingMetadata:{groundingChunks:[{web:{uri:'https://www.cdc.gov/healthy-swimming/',title:'CDC'}},{web:{uri:'https://www.phta.org/technical/',title:'PHTA'}}],groundingSupports:[{segment:{startIndex:0,endIndex:Buffer.byteLength(notes),text:notes},groundingChunkIndices:[0,1]}]}}]});
const draft=()=>({title:'Weekly pool care and equipment checks',summary:notes.slice(0,200),intro:notes.slice(0,240),keyTakeaways:['Test water before deciding on treatment.','Inspect equipment and record observations.','Follow the instructions for your model.'],sections:Array.from({length:4},(_,i)=>({heading:'Maintenance step '+i,paragraphs:[notes,notes],sourceIds:['s1','s2']})),faqs:[{question:'How should I plan care?',answer:notes},{question:'What should I record?',answer:notes}],seo:{title:'Weekly Pool Care',description:notes.slice(0,150)}});
const req={topic:'Weekly care of your pool',audience:'homeowners',brief:'Test first',categoryId};
test('mocked Gemini completes two bounded fixed-host calls and returns a private sourced article',async()=>{
 const calls=[],usage=[];
 const generator=createGeminiArticleGenerator({apiKey:'synthetic-server-key',logUsage:(...args)=>usage.push(args),fetchImpl:async(url,options)=>{
  calls.push({url,options,payload:JSON.parse(options.body)});
  return Response.json(calls.length===1?research():{candidates:[{finishReason:'STOP',content:{parts:[{thought:true,text:'Never include internal thought'},{text:JSON.stringify(draft())}]}}]});
 }});
 const result=await generator(req);
 assert.equal(usage.length,2);assert.doesNotMatch(JSON.stringify(usage),/synthetic-server-key|equipment|Weekly care/);assert.equal(calls.length,2);assert.equal(result.article.sources.length,2);assert.equal(result.article.seo.noindex,true);
 assert.doesNotMatch(result.article.body,/internal thought|synthetic-server-key/);
 for(const c of calls){assert.equal(new URL(c.url).hostname,'generativelanguage.googleapis.com');assert.equal(c.options.redirect,'error');assert(c.options.signal);assert.equal(c.payload.generationConfig.thinkingConfig.thinkingBudget,0);}
 assert.equal(calls[0].payload.generationConfig.maxOutputTokens,2800);
 assert.equal(calls[1].payload.generationConfig.maxOutputTokens,6500);
});
test('search hits without matching support segments cannot become citations',()=>{
 const x=research();assert.equal(groundedSources(x).length,2);
 x.candidates[0].groundingMetadata.groundingSupports=[];assert.deepEqual(groundedSources(x),[]);
 x.candidates[0].groundingMetadata.groundingSupports=[{segment:{startIndex:0,endIndex:5,text:'forged'},groundingChunkIndices:[0,1]}];assert.deepEqual(groundedSources(x),[]);
});
test('provider failures, truncation, fabricated sources, missing grounding and oversized responses fail closed without retries',async()=>{
 for(const mode of ['429','truncated','unsupported','oversized','invented']){
  let calls=0;
  const generator=createGeminiArticleGenerator({apiKey:'synthetic',fetchImpl:async()=>{
   calls++;
   if(mode==='429')return new Response('',{status:429});
   if(mode==='oversized')return new Response('x'.repeat(150001));
   const r=research();
   if(mode==='truncated')r.candidates[0].finishReason='MAX_TOKENS';
   if(mode==='unsupported')r.candidates[0].groundingMetadata.groundingSupports=[];
   if(calls===1)return Response.json(r);
   const d=draft();d.sections[0].sourceIds=['fabricated'];
   return Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(d)}]}}]});
  }});
  await assert.rejects(generator(req));assert.equal(calls,mode==='invented'?2:1);
 }
});
test('citation URL policy rejects private IPs, credentials, local names and nonstandard ports',()=>{
 for(const url of ['https://172.20.0.1/x','https://169.254.169.254/','https://[::1]/','https://2130706433/','https://host.internal/','https://cdc.gov:8443/','https://u:p@cdc.gov/','http://cdc.gov/'])assert.equal(validResearchUrl(url),false,url);
 assert.equal(validResearchUrl('https://www.cdc.gov/healthy-swimming/'),true);
});
test('topic runtime rejects Production, unreviewed targets and unspecified deployment environments',()=>{
 const base={SUPABASE_URL:'https://rzkgmvyyeclrpomrlyft.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_synthetic',CMS_ORIGIN:'https://cms.example',CMS_TOPIC_QUEUE_ENABLED:'1',VERCEL_ENV:'preview'};
 assert.equal(readRuntimeConfig(base).features.topicQueue,true);
 for(const patch of [{VERCEL_ENV:'production'},{VERCEL_ENV:''},{SUPABASE_URL:'https://owfeebydlyacssqpnmkq.supabase.co'},{SUPABASE_URL:'https://other.supabase.co'}])assert.throws(()=>readRuntimeConfig({...base,...patch}),/Staging/);
});
test('topic mutation routes require Origin and CSRF before data or generator access',async()=>{
 let touched=0;
 const route=compatibilityRoute({db:{topicList:async()=>{touched++;return[];}},identity:async()=>({id:'owner'}),memberRole:async()=> 'owner',origin:'https://cms.example',topicPipeline:{queueEnabled:true,generator:()=>{touched++;}}});
 for(const headers of [{},{Origin:'https://evil.example'},{Origin:'https://cms.example'}]){
  const r=await route(new Request('https://cms.example/api/topics',{method:'POST',headers,body:'{}'}));assert.equal(r.status,403);
 }
 assert.equal(touched,0);
});
