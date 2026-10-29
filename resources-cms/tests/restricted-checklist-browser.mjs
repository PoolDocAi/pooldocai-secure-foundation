import {chromium} from 'playwright';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {sanitize} from '../src/content.mjs';
import {renderPublicArticle} from '../src/production/render.mjs';
const fixture=readFileSync(new URL('./fixtures/approved-diagnostic-checklist.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/public.css',import.meta.url),'utf8')+'\n'+readFileSync(new URL('../public/resource-design.css',import.meta.url),'utf8');
const html=renderPublicArticle({content:{title:'Diagnostic workflow',slug:'synthetic-checklist',body:sanitize(fixture)}},{preview:true});
const browser=await chromium.launch({...(process.platform==='win32'?{channel:'msedge'}:{}),headless:true});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}});const requests=[];
 await page.route('**/*',route=>{requests.push(route.request().url());return route.abort();});
 await page.setContent(html.replace(/<link[^>]+>|<script[\s\S]*?<\/script>/g,''));await page.addStyleTag({content:css});
 const inputs=page.getByRole('checkbox');assert.equal(await inputs.count(),10);
 assert.equal(await inputs.first().isChecked(),false);
 await inputs.first().focus();await page.keyboard.press('Space');assert.equal(await inputs.first().isChecked(),true);
 assert.notEqual(await inputs.first().evaluate(el=>getComputedStyle(el).outlineStyle),'none');
 await page.locator('label[for="diagnostic-step-2"]').click();assert.equal(await inputs.nth(1).isChecked(),true);
 const size=await page.locator('label[for="diagnostic-step-2"]').boundingBox();assert.ok(size.height>=44);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 mkdirSync('evidence/restricted-checklist',{recursive:true});await page.screenshot({path:'evidence/restricted-checklist/mobile.png',fullPage:true});
 await page.emulateMedia({media:'print'});
 const print=await inputs.first().evaluate(el=>{const s=getComputedStyle(el);return {appearance:s.appearance,border:s.borderTopWidth,background:s.backgroundColor};});
 assert.equal(print.appearance,'none');assert.equal(print.border,'2px');assert.equal(print.background,'rgb(255, 255, 255)');
 await page.pdf({path:'evidence/restricted-checklist/print-verification.pdf',format:'A4',printBackground:true});
 assert.deepEqual(requests,[]);
 const result={passed:true,checkboxes:10,mobileWidth:390,keyboard:true,labelTouchTarget:true,noOverflow:true,blankPrintBoxes:true,networkRequests:0,hostedDraftsCreated:0};
 writeFileSync('evidence/restricted-checklist/results.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}
