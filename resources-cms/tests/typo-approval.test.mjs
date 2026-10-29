import test from 'node:test';
import assert from 'node:assert/strict';
import {spellingSuggestions} from '../src/production/editorial-typos.mjs';
import {reviewProposals,applyApprovedProposals} from '../src/production/review-proposals.mjs';
import {reviewArticle} from '../src/production/editorial-review.mjs';
import {compatibilityRoute} from '../src/production/compat-api.mjs';

const id='00000000-0000-4000-8000-000000000002',origin='https://cms.test';
const article={
  title:'A pool care guide',slug:'a-pool-care-guide',
  categoryId:'00000000-0000-4000-8000-000000000003',
  body:'<p>Check teh watre before servicing teh filtre.</p>',
  summary:'Maintain water clarity.',sources:[],seo:{description:'This editorial document describes safe checks and records for common water circulation observations and inspection notes.'}
};
const headers={origin,cookie:'__Host-pooldocai-cms-csrf=token','x-csrf-token':'token'};
const post=(route,action,request,extraHeaders={})=>route(new Request(origin+'/api/content/'+id+'/'+action,{method:'POST',headers:{...headers,...extraHeaders},body:JSON.stringify(request)}));

test('obvious typos are highlighted only in article text, not HTML attributes or brand names',()=>{
  const a={...article,
    title:'Teh inspection guide',
    summary:'Please recieve the readings.',
    body:'<p>Check teh watre near the fiter.</p><a href="https://example.test/teh/filtre">Use the manufacter manual.</a><p>Pentair IntelliChlor 40 remains unchanged.</p>'};
  const before=structuredClone(a);
  const suggestions=spellingSuggestions(a);
  assert.ok(suggestions.some(x=>x.field==='title'&&x.before==='Teh'&&x.after==='The'));
  assert.ok(suggestions.some(x=>x.field==='summary'&&x.before==='recieve'&&x.after==='receive'));
  for(const value of ['teh','watre','fiter','manufacter']) assert.ok(suggestions.some(x=>x.before===value),value);
  assert.ok(!suggestions.some(x=>x.before==='Pentair'||x.before==='IntelliChlor'));
  assert.ok(!suggestions.some(x=>x.context.includes('https://example.test/teh')));
  assert.deepEqual(a,before);
});

test('each duplicate occurrence receives a unique approval ID, and unapproved occurrences remain exact',()=>{
  const a={...article,body:'<p>Check teh filter.</p><p>Record teh reading.</p>'};
  const before=structuredClone(a);
  const suggestions=reviewProposals(a).filter(x=>x.kind==='spelling'&&x.before==='teh');
  assert.equal(suggestions.length,2);
  assert.notEqual(suggestions[0].id,suggestions[1].id);
  const one=applyApprovedProposals(a,[{id:suggestions[0].id}]);
  assert.equal(one.changed.body,'<p>Check the filter.</p><p>Record teh reading.</p>');
  assert.deepEqual(one.applied.map(x=>x.id),[suggestions[0].id]);
  assert.deepEqual(a,before);
  const both=applyApprovedProposals(a,suggestions.map(x=>({id:x.id})));
  assert.equal(both.changed.body,'<p>Check the filter.</p><p>Record the reading.</p>');
});

test('disjoint spelling and verified unit approvals apply together; unapproved misspellings remain',()=>{
  const a={...article,body:'<p>Free chlorine 1.0m; check teh watre.</p>'};
  const proposals=reviewProposals(a);
  const unit=proposals.find(x=>x.kind==='verified-unit'),typo=proposals.find(x=>x.kind==='spelling'&&x.before==='teh');
  const watre=proposals.find(x=>x.kind==='spelling'&&x.before==='watre');
  assert.ok(unit&&typo&&watre);
  const r=applyApprovedProposals(a,[{id:typo.id},{id:unit.id,verifiedUnit:'ppm',sourceVerified:true}]);
  assert.equal(r.changed.body,'<p>Free chlorine 1.0 ppm; check the watre.</p>');
  assert.equal(r.applied.length,2);assert.ok(!r.applied.some(x=>x.id===watre.id));
  assert.equal(a.body,'<p>Free chlorine 1.0m; check teh watre.</p>');
  assert.throws(()=>applyApprovedProposals(a,[{id:unit.id,verifiedUnit:'ppm',sourceVerified:false}]),/Verify the original measurement/);
});

test('read-only screening highlights typo, approval saves exactly selected edit and refuses replay',async()=>{
  let row={id,version:5,state:'draft',editable:structuredClone(article)},commands=[];
  const db={
    read:async()=>row,list:async()=>[row],command:async(_actor,_id,v,action,payload)=>{
      assert.equal(v,row.version);commands.push(action);row={...row,editable:payload,version:v+1};return row;
    }
  };
  const route=compatibilityRoute({db,identity:async()=>({id:'synthetic-owner'}),memberRole:async()=> 'owner',origin});
  const read=await post(route,'automated-review',{version:5});
  assert.equal(read.status,200);
  const report=await read.json();
  const typos=report.proposals.filter(p=>p.kind==='spelling');
  assert.equal(typos.length,4);
  assert.ok(report.findings.some(f=>f.area==='spelling'&&f.evidence==='teh'&&f.highlight==='teh'&&f.why));
  assert.deepEqual(commands,[]);
  assert.equal((await post(route,'apply-review',{version:5,checksum:'wrong',approvals:[{id:typos[0].id}]})).status,409);
  assert.equal((await post(route,'apply-review',{version:5,checksum:report.checksum,approvals:[{id:'spelling-body-99999'}]})).status,409);
  assert.equal((await post(route,'apply-review',{version:5,checksum:report.checksum,approvals:[{id:typos[0].id},{id:typos[0].id}]})).status,422);
  assert.deepEqual(commands,[]);
  const r=await post(route,'apply-review',{version:5,checksum:report.checksum,approvals:[{id:typos[0].id}]});
  assert.equal(r.status,200);
  assert.equal(row.version,6);assert.equal(row.state,'draft');
  assert.equal(row.editable.body,'<p>Check the watre before servicing teh filtre.</p>');
  assert.deepEqual(commands,['save']);
  assert.equal((await post(route,'apply-review',{version:5,checksum:report.checksum,approvals:[{id:typos[1].id}]})).status,409);
  assert.deepEqual(commands,['save']);
});

test('reviewers are not authorized to apply even accurate spelling proposals',async()=>{
  const row={id,version:1,state:'draft',editable:article};
  let writes=0;
  const route=compatibilityRoute({db:{
    read:async()=>row,list:async()=>[row],
    command:async()=>{writes++;throw Error('unexpected write');}
  },identity:async()=>({id:'synthetic-reviewer'}),memberRole:async()=> 'reviewer',origin});
  const report=await (await post(route,'automated-review',{version:1})).json();
  const typo=report.proposals.find(p=>p.kind==='spelling');
  assert.ok(typo);
  const denied=await post(route,'apply-review',{version:1,checksum:report.checksum,approvals:[{id:typo.id}]});
  assert.equal(denied.status,403);assert.equal(writes,0);
});
