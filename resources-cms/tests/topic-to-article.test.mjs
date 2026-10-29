import test from 'node:test';
import assert from 'node:assert/strict';
import {validateTopicRequest,composeTopicArticle} from '../src/production/topic-to-article.mjs';
const categoryId='00000000-0000-4000-8000-000000000001';
const request={topic:'Ruthenium in swimming pool salt cells'};
const researchSources=[
 {id:'pentair',label:'Pentair salt chlorination technical guide',url:'https://www.pentair.com/technical-guide'},
 {id:'phta',label:'Pool and Hot Tub Alliance',url:'https://www.phta.org/technical'}
];
const prose='Pool owners should identify their actual equipment model and evaluate documented maintenance needs before drawing conclusions about the cause of a malfunction. This discussion explains observable conditions, limits of the available evidence, and the circumstances in which a qualified pool technician should inspect the system.';
const draft={
 title:'How salt-cell electrode materials influence maintenance and costs',
 summary:'Learn how salt chlorine generator electrodes work, why they wear out, and how to assess life-cycle costs without assuming material spot prices determine replacement costs.',
 intro:'Salt systems make chlorine by passing current through saline pool water. Understanding the coated electrode, the control equipment and routine maintenance helps owners make more informed replacement decisions without guessing at internal manufacturing costs.',
 keyTakeaways:['Salt systems manufacture chlorine and do not eliminate the need for free chlorine testing.','Cell performance depends on chemistry, operating hours and model-specific conditions.','Precious-metal spot prices are not a verified measure of a retail salt-cell bill of materials.'],
 sections:['How the process works','Why coatings matter','What determines maintenance','How prices should be compared'].map((heading,i)=>({
    heading,paragraphs:[prose+' Example '+i+'.',prose+' Relevant caution '+i+'.'],sourceIds:i%2?['pentair','phta']:['pentair']
 })),
 faqs:[{question:'Do salt systems still require water testing?',answer:prose},{question:'Can I infer cost from a metal spot price?',answer:prose}],
 seo:{title:'Ruthenium and Salt Cell Costs Explained',description:'How coated salt chlorine generator electrodes work, what affects cell life and maintenance, and why precious-metal prices alone do not establish retail replacement costs.'}
};
function generate(options={}){return composeTopicArticle({request,draft,researchSources,categoryId,...options});}

test('single-topic input defaults to broad audience and rejects malformed topics',()=>{
 assert.deepEqual(validateTopicRequest(request),{topic:request.topic,audience:'both'});
 for(const topic of ['', 'X', 'x'.repeat(181), 'Bad\nTopic'])
  assert.throws(()=>validateTopicRequest({topic}),{status:422});
});
test('complete response populates every editor article field without granting approval',()=>{
 const x=generate();
 assert.equal(x.article.audience,'both');assert.equal(x.article.sources.length,2);
 assert.match(x.article.body,/<h2>Frequently asked questions<\/h2>/);
 assert.match(x.article.body,/<h2>Sources and further reading<\/h2>/);
 assert.equal((x.article.body.match(/<h2>/g)||[]).length,7);
 assert.match(x.article.body,/Pentair salt chlorination technical guide/);
 assert.equal(x.article.seo.noindex,true);
 assert.equal(x.review.publicationGranted,false);
 assert.equal(x.review.editorialApprovalGranted,false);
 assert.equal(x.review.sourceVerificationRequired,true);
 assert.ok(x.review.wordCount>=450);
});
test('rejects fabricated citation references, untrusted links, outlines and insufficient FAQs',()=>{
 assert.throws(()=>generate({draft:{...draft,sections:[{...draft.sections[0],sourceIds:['invented']},...draft.sections.slice(1)]}}),/unknown source/);
 assert.throws(()=>generate({researchSources:[researchSources[0],{...researchSources[1],url:'javascript:alert(1)'}]}),/Untrusted research source/);
 assert.throws(()=>generate({draft:{...draft,sections:draft.sections.map(x=>({...x,paragraphs:['TBD','TBD']}))}}),/outline|placeholder/);
 assert.throws(()=>generate({draft:{...draft,faqs:[]}}),/FAQ/);
});
test('escapes untrusted model markup and does not mutate draft or sources',()=>{
 const original=structuredClone(draft),src=structuredClone(researchSources);
 const result=generate({draft:{...draft,sections:[{...draft.sections[0],heading:'<script>alert(1)</script>'},...draft.sections.slice(1)]}});
 assert.doesNotMatch(result.article.body,/<script>/);
 assert.match(result.article.body,/&lt;script&gt;/);
 assert.deepEqual(draft,original);assert.deepEqual(researchSources,src);
});
