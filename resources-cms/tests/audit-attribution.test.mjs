import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// Execute the shipped dashboard renderer with API/DOM boundaries stubbed.
const source=readFileSync(new URL('../public/admin.js',import.meta.url),'utf8');
const renderer=source.slice(source.indexOf('function auditActorLabel('),source.indexOf('function bindEdits('));
test('dashboard attributes recorded users, scheduler and unknown events without rewriting audit evidence',async()=>{
 const recent=[
  {action:'owner_approved_draft_import',actor_id:'historical-owner'},
  {action:'save',actor_id:'former-editor',email:'<editor@example.test>'},
  {action:'scheduled_publish',actor_id:null},
  {action:'owner_approved_draft_import',actor_id:null},
  {action:'scheduled_publish',actor_id:'recorded-user'},
 ];
 const before=JSON.stringify(recent),main={innerHTML:''};
 const context={main,content:[],api:async()=>({counts:{},recent,warnings:[]}),title:()=>'',canWrite:()=>false,
  esc:s=>String(s??'').replaceAll('<','&lt;').replaceAll('>','&gt;'),date:()=>'',
  $:()=>({addEventListener(){}}),$$:()=>[],bindEdits(){},newArticle(){},navigate(){}};
 await runInNewContext(renderer+'; dashboard()',context);
 const labels=[...main.innerHTML.matchAll(/<br> · (.*?)<\/small>/g)].map(m=>m[1]);
 assert.deepEqual(labels,['Recorded user','&lt;editor@example.test&gt;','Scheduler','Unattributed event','Recorded user']);
 assert.equal(JSON.stringify(recent),before);
});
