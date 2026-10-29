import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inspectPrePublicationGate} from '../scripts/verify-staging-release-gates.mjs';
const baseline=JSON.parse(readFileSync(new URL('../evidence/staging-content-gate-20261028.json',import.meta.url)));
const mutated=patch=>({...structuredClone(baseline),...patch});
test('recorded Staging snapshot passes strict prepublication gate',()=>{
  assert.deepEqual(inspectPrePublicationGate(baseline),{ok:true,failures:[]});
});
test('rejects leaked private held draft or additional guide',()=>{
  let x=mutated({publicSlugs:[...baseline.publicSlugs,'held-private-resource']});
  assert.equal(inspectPrePublicationGate(x).ok,false);
  x=mutated({counts:{...baseline.counts,publicly_returned:3}});
  assert.equal(inspectPrePublicationGate(x).ok,false);
});
test('rejects a missing editorial hold, synthetic publication, or scheduled release',()=>{
  for(const key of ['held_drafts','holds','synthetic_public','scheduled']){
    const x=mutated({counts:{...baseline.counts,[key]:baseline.counts[key]+1}});
    assert.equal(inspectPrePublicationGate(x).ok,false,key+' must fail when modified');
  }
});
test('rejects any loss of RLS or direct grant to API roles',()=>{
  for(const key of ['rls_table_count','direct_anon_grants','direct_auth_grants']){
    const x=mutated({counts:{...baseline.counts,[key]:key==='rls_table_count'?20:1}});
    assert.equal(inspectPrePublicationGate(x).ok,false,key);
  }
});
test('rejects fictitious backup, production deployment, or scheduler enablement',()=>{
  for(const key of ['productionBackupVerified','productionCmsDeployed','cmsSchedulingEnabled']){
    assert.equal(inspectPrePublicationGate(mutated({[key]:true})).ok,false,key);
  }
});
test('invalid snapshot and absent count fail closed',()=>{
  assert.equal(inspectPrePublicationGate({}).ok,false);
  assert.equal(inspectPrePublicationGate(mutated({counts:{articles:33}})).ok,false);
});
