import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {sanitize} from '../src/content.mjs';
import {renderPublicArticle} from '../src/production/render.mjs';
const approved=readFileSync(new URL('./fixtures/approved-diagnostic-checklist.html', import.meta.url),'utf8');
const checklist=approved.match(/<ol class="diagnostic-checklist">[\s\S]*?<\/ol>/)[0];
test('approved ten-step checklist survives repeated validation and rendering',()=>{
 const clean=sanitize(checklist);
 assert.equal((clean.match(/type="checkbox"/g)||[]).length,10);
 for(let i=1;i<=10;i++) {assert.ok(clean.includes(`for="diagnostic-step-${i}"`));assert.ok(clean.includes(`id="diagnostic-step-${i}"`));}
 assert.equal(sanitize(clean),clean);
 const rendered=renderPublicArticle({content:{title:'Checklist',slug:'synthetic-checklist',body:clean}},{preview:true});
 assert.ok(rendered.includes(clean));
 assert.equal((rendered.match(/type="checkbox"/g)||[]).length,10);
 assert.doesNotMatch(clean,/checked|name=|value=|style=|on\w+=/i);
});
test('rejects other controls, duplicate IDs, targeting and executable attributes',()=>{
 const clean=sanitize(`<form action="https://evil.example"><input type="text" name="secret"><input type="checkbox" id="arbitrary"><div id="diagnostic-step-1">Text</div><label for="diagnostic-step-1" onclick="alert(1)"><input type="checkbox" id="diagnostic-step-1" checked name="exfil" value="x" form="evil" autofocus style="display:none" onchange="alert(1)">Step</label><input type="checkbox" id="diagnostic-step-1"><label for="victim">Other</label><button>Send</button><script>alert(1)</script></form>`);
 assert.equal((clean.match(/type="checkbox"/g)||[]).length,1);
 assert.equal((clean.match(/id="diagnostic-step-1"/g)||[]).length,1);
 assert.doesNotMatch(clean,/<form|<button|<script|type="text"|checked|name=|value=|form=|autofocus|style=|onchange|onclick|for="victim"/);
 assert.match(clean,/>Step<\/label>/);
});
