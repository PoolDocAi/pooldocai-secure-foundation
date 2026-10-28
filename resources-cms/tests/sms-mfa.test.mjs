import test from 'node:test';
import assert from 'node:assert/strict';
import {loginRoute} from '../src/production/serverless.mjs';
import {verifiedFactors,mfaRoute} from '../src/production/mfa.mjs';

const user='00000000-0000-4000-8000-000000000001';
const factor='00000000-0000-4000-8000-000000000002';
const challenge='00000000-0000-4000-8000-000000000003';
const origin='https://studio.example.test';
const jwt=aal=>'x.'+Buffer.from(JSON.stringify({sub:user,aal,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')+'.sig';
const aal1=jwt('aal1'),aal2=jwt('aal2');
const log=[];
let enrolled=false;
const config={url:'https://example.supabase.co',publishableKey:'sb_publishable_test'};
async function mockFetch(url,options={}){
  const path=new URL(url).pathname;
  const body=options.body?JSON.parse(options.body):{};
  log.push({path,method:options.method||'GET',body});
  if(path==='/auth/v1/user')return Response.json({id:user,email:'owner@example.test'});
  if(path==='/auth/v1/factors'&&options.method==='POST'){
    assert.equal(body.factor_type,'phone');
    assert.equal(body.phone,'+15555550123');
    enrolled=true;
    return Response.json({id:factor,type:'phone'});
  }
  if(path==='/auth/v1/factors'){
    return Response.json({totp:[],phone:enrolled
      ?[{id:factor,type:'phone',status:'unverified',phone:'+15555550123'}]
      :[{id:factor,type:'phone',status:'verified',phone:'+15555550123',friendly_name:'PoolDocAI Studio SMS'}]});
  }
  if(path==='/auth/v1/factors/'+factor+'/challenge')return Response.json({id:challenge});
  if(path==='/auth/v1/factors/'+factor+'/verify'){
    assert.equal(body.challenge_id,challenge);
    assert.equal(body.code,'123456');
    return Response.json({access_token:aal2,refresh_token:'sms-refresh',expires_in:3600});
  }
  throw Error('Unexpected simulated Auth call '+path);
}
const role=async()=> 'owner';
const settings={...config,fetchImpl:mockFetch};
function req(path,body,extra={}){
  return new Request(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...extra},body:JSON.stringify(body)});
}
function cookieHeader(response){return response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')}
function withCsrf(response,body){
  return {Cookie:cookieHeader(response),'X-CSRF-Token':body.csrf};
}

test('factor list includes phone SMS and masks direct phone data',async()=>{
  enrolled=false;log.length=0;
  const factors=await verifiedFactors(aal1,settings);
  assert.equal(factors.length,1);
  assert.deepEqual(factors[0],{id:factor,type:'phone',name:'PoolDocAI Studio SMS'});
  assert.equal(JSON.stringify(factors).includes('+15555550123'),false);
});

test('password sign-in returns an MFA-only pending cookie for an SMS-enrolled owner',async()=>{
  enrolled=false;log.length=0;
  const route=loginRoute({origin,signIn:async()=>({
    access_token:aal1,refresh_token:'refresh1',expires_in:3600,identity:{id:user,email:'owner@example.test'}
  }),memberRole:role,requireMfa:true,authConfig:settings});
  const response=await route(req('/api/login',{email:'owner@example.test',password:'synthetic'}));
  assert.equal(response.status,200);
  const data=await response.json();
  assert.equal(data.mfaRequired,true);
  assert.equal(data.setup,false);
  assert.equal(data.factors[0].type,'phone');
  assert(!response.headers.getSetCookie().some(x=>x.startsWith('__Host-pooldocai-cms-access='+encodeURIComponent(aal1))));
});

test('SMS enrollment requires valid E.164, and challenge explicitly sends before verify',async()=>{
  enrolled=false;log.length=0;
  const login=loginRoute({origin,signIn:async()=>({
    access_token:aal1,refresh_token:'refresh1',expires_in:3600,identity:{id:user,email:'owner@example.test'}
  }),memberRole:role,requireMfa:true,authConfig:settings});
  const initial=await login(req('/api/login',{email:'owner@example.test',password:'synthetic'}));
  const body=await initial.json();
  assert.equal(body.setup,true);
  const route=mfaRoute({origin,authConfig:config,memberRole:role,fetchImpl:mockFetch});
  const extra=withCsrf(initial,body);
  const invalid=await route(req('/api/mfa/enroll',{type:'phone',phone:'5555550123'},extra));
  assert.equal(invalid.status,422);
  assert(!log.some(x=>x.method==='POST'&&x.path==='/auth/v1/factors'));
  const enroll=await route(req('/api/mfa/enroll',{type:'phone',phone:'+15555550123'},extra));
  assert.equal(enroll.status,200);
  const result=await enroll.json();
  assert.equal(result.type,'phone');
  assert.equal(result.delivery,'sms');
  assert.equal(JSON.stringify(result).includes('+15555550123'),false);
  const challengeCount=()=>log.filter(x=>x.path==='/auth/v1/factors/'+factor+'/challenge').length;
  assert.equal(challengeCount(),0,'Enrollment itself must not send a text');
  const sms=await route(req('/api/mfa/challenge',{factorId:result.factorId},extra));
  assert.equal(sms.status,200);
  assert.equal((await sms.json()).challengeId,challenge);
  assert.equal(challengeCount(),1);
  const code=await route(req('/api/mfa/verify',{factorId:factor,code:'123456',challengeId:challenge},extra));
  assert.equal(code.status,200);
  const cookies=code.headers.getSetCookie();
  assert(cookies.some(x=>x.startsWith('__Host-pooldocai-cms-access='+encodeURIComponent(aal2))));
  assert(!JSON.stringify(await code.json()).includes('+15555550123'));
});

test('SMS factor cannot skip challenge or bypass CSRF',async()=>{
  enrolled=false;
  const route=mfaRoute({origin,authConfig:config,memberRole:role,fetchImpl:mockFetch});
  const {pendingCookies}=await import('../src/production/mfa.mjs');
  const pending=pendingCookies(aal1);
  const headers={Cookie:pending.headers.map(x=>x.split(';')[0]).join('; '),'X-CSRF-Token':pending.csrf};
  const skipped=await route(req('/api/mfa/verify',{factorId:factor,code:'123456'},headers));
  assert.equal(skipped.status,422);
  const noCsrf=await route(req('/api/mfa/challenge',{factorId:factor},{Cookie:headers.Cookie}));
  assert.equal(noCsrf.status,403);
});
