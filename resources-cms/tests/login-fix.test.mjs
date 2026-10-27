import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHandler } from '../api/resources.mjs';
import { loginRoute } from '../src/production/serverless.mjs';
import { sanitize } from '../src/content.mjs';

const origin = 'https://cms.example';
test('bundled sanitizer starts with require(ESM) disabled and retains XSS defenses', () => {
  execFileSync(process.execPath, ['--no-experimental-require-module','--input-type=module','-e', "await import('./src/production/app.mjs')"], {cwd: process.cwd(),stdio:'pipe'});
  const output = sanitize('<p>Safe</p><script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">link</a>');
  assert.doesNotMatch(output, /<script|onerror|javascript:/i); assert.match(output, /Safe/);
});
test('module initialization failure is converted to controlled JSON without message/stack', async () => {
  const route = createHandler({ loadApp: async () => { throw Object.assign(new Error('synthetic-private-detail'), { code:'ERR_REQUIRE_ESM' }); } });
  const headers = {};let data;
  const res = {setHeader:(k,v)=>headers[k]=v,end:b=>data=String(b)};
  const log = console.error;console.error=()=>{};
  try { await route({},res); } finally { console.error=log; }
  assert.equal(res.statusCode,500);assert.equal(headers['Content-Type'],'application/json');assert.equal(headers['Cache-Control'],'no-store');
  assert.deepEqual(JSON.parse(data),{error:'Service unavailable'});assert.doesNotMatch(data,/synthetic-private-detail|stack|ERR_REQUIRE_ESM/);
});
test('origin mismatch rejects before any Supabase sign-in and returns JSON', async () => {
  let called=false;
  const route = loginRoute({origin,signIn:async()=>{called=true;},memberRole:async()=> 'owner'});
  const r=await route(new Request(origin+'/api/login',{method:'POST',headers:{origin:'https://other-preview.example'},body:JSON.stringify({email:'owner@example.test',password:'synthetic-only'})}));
  assert.equal(r.status,403);assert.equal(called,false);assert.match(r.headers.get('content-type'),/application\/json/);assert.deepEqual(await r.json(),{error:'Login rejected'});
});
test('matching origin can submit login while nonmember still gets no CMS cookie', async () => {
  let called=false;
  const route=loginRoute({origin,signIn:async()=>{called=true;return{identity:{id:'4ab7d56e-57f4-4aed-9244-26ee801afab2'},access_token:'synthetic',refresh_token:'synthetic',expires_in:300};},memberRole:async()=>{throw Error('CMS membership denied');}});
  const r=await route(new Request(origin+'/api/login',{method:'POST',headers:{origin},body:JSON.stringify({email:'owner@example.test',password:'synthetic-only'})}));
  assert.equal(called,true);assert.equal(r.status,403);assert.equal(r.headers.get('set-cookie'),null);
});
