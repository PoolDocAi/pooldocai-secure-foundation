import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const root=JSON.parse(readFileSync('../vercel.json','utf8'));
const cms=JSON.parse(readFileSync('vercel.json','utf8'));
const ignored=[
  'fix/cms-private-staging-media','security/cms-totp-owner-2fa-stage',
  'fix/marketing-public-launch-gates-20261028','security/cms-sms-2fa-staging-20261028',
  'fix/restricted-resource-checklists','review/cms-launch-readiness-20261028'
];
test('specified noisy branches disable Git-created previews in each project',()=>{
  for(const [name,config] of [['website',root],['CMS',cms]]) {
    const rules=config.git?.deploymentEnabled;
    assert.equal(typeof rules,'object',name);
    for(const b of ignored)assert.equal(rules[b],false,name+' did not suppress '+b);
  }
});
test('main and deliberate release branches remain enabled by default',()=>{
  for(const c of [root,cms]){
    assert.equal(c.git.deploymentEnabled.main,undefined);
    assert.notEqual(c.git.deploymentEnabled,false);
    assert.notEqual(c.previewDeploymentsDisabled,true);
    assert.equal(c.git.deploymentEnabled['release/owner-acceptance'],undefined);
  }
});
test('routing, build targets, and security headers are unaffected',()=>{
  assert.equal(root.outputDirectory,'website');
  assert.equal(root.cleanUrls,true);
  assert.ok(root.headers.some(h=>h.source==='/learning-review'));
  assert.equal(cms.outputDirectory,'public');
  assert.equal(cms.functions?.['api/resources.mjs']?.maxDuration,30);
  assert.ok(cms.rewrites.some(r=>r.source==='/admin/login'));
  assert.ok(cms.rewrites.some(r=>r.source==='/api/:path*'));
  assert.ok(cms.headers.some(h=>h.source==='/admin/:path*'));
});
