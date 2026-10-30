import test from 'node:test';
import assert from 'node:assert/strict';
import {loginRoute,refreshRoute,logoutRoute} from '../src/production/serverless.mjs';
import {mfaRoute} from '../src/production/mfa.mjs';
import {AuthError,mfaMembership} from '../src/production/auth.mjs';
import {SupabaseDataCMS} from '../src/production/supabase-data.mjs';
const id='00000000-0000-4000-8000-000000000001',fid='00000000-0000-4000-8000-000000000002';
const origin='https://cms.example';
const syntheticNow=Math.floor(Date.now()/1000);
const jwt=aal=>'x.'+Buffer.from(JSON.stringify({sub:id,aal,exp:syntheticNow+600})).toString('base64url')+'.sig';
const request=(path,body={})=>new Request(origin+path,{method:'POST',headers:{origin,cookie:'__Host-pooldocai-cms-refresh=r; __Host-pooldocai-cms-csrf=c; __Host-pooldocai-cms-mfa-pending='+jwt('aal1'),'x-csrf-token':'c'},body:JSON.stringify(body)});
const denied=()=>{throw new AuthError('CMS membership denied',403)};
const session=aal=>({access_token:jwt(aal),refresh_token:'new-r',expires_in:600,identity:{id}});
const fetchFor=(aal='aal2',verifyStatus=200)=>async(url,opt={})=>{
 const p=new URL(url).pathname;
 if(p==='/auth/v1/user')return Response.json({id});
 if(p==='/auth/v1/token')return Response.json(session(aal));
 if(p==='/auth/v1/logout')return new Response(null,{status:204});
 if(p==='/auth/v1/factors')return Response.json([{id:fid,status:'verified',factor_type:'totp'}]);
 if(p.endsWith('/challenge'))return Response.json({id:fid});
 if(p.endsWith('/verify'))return Response.json(verifyStatus===200?session(aal):{}, {status:verifyStatus});
 throw Error('unexpected path');
};
const config=fetchImpl=>({url:'https://synthetic.supabase.co',publishableKey:'sb_publishable_test',fetchImpl});
const csrfHeaders=r=>r.headers.getSetCookie().filter(s=>s.includes('Max-Age=0'));

test('MFA login uses bootstrap exclusively; rejects revoked membership without session cookies',async()=>{
 let bootstrap=0,normal=0;
 const route=loginRoute({origin,requireMfa:true,authConfig:config(fetchFor()),signIn:async()=>session('aal1'),bootstrapMemberRole:async()=>{bootstrap++;return 'owner'},memberRole:async()=>{normal++;throw Error('general query must not be called')}});
 assert.equal((await route(request('/api/login'))).status,200);assert.equal(bootstrap,1);assert.equal(normal,0);
 const rejected=loginRoute({origin,requireMfa:true,authConfig:config(fetchFor()),signIn:async()=>session('aal1'),bootstrapMemberRole:denied,memberRole:async()=> 'owner'});
 const res=await rejected(request('/api/login'));assert.equal(res.status,403);assert.equal(res.headers.getSetCookie().length,0);
});
test('bootstrap adapter has no user-target payload and forwards exact caller token',async()=>{
 const seen=[];const db=new SupabaseDataCMS({...config(async(url,opt)=>{seen.push({path:new URL(url).pathname,body:JSON.parse(opt.body),token:opt.headers.Authorization});return Response.json('owner')})});
 const user={id,accessToken:jwt('aal1')};assert.equal(await mfaMembership(db,user,{bootstrap:true}),'owner');
 assert.deepEqual(seen,[{path:'/rest/v1/rpc/mfa_member_role',body:{},token:'Bearer '+user.accessToken}]);
 await assert.rejects(mfaMembership({memberRole:async()=> 'owner'},user,{bootstrap:true}),{status:503});
 await assert.rejects(mfaMembership({mfaBootstrapRole:async()=>null},user,{bootstrap:true}),{status:403});
});
test('refresh rechecks private membership/session policy; denied refresh clears cookies',async()=>{
 let calls=0;const route=refreshRoute({origin,requireMfa:true,authConfig:config(fetchFor()),memberRole:async()=>{calls++;return 'owner'}});
 const ok=await route(request('/api/refresh'));assert.equal(ok.status,200);assert.equal(calls,1);
 const reject=refreshRoute({origin,requireMfa:true,authConfig:config(fetchFor()),memberRole:denied});
 const res=await reject(request('/api/refresh'));assert.equal(res.status,403);assert.equal(csrfHeaders(res).length,3);
 const bad=refreshRoute({origin,requireMfa:true,authConfig:config(async()=>Response.json({}, {status:401})),memberRole:async()=>{throw Error('must not call')}});
 assert.equal((await bad(request('/api/refresh'))).status,401);
});
test('pending logout revokes upstream session and clears pending and privileged cookies',async()=>{
 let revoked=0;const fetchImpl=async(url,opt)=>{assert.equal(new URL(url).pathname,'/auth/v1/logout');assert.equal(opt.headers.Authorization,'Bearer '+jwt('aal1'));revoked++;return new Response(null,{status:204})};
 const res=await logoutRoute({origin,authConfig:config(fetchImpl)})(request('/api/logout'));
 assert.equal(res.status,200);assert.equal(revoked,1);assert.equal(csrfHeaders(res).length,4);
});
for(const status of [403,422,429])test('replayed/expired/rejected challenge '+status+' never sets session cookies',async()=>{
 const fetchImpl=fetchFor('aal2',status);
 const route=mfaRoute({origin,authConfig:config(fetchImpl),fetchImpl,bootstrapMemberRole:async()=> 'owner',memberRole:async()=> 'owner'});
 const res=await route(request('/api/mfa/verify',{factorId:fid,code:'123456'}));
 assert.equal(res.status,status===429?429:403);assert.equal(res.headers.getSetCookie().length,0);assert.equal(res.headers.get('cache-control'),'no-store');
});
test('membership revoked after verification cannot receive elevated session cookies',async()=>{
 const fetchImpl=fetchFor();const route=mfaRoute({origin,authConfig:config(fetchImpl),fetchImpl,bootstrapMemberRole:async()=> 'owner',memberRole:denied});
 const res=await route(request('/api/mfa/verify',{factorId:fid,code:'123456'}));assert.equal(res.status,403);assert.equal(res.headers.getSetCookie().length,0);
});
