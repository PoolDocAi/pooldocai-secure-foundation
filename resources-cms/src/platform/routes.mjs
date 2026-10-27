import {discover,renderDiscovery} from './catalog.mjs';
import {placement} from './taxonomy.mjs';
const json=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex'}});
export const platformPath=p=>p.startsWith('/api/platform/')||p==='/api/public/resources'||p==='/analytics/collect'||p==='/resources/discover/'||p==='/resources/';
export function platformRoutes({features,adapter,identity,guardWrite,origin}){
 return async(request)=>{
  const url=new URL(request.url),path=url.pathname;if(!platformPath(path))return null;
  try{
   if(path==='/api/public/resources'||path==='/resources/discover/'||path==='/resources/'){
    if(!features.discovery)return json({error:'Not available'},404);
    if(request.method!=='GET')return json({error:'Method not allowed'},405);
    const result=discover(await adapter.catalog(),{query:url.searchParams.get('q')||'',slug:url.searchParams.get('slug')||'',tags:url.searchParams.getAll('tag').filter(Boolean),path:url.searchParams.get('path')||'',offset:Math.max(0,Math.min(100000,Number(url.searchParams.get('offset'))||0))});
    if(path==='/api/public/resources')return json(result);
    let internal=false;try{internal=Boolean((await identity(request)).role);}catch{}
    return new Response(renderDiscovery(result,url.searchParams,{...features,analytics:features.analytics&&!internal}),{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
   }
   if(path==='/analytics/collect'){
    if(!features.analytics)return json({error:'Not available'},404);
    if(request.method!=='POST')return json({error:'Method not allowed'},405);
    if(request.headers.get('origin')!==origin||!request.headers.get('content-type')?.startsWith('application/json'))return json({error:'Request rejected'},403);
    const text=await request.text();if(Buffer.byteLength(text)>32768)return json({error:'Batch too large'},413);
    const body=JSON.parse(text);if(Object.keys(body).some(k=>!['events'].includes(k)))return json({error:'Invalid envelope'},422);
    return json(await adapter.collect(body.events,{gpc:request.headers.get('sec-gpc')==='1',bot:/bot|crawler|spider/i.test(request.headers.get('user-agent')||'')}));
   }
   const user=await identity(request);
   if(path==='/api/platform/config')return json({features,role:user.role});
   if(!features.taxonomy)return json({error:'Feature is disabled'},404);
   if(request.method!=='GET')await guardWrite(request,user);
   const owner=()=>{if(user.role!=='owner')throw Object.assign(Error('Owner required'),{status:403});};
   const body=async()=>{const text=await request.text();if(Buffer.byteLength(text)>16384)throw Object.assign(Error('Request too large'),{status:413});return JSON.parse(text||'{}');};
   if(path==='/api/platform/facets'&&request.method==='GET')return json(await adapter.facets(user));
   if(path==='/api/platform/facets'&&request.method==='POST'){owner();return json(await adapter.command(user,await body()),201);}
   if(path==='/api/platform/tag-requests'&&request.method==='POST')return json(await adapter.requestTag(user,await body()),201);
   if(path==='/api/platform/tag-requests'&&request.method==='GET'){owner();return json(await adapter.tagRequests(user));}
   if(path==='/api/platform/placement'&&request.method==='POST'){const data=await body();if(!Array.isArray(data.tagIds)||data.tagIds.length>30)return json({error:'Invalid tags'},422);return json(placement(await adapter.facets(user),data.tagIds));}
   if(path==='/api/platform/analytics'&&request.method==='GET'){owner();if(!features.analytics)return json({error:'Analytics disabled'},404);return json(await adapter.report(user,Object.fromEntries(url.searchParams)));}
   if(path==='/api/platform/analytics/purge'&&request.method==='POST'){owner();if(!features.analytics)return json({error:'Analytics disabled'},404);return json(await adapter.purge(user,(await body()).before));}
   return json({error:'Not found'},404);
  }catch(error){const status=[400,401,403,404,409,413,422,429].includes(error.status)?error.status:error instanceof SyntaxError?400:503;return json({error:status===503?'Platform feature unavailable':status===400?'Invalid JSON':error.message},status);}
 };
}
