import {platformRoutes} from './routes.mjs';
// This may later run on the public MARKETING project. It never forwards cookies,
// Auth tokens or CMS admin requests to the protected private deployment.
export function publicGateway({adapter,origin,features}){
 if(new URL(origin).origin!==origin||!origin.startsWith('https://'))throw Error('Exact HTTPS public origin required');
 const route=platformRoutes({adapter,origin,features,identity:async()=>{throw Object.assign(Error('Public gateway has no CMS access'),{status:401});},guardWrite:async()=>{throw Error('Unavailable');}});
 return async request=>{const path=new URL(request.url).pathname;if(!['/api/public/resources','/resources/','/resources/discover/','/analytics/collect'].includes(path))return Response.json({error:'Not found'},{status:404,headers:{'Cache-Control':'no-store'}});return route(request);};
}
