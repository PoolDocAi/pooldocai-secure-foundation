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
  assert.ok(typos.length>=4);
  assert.equal(typos.filter(x=>x.before==='teh').length,2);
  assert.ok(typos.some(x=>x.before==='watre'));
  assert.ok(typos.some(x=>x.before==='filtre'));
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

test('conservative one-edit suggestions catch uncatalogued pool typos without altering valid terms',()=>{
  const source={...article,
    body:'<p>Check equpment and fiilter before using the Pentair IntelliChlor system.</p>'};
  const suggestions=spellingSuggestions(source);
  assert.ok(suggestions.some(x=>x.before==='equpment'&&x.after==='equipment'),'missing-letter equipment typo');
  assert.ok(suggestions.some(x=>x.before==='fiilter'&&x.after==='filter'),'repeated-letter filter typo');
  assert.ok(!suggestions.some(x=>x.before==='Pentair'||x.before==='IntelliChlor'));
  const selected=suggestions.find(x=>x.before==='equpment');
  const approved=applyApprovedProposals(source,[{id:selected.id}]);
  assert.equal(approved.changed.body,'<p>Check equipment and fiilter before using the Pentair IntelliChlor system.</p>');
  assert.equal(source.body,'<p>Check equpment and fiilter before using the Pentair IntelliChlor system.</p>');
});


test('owner-reported Wat/What and poo/pool are highlighted without automatically editing',()=>{
  const a={...article,
    title:'Wat should you do if the poo is cloudy?',
    body:'<p>Wat causes a cloudy poo?</p><p>Remove dog poo from the swimming pool safely.</p><p>Poodles and poolside are normal words.</p>',
    seo:{description:'How to examine a cloudy poo without changing the original article.'}
  };
  const original=structuredClone(a);
  const report=reviewArticle({id,version:6,editable:a},[]);
  const proposed=report.proposals.filter(p=>p.kind==='spelling');
  const what=proposed.find(p=>p.field==='title'&&p.before==='Wat');
  const titlePoo=proposed.find(p=>p.field==='title'&&p.before==='poo');
  const bodyPoo=proposed.find(p=>p.field==='body'&&p.before==='poo');
  const fecalPoo=proposed.find(p=>p.field==='body'&&p.context.includes('dog poo'));
  assert.ok(what&&titlePoo&&bodyPoo&&fecalPoo);
  assert.equal(what.after,'What');assert.equal(titlePoo.after,'pool');
  assert.ok(fecalPoo.why.includes('feces'),'Ambiguous real word requires explicit context warning');
  assert.ok(report.findings.some(f=>f.area==='spelling'&&f.highlight==='Wat'&&f.field==='title'));
  assert.ok(report.findings.some(f=>f.area==='spelling'&&f.highlight==='poo'));
  assert.ok(!proposed.some(p=>p.before==='Poodles'||p.before==='poolside'));
  assert.deepEqual(a,original,'Read-only screening must never mutate the article');

  const approved=applyApprovedProposals(a,[{id:what.id},{id:titlePoo.id}]);
  assert.equal(approved.changed.title,'What should you do if the pool is cloudy?');
  assert.equal(approved.changed.body,a.body,'None of the unapproved body suggestions may change');
  assert.equal(approved.changed.seo.description,a.seo.description);
  assert.deepEqual(approved.applied.map(x=>x.id),[what.id,titlePoo.id]);
  assert.deepEqual(a,original);

  const onlyOnePoo=applyApprovedProposals(a,[{id:bodyPoo.id}]);
  assert.ok(onlyOnePoo.changed.body.includes('cloudy pool?'));
  assert.ok(onlyOnePoo.changed.body.includes('dog poo'),'Legitimate fecal reference must remain unedited');
  assert.equal(onlyOnePoo.changed.title,a.title);
});

test('Wat and poo suggestions use whole-word boundaries and do not change URLs or attributes',()=>{
  const a={...article,
    body:'<p>Wat is a poo filter?</p><a href="https://example.test/poo/Wat">Read about pool filters</a><p>The poodle sat poolside.</p>',
    seo:{description:'A draft explaining how to identify filter operating issues around a residential swimming pool.'}
  };
  const proposals=reviewProposals(a).filter(p=>p.kind==='spelling');
  assert.ok(proposals.some(p=>p.before==='Wat'&&p.field==='body'&&p.after==='What'));
  assert.ok(proposals.some(p=>p.before==='poo'&&p.field==='body'&&p.after==='pool'));
  assert.ok(proposals.every(p=>p.field!=='body'||p.context.indexOf('https://example.test')===-1));
  assert.ok(!proposals.some(p=>p.before==='poodle'||p.before==='poolside'));
  const approved=applyApprovedProposals(a,proposals.filter(p=>p.before==='Wat'||p.before==='poo').map(p=>({id:p.id})));
  assert.ok(approved.changed.body.includes('<p>What is a pool filter?</p>'));
  assert.ok(approved.changed.body.includes('href="https://example.test/poo/Wat"'));
});
