import {readFileSync} from 'node:fs';
import {publicNavigation} from '../src/platform/navigation.mjs';
import {discover,renderDiscovery} from '../src/platform/catalog.mjs';
import {validateEvent} from '../src/platform/analytics.mjs';
const catalog=JSON.parse(readFileSync(new URL('../live-catalog.json',import.meta.url)));
const navState=JSON.parse(readFileSync(new URL('../review-navigation.json',import.meta.url)));
const observed=new Map();let requests=0;
const headers={'Cache-Control':'private, no-store','X-Robots-Tag':'noindex, nofollow, noarchive','X-Content-Type-Options':'nosniff'};
export default async function handler(req,res){
 for(const[k,v]of Object.entries(headers))res.setHeader(k,v);
 const send=(status,value,type='application/json; charset=utf-8')=>{res.statusCode=status;res.setHeader('Content-Type',type);res.end(type.startsWith('application/json')?JSON.stringify(value):value);};
 if(process.env.VERCEL_ENV!=='preview')return send(404,{error:'Private review is unavailable'});
 const origin=(process.env.VERCEL==='1'?'https://':'http://')+req.headers.host;const url=new URL(req.url,origin),path=url.searchParams.get('__path')||url.pathname;
 try{
  if(path==='/api/review-mode'&&req.method==='GET')return send(200,{protectedPreview:true,catalog:'two-verified-live-guides',analytics:'validation-only; not persisted',conversionTrackingAvailable:false});
  if((path==='/api/public/resources'||path==='/resources/'||path==='/resources'||path.startsWith('/resources/collections/'))&&req.method==='GET'){
   const nav=publicNavigation(navState,catalog,url.searchParams.get('surface')==='assistant'?'assistant':url.searchParams.get('surface')==='header'?'header':'hub');if(path.startsWith('/resources/collections/')){const canonicalPath=path.replace(/\/+$/,'')+'/';const folder=nav.folders.find(f=>f.url===canonicalPath);if(!folder)return send(404,{error:'Collection not available'});url.searchParams.set('folder',folder.id);url.searchParams.set('path',folder.pathId);}
   const result=discover(catalog,{navigation:nav,folder:url.searchParams.get('folder')||'',query:url.searchParams.get('q')||'',slug:url.searchParams.get('slug')||'',tags:url.searchParams.getAll('tag').filter(Boolean),path:url.searchParams.get('path')||'',offset:Math.max(0,Math.min(100000,Number(url.searchParams.get('offset'))||0))});
   if(path==='/api/public/resources')return send(200,result);
   let html=renderDiscovery(result,url.searchParams).replace('href="/privacy.html"','href="/#privacy-details"');html=html.replace('</head>','<script src="/resource-platform-flags.js" defer></script><script src="/review-adapter.js" defer></script><script src="/resource-platform-loader.js" defer></script></head>').replace('<main id="main">','<main id="main"><p class="preview-notice">Private review · Two verified currently live guides. No Staging drafts or new publications.</p>');return send(200,html,'text/html; charset=utf-8');
  }
  if(path==='/analytics/collect'&&req.method==='POST'){
   if(req.headers.origin!==origin||!String(req.headers['content-type']).startsWith('application/json'))return send(403,{error:'Request rejected'});
   if(req.headers['sec-gpc']==='1'||/bot|crawler|spider/i.test(req.headers['user-agent']||''))return send(202,{accepted:0,excluded:true,persisted:false});
   let text=req.body==null?'':typeof req.body==='string'?req.body:JSON.stringify(req.body);if(!text)for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>32768)return send(413,{error:'Batch too large'});}if(Buffer.byteLength(text)>32768)return send(413,{error:'Batch too large'});
   const body=JSON.parse(text);if(Object.keys(body).some(k=>k!=='events')||!Array.isArray(body.events)||body.events.length<1||body.events.length>20)return send(422,{error:'Invalid batch'});
   const valid=body.events.map(e=>validateEvent(e,catalog,Date.now(),publicNavigation(navState,catalog,body.events.some(x=>x.surface==='widget')?'assistant':'hub')));if(++requests>10000)return send(429,{error:'Preview instance collection budget reached'});
   for(const[id,at]of observed)if(Date.now()-at>1800000)observed.delete(id);if(observed.size>1000)return send(429,{error:'Preview instance event budget reached'});
   let accepted=0;for(const e of valid){const key=e.session_id+':'+e.sequence_number;if(!observed.has(key)){observed.set(key,Date.now());accepted++;}}
   return send(202,{accepted,duplicates:valid.length-accepted,persisted:false,mode:'preview-validation-only',conversionTrackingAvailable:false});
  }
  return send(404,{error:'Not found'});
 }catch(error){return send([400,403,413,422,429].includes(error.status)?error.status:error instanceof SyntaxError?400:503,{error:error instanceof SyntaxError?'Invalid JSON':error.status?error.message:'Review temporarily unavailable'});}
}
