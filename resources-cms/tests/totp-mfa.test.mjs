import test from 'node:test';
import assert from 'node:assert/strict';
import {loginRoute,refreshRoute} from '../src/production/serverless.mjs';
import {mfaRoute,aal2Required} from '../src/production/mfa.mjs';

const UUID='00000000-0000-4000-8000-000000000001';
const FACTOR='00000000-0000-4000-8000-000000000002';
const CHALLENGE='00000000-0000-4000-8000-000000000003';
const origin='https://cms.example';
const config={url:'https://example.supabase.co',publishableKey:'sb_publishable_test'};
const jwt=aal=>'x.'+Buffer.from(JSON.stringify({sub:UUID,aal,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.sig';
const v1=jwt('aal1'),v2=jwt('aal2');

function mockFetch(url,options={}){
  const path=new URL(url).pathname;
  if(path==='/auth/v1/user'){
    return Promise.resolve(Response.json({id:UUID,email:'owner@example.test'}));
  }
  if(path==='/auth/v1/factors' && options.method==='POST')
    return Promise.resolve(Response.json({id:FACTOR,totp:{qr_code:'data:image/svg+xml;utf-8,%3Csvg%3E%3C/svg%3E'}}));
  if(path==='/auth/v1/factors')
    return Promise.resolve(Response.json([]));
  if(path==='/auth/v1/factors/'+FACTOR+'/challenge')
    return Promise.resolve(Response.json({id:CHALLENGE}));
  if(path==='/auth/v1/factors/'+FACTOR+'/verify')
    return Promise.resolve(Response.json({access_token:v2,refresh_token:'refresh-aal2',expires_in:3600}));
  if(path==='/auth/v1/token')
    return Promise.resolve(Response.json({access_token:v1,refresh_token:'refresh-aal1',expires_in:3600}));
  throw new Error('Unexpected request path: '+path);
}
const signIn=async()=>({access_token:v1,refresh_token:'refresh-aal1',expires_in:3600,identity:{id:UUID,email:'owner@example.test'}});
const memberRole=async()=> 'owner';
const headers={Origin:origin,'Content-Type':'application/json'};
function request(path,body,headersExtra={}){return new Request(origin+path,{method:'POST',headers:{...headers,...headersExtra},body:JSON.stringify(body)})}
function cookies(response){
  return response.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
}

test('password login issues short-lived pending cookie and NO privileged session cookie',async()=>{
  const route=loginRoute({origin,signIn,memberRole,authConfig:config,requireMfa:true});
  const response=await route(request('/api/login',{email:'owner@example.test',password:'synthetic'}));
  assert.equal(response.status,200);
  const data=await response.json();
  assert.equal(data.mfaRequired,true);
  assert.equal(data.setup,true);
  assert.equal(typeof data.csrf,'string');
  const set=response.headers.getSetCookie();
  assert(set.some(x=>x.startsWith('__Host-pooldocai-cms-mfa-pending='+encodeURIComponent(v1))));
  assert(set.some(x=>x.startsWith('__Host-pooldocai-cms-access=;') && x.includes('Max-Age=0')));
  assert(!set.some(x=>x.startsWith('__Host-pooldocai-cms-access='+encodeURIComponent(v1))));
});

test('staging owner can enroll with valid pending cookie, but only TOTP verification elevates to AAL2',async()=>{
  const login=loginRoute({origin,signIn,memberRole,authConfig:config,requireMfa:true});
  const response=await login(request('/api/login',{}));
  const data=await response.json();
  const sessionCookies=cookies(response);
  const authHeaders={Cookie:sessionCookies,'X-CSRF-Token':data.csrf};
  const route=mfaRoute({origin,authConfig:config,memberRole,fetchImpl:mockFetch});
  const setup=await route(request('/api/mfa/enroll',{},authHeaders));
  assert.equal(setup.status,200);
  const qr=await setup.json();
  assert.equal(qr.factorId,FACTOR);
  assert(qr.qrCode.startsWith('data:image/svg+xml;'));
  const invalid=await route(request('/api/mfa/verify',{factorId:FACTOR,code:'not-six-digits'},authHeaders));
  assert.equal(invalid.status,422);
  assert.equal(invalid.headers.getSetCookie().length,0);
  const valid=await route(request('/api/mfa/verify',{factorId:FACTOR,code:'123456'},authHeaders));
  assert.equal(valid.status,200);
  const result=await valid.json();
  assert.equal(result.role,'owner');
  const set=valid.headers.getSetCookie();
  assert(set.some(x=>x.startsWith('__Host-pooldocai-cms-access='+encodeURIComponent(v2))));
  assert(set.some(x=>x.startsWith('__Host-pooldocai-cms-mfa-pending=;')&&x.includes('Max-Age=0')));
});

test('AAL1 is blocked from all private authorization; AAL2 is accepted',()=>{
  assert.throws(()=>aal2Required(v1,{id:UUID}),{status:403});
  assert.equal(aal2Required(v2,{id:UUID}).id,UUID);
  assert.throws(()=>aal2Required(v2,{id:FACTOR}),{status:403});
  assert.throws(()=>aal2Required('malformed',{id:UUID}),{status:403});
});

test('refresh under MFA policy refuses AAL1 and clears privileged cookies',async()=>{
  const route=refreshRoute({origin,authConfig:{...config,fetchImpl:mockFetch},memberRole,requireMfa:true});
  const req=request('/api/refresh',{},{
    Cookie:'__Host-pooldocai-cms-csrf=example; __Host-pooldocai-cms-refresh=refresh-aal1',
    'X-CSRF-Token':'example'
  });
  const response=await route(req);
  assert.equal(response.status,403);
  assert(response.headers.getSetCookie().some(x=>x.startsWith('__Host-pooldocai-cms-access=;')));
});

test('missing pending token, origin, or CSRF cannot enroll MFA',async()=>{
  const route=mfaRoute({origin,authConfig:config,memberRole,fetchImpl:mockFetch});
  assert.equal((await route(request('/api/mfa/enroll',{},{'X-CSRF-Token':'none'}))).status,403);
  assert.equal((await route(request('/api/mfa/enroll',{},{
    Cookie:'__Host-pooldocai-cms-csrf=valid','X-CSRF-Token':'valid'
  }))).status,401);
  const crossSite=new Request(origin+'/api/mfa/enroll',{method:'POST',headers:{...headers,Origin:'https://attacker.invalid'},body:'{}'});
  assert.equal((await route(crossSite)).status,403);
});
