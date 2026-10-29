import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeArticleCommand} from '../src/production/validation.mjs';
import {descriptionProposal} from '../src/production/seo-description.mjs';
import {renderPublicArticle} from '../src/production/render.mjs';
import {compatibilityRoute} from '../src/production/compat-api.mjs';
const prose='You test your pool, look at the results, and see a bunch of numbers: chlorine, pH, alkalinity, calcium, and more.';
const article={title:'Pool water test results',slug:'pool-water-test-results',categoryId:'00000000-0000-4000-8000-000000000003',body:`<h1>Heading</h1><p>${prose}</p>`,seo:{}};
test('create/save fill absent metadata from complete article prose; preserve human edits',()=>{
  for(const action of ['create','save']) {
    const saved=normalizeArticleCommand(action,article);
    assert.equal(saved.seo.description,prose);
    assert.equal(normalizeArticleCommand(action,{...article,seo:{description:'My human description'}}).seo.description,'My human description');
    assert.equal(saved.state,undefined);assert.equal(saved.approved,undefined);
  }
  assert.equal(descriptionProposal({...article,body:'<p>Too little.</p>'}).description,'');
  assert.match(descriptionProposal({...article,body:'<p>Too little.</p>'}).warning,/Not enough/);
  assert.equal(normalizeArticleCommand('save',article,{seo:{description:'Preserved manual metadata'}}).seo.description,'Preserved manual metadata');
});
test('review appends exactly one protected save and binds report to the new revision',async()=>{
  const id='00000000-0000-4000-8000-000000000002',commands=[];
  let row={id,version:1,state:'draft',editable:article};
  const original=structuredClone(row);
  const db={read:async()=>row,list:async()=>[row],command:async(_u,_id,v,action,payload)=>{
    assert.equal(v,row.version);commands.push(action);row={...row,version:v+1,editable:payload};return row;
  }};
  const route=compatibilityRoute({db,identity:async()=>({id:'synthetic-owner'}),memberRole:async()=> 'owner',origin:'https://cms.test'});
  const request=version=>route(new Request(`https://cms.test/api/content/${id}/automated-review`,{method:'POST',headers:{origin:'https://cms.test',cookie:'__Host-pooldocai-cms-csrf=token','x-csrf-token':'token'},body:JSON.stringify({version})}));
  const response=await request(1),report=await response.json();
  assert.equal(response.status,200);assert.equal(report.version,2);assert.equal(report.savedArticle.data.seo.description,prose);
  assert.equal(original.editable.seo.description,undefined);assert.equal(row.editable.body,original.editable.body);
  assert.equal(report.publicationGranted,false);assert.equal(row.state,'draft');assert.deepEqual(commands,['save']);
  assert.equal((await request(1)).status,409);
  assert.equal((await request(2)).status,200);assert.deepEqual(commands,['save']);
});
test('article-specific descriptions differ; markup, headings and hidden code excluded',()=>{
  const other='Clean pool water depends on water chemistry, circulation, and filtration working together. Chlorine helps sanitize the water.';
  assert.notEqual(descriptionProposal(article).description,descriptionProposal({...article,body:`<p>${other}</p>`}).description);
  assert.equal(descriptionProposal({...article,body:`<script>${other}</script><p>Too little.</p>`}).description,'');
});
test('saved metadata renders in private preview and future public/legacy delivery',()=>{
  const saved=normalizeArticleCommand('create',article);
  for(const preview of [true,false]) {
    const html=renderPublicArticle({content:saved},{preview});
    assert.ok(html.includes(`<meta name="description" content="${prose}">`));
    assert.ok(html.includes(`<meta property="og:description" content="${prose}">`));
    assert.match(html,/https:\/\/pooldocai.com\/resources\/pool-water-test-results\//);
    if(preview)assert.match(html,/noindex, nofollow/);
  }
  const html=renderPublicArticle({content:{...saved,legacyHtml:'<!doctype html><html><head><meta name="description" content="old"><meta property="og:description" content="old"><link rel="canonical" href="old"></head><body>Approved design</body></html>'}});
  assert.ok(html.includes(prose));assert.doesNotMatch(html,/content="old"|href="old"/);assert.match(html,/Approved design/);
});
