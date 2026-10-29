import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeArticleCommand } from '../src/production/validation.mjs';
import { descriptionProposal } from '../src/production/seo-description.mjs';
import { renderPublicArticle } from '../src/production/render.mjs';
import { compatibilityRoute } from '../src/production/compat-api.mjs';
import { reviewProposals } from '../src/production/review-proposals.mjs';

const prose='You test your pool, look at the results, and see a bunch of numbers: chlorine, pH, alkalinity, calcium, and more.';
const article={title:'Pool water test results',slug:'pool-water-test-results',categoryId:'00000000-0000-4000-8000-000000000003',body:'<h1>Heading</h1><p>'+prose+'</p>',seo:{},sources:[]};
const id='00000000-0000-4000-8000-000000000002',origin='https://cms.test';
const headers={origin,cookie:'__Host-pooldocai-cms-csrf=token','x-csrf-token':'token'};
const request=(route,action,body,h=headers)=>route(new Request(origin+'/api/content/'+id+'/'+action,{method:'POST',headers:h,body:JSON.stringify(body)}));

test('normal create and manual save never invent or apply SEO descriptions',()=>{
  for(const action of ['create','save']){
    const saved=normalizeArticleCommand(action,article);
    assert.equal(saved.seo.description,'');
    assert.equal(normalizeArticleCommand(action,{...article,seo:{description:'My human description'}}).seo.description,'My human description');
    assert.equal(saved.state,undefined);assert.equal(saved.approved,undefined);
  }
  assert.equal(descriptionProposal(article).description,prose);
  assert.equal(descriptionProposal({...article,body:'<p>Too little.</p>'}).description,'');
  assert.equal(normalizeArticleCommand('save',article,{seo:{description:'Preserved manual metadata'}}).seo.description,'Preserved manual metadata');
});

test('review cannot write; only approved proposals produce a checked new revision',async()=>{
  let row={id,version:1,state:'draft',editable:structuredClone(article)},commands=[];
  const original=structuredClone(row);
  const db={
    read:async()=>row,list:async()=>[row],command:async(_u,_id,version,action,payload)=>{
      assert.equal(version,row.version);commands.push(action);row={...row,version:version+1,editable:payload};return row;
    }
  };
  const route=compatibilityRoute({db,identity:async()=>({id:'synthetic-owner'}),memberRole:async()=> 'owner',origin});
  const review=await request(route,'automated-review',{version:1});
  assert.equal(review.status,200);
  const report=await review.json();
  assert.equal(report.version,1);
  assert.equal(report.proposals.length,1);
  assert.equal(report.proposals[0].id,'seo-description');
  assert.equal(report.proposals[0].after,prose);
  assert.deepEqual(commands,[]);
  assert.deepEqual(row,original);
  assert.equal(report.publicationGranted,false);
  assert.equal((await request(route,'apply-review',{version:1,checksum:report.checksum,approvals:[]})).status,422);
  assert.deepEqual(commands,[]);
  assert.equal((await request(route,'apply-review',{version:1,checksum:'wrong',approvals:[{id:'seo-description'}]})).status,409);
  assert.deepEqual(commands,[]);
  assert.equal((await request(route,'apply-review',{version:1,checksum:report.checksum,approvals:[{id:'seo-description'}]},{...headers,origin:'https://untrusted.test'})).status,403);
  assert.deepEqual(commands,[]);
  const approved=await request(route,'apply-review',{version:1,checksum:report.checksum,approvals:[{id:'seo-description'}]});
  assert.equal(approved.status,200);const result=await approved.json();
  assert.equal(result.applied.length,1);
  assert.equal(result.article.version,2);
  assert.equal(row.editable.seo.description,prose);
  assert.equal(row.editable.body,article.body);
  assert.equal(row.state,'draft');
  assert.deepEqual(commands,['save']);
  assert.equal((await request(route,'apply-review',{version:1,checksum:report.checksum,approvals:[{id:'seo-description'}]})).status,409);
  assert.deepEqual(commands,['save']);
});

test('unit edit requires explicitly verified replacement; does not guess concentration',async()=>{
  const altered={...article,body:'<table><tr><td>Free chlorine</td><td>1.0m</td></tr></table>',seo:{description:prose}};
  let row={id,version:3,state:'draft',editable:altered},commands=[];
  const db={read:async()=>row,list:async()=>[row],command:async(_u,_id,v,action,payload)=>{commands.push(action);row={...row,version:v+1,editable:payload};return row;}};
  const route=compatibilityRoute({db,identity:async()=>({id:'synthetic-owner'}),memberRole:async()=> 'owner',origin});
  const report=await (await request(route,'automated-review',{version:3})).json();
  const proposal=report.proposals.find(p=>p.kind==='verified-unit');
  assert.ok(proposal);assert.equal(proposal.before,'1.0m');assert.equal(proposal.after,null);
  assert.deepEqual(commands,[]);
  for (const x of [{id:proposal.id,verifiedUnit:'ppm'}, {id:proposal.id,verifiedUnit:'meters',sourceVerified:true}]) {
    assert.equal((await request(route,'apply-review',{version:3,checksum:report.checksum,approvals:[x]})).status,422);
    assert.deepEqual(commands,[]);
  }
  const ok=await request(route,'apply-review',{version:3,checksum:report.checksum,approvals:[{id:proposal.id,verifiedUnit:'ppm',sourceVerified:true}]});
  assert.equal(ok.status,200);
  assert.equal(row.version,4);assert.match(row.editable.body,/1\.0 ppm/);assert.equal(row.state,'draft');
  assert.deepEqual(commands,['save']);
  assert.equal((await request(route,'automated-review',{version:3})).status,409);
});

test('review reports no actionable unit replacement for ambiguous duplicate text',()=>{
  const a={...article,seo:{description:prose},body:'<p>Free chlorine 1.0m</p><p>Total chlorine 1.0m</p>'};
  assert.equal(reviewProposals(a).filter(p=>p.kind==='verified-unit').length,0);
});

test('article descriptions remain quoted source prose, with no hidden script text',()=>{
  const other='Clean pool water depends on water chemistry, circulation, and filtration working together. Chlorine helps sanitize the water.';
  assert.notEqual(descriptionProposal(article).description,descriptionProposal({...article,body:'<p>'+other+'</p>'}).description);
  assert.equal(descriptionProposal({...article,body:'<script>'+other+'</script><p>Too little.</p>'}).description,'');
});

test('explicitly approved saved metadata renders in private and legacy delivery',()=>{
  const saved=normalizeArticleCommand('create',{...article,seo:{description:prose}});
  for(const preview of [true,false]){
    const html=renderPublicArticle({content:saved},{preview});
    assert.ok(html.includes('<meta name="description" content="'+prose+'">'));
    assert.ok(html.includes('<meta property="og:description" content="'+prose+'">'));
    if(preview)assert.match(html,/noindex, nofollow/);
  }
  const html=renderPublicArticle({content:{...saved,legacyHtml:'<!doctype html><html><head><meta name="description" content="old"><meta property="og:description" content="old"><link rel="canonical" href="old"></head><body>Approved design</body></html>'}});
  assert.ok(html.includes(prose));assert.doesNotMatch(html,/content="old"|href="old"/);assert.match(html,/Approved design/);
});
