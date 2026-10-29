// Real browser + loopback HTTP + actual compatibility routes, with a synthetic
// in-memory DB and identity. This is not hosted Auth/database evidence.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { compatibilityRoute } from '../src/production/compat-api.mjs';
import { sendWebResponse } from '../src/production/node-http.mjs';

const categoryId='00000000-0000-4000-8000-000000000003',rows=new Map(),commands=[],errors=[];
const db={
  publicIndex:async()=>[], // No released articles in synthetic browser fixture.
  list:async()=>[...rows.values()],knowledgeStatuses:async()=>[],recentAudit:async()=>[],
  taxonomy:async()=>[{id:categoryId,kind:'category',name:'Synthetic guides',archived:false}],
  read:async(_u,id)=>rows.get(id),
  command:async(_u,id,version,action,payload)=>{
    commands.push(action);assert.ok(['create','save'].includes(action),'Browser must not approve or publish');
    const row={id,version:version+1,state:'draft',editable:payload};rows.set(id,row);return row;
  }
};
let route,origin;
const server=createServer(async(req,res)=>{
  try {
    const path=new URL(req.url,origin).pathname;
    if(path==='/api/platform/capabilities')return sendWebResponse(res,Response.json({features:{}}));
    if(path.startsWith('/api/')) {
      const chunks=[];for await(const c of req)chunks.push(c);
      return sendWebResponse(res,await route(new Request(new URL(req.url,origin),{method:req.method,headers:req.headers,...(req.method!=='GET'?{body:Buffer.concat(chunks)}:{})})));
    }
    const file={'/admin/':'public/admin.html','/public/admin.js':'public/admin.js','/public/admin.css':'public/admin.css'}[path];
    if(!file){res.writeHead(404);return res.end();}
    res.writeHead(200,{'Content-Type':path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html','Set-Cookie':'__Host-pooldocai-cms-csrf=synthetic-csrf; Path=/; Secure; SameSite=Lax'});res.end(readFileSync(file));
  } catch {res.writeHead(500);res.end('Synthetic test server failure');}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
route=compatibilityRoute({db,identity:async()=>({id:'synthetic-owner',email:'synthetic@example.test'}),memberRole:async()=> 'owner',origin});
let browser;const checks=[];
try {
  browser=await chromium.launch({headless:true,...(process.env.CMS_CHROMIUM?{executablePath:process.env.CMS_CHROMIUM}:{})});
  for(const width of [390,1440]) {
    const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage();
    page.on('pageerror',e=>errors.push(e.message));
    const savesBefore = commands.filter(x=>x==='save').length;
    await page.goto(origin+'/admin/#library');
    await page.locator('#import').click();
    await page.locator('#import-file').setInputFiles({name:'synthetic.md',mimeType:'text/markdown',buffer:Buffer.from('# Synthetic upload\n\nThis synthetic article explains how pool water testing, circulation, and filtration relate to the observations recorded during a weekly inspection. TODO: Repair at 20 psi. Mix chlorine with acid.')});
    await page.locator('#import-submit').click();
    await page.getByRole('heading',{name:'Automated article review',exact:true}).waitFor();
    const report=await page.locator('#dialog-content').innerText();
    assert.match(report,/safety · blocker/);assert.match(report,/Suggested next step:/);assert.match(report,/Read-only screening/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    const download=page.waitForEvent('download');await page.locator('#download-article-review').click();assert.match((await download).suggestedFilename(),/^article-review-/);
    await page.locator('.dialog-close').click();
    assert.equal(await page.locator('#seo-description').inputValue(),'');
    await page.locator('#automated-review').click();
    await page.getByRole('heading',{name:'Automated article review',exact:true}).waitFor();
    assert.equal(commands.filter(x=>x==='save').length,savesBefore,'Review alone must never save');
    await page.locator('[data-proposal="seo-description"]').click();
    assert.equal(await page.locator('[data-proposal="seo-description"]').getAttribute('aria-pressed'),'true');
    page.once('dialog',d=>d.accept());
    await page.locator('#apply-review').click();
    await page.waitForFunction(() => document.querySelector('#seo-description')?.value.length >= 90, null, {timeout:10000}).catch(async err => {
      throw new Error('Approved description was not visible after revision reload: '+(await page.locator('#toast').innerText())+'; '+err.message);
    });
    assert.ok((await page.locator('#seo-description').inputValue()).length>=90);
    await page.locator('#seo-description').fill('Human written description preserved after article changes.');
    await page.locator('#title').fill('Updated synthetic article');
    assert.equal(commands.filter(x=>x==='save').length,savesBefore+1,'Unsaved changes must not autosave');
    await page.waitForTimeout(1500);
    assert.equal(commands.filter(x=>x==='save').length,savesBefore+1,'Autosave must stay disabled');
    page.once('dialog',d=>d.accept());
    await page.locator('#save').click();
    await page.locator('#automated-review').click();
    await page.getByRole('heading',{name:'Automated article review',exact:true}).waitFor();
    assert.match(await page.locator('#dialog-content').innerText(),/Saved version 3/);
    await page.locator('.dialog-close').click();
    assert.equal(await page.locator('#seo-description').inputValue(),'Human written description preserved after article changes.');
    assert.equal([...rows.values()].at(-1).editable.seo.description,'Human written description preserved after article changes.');
    assert.equal(await page.locator('#save').evaluate(el=>el.closest('section.panel')?.querySelector('h2')?.textContent),'Editorial workflow');
    // Add two deliberate misspellings, then approve only one of them.
    await page.locator('#body').evaluate(el=>{
      el.insertAdjacentHTML('beforeend','<p>Check teh watre before proceeding.</p>');
      el.dispatchEvent(new Event('input',{bubbles:true}));
    });
    page.once('dialog',d=>d.accept());
    await page.locator('#save').click();
    await page.locator('#automated-review').click();
    await page.getByRole('heading',{name:'Automated article review',exact:true}).waitFor();
    const typoButtons=page.locator('[data-proposal^="spelling-body-"]');
    assert.ok(await typoButtons.count()>=2,'Expected both typo suggestions');
    const first=typoButtons.first();
    await first.click();
    assert.equal(await first.getAttribute('aria-pressed'),'true');
    assert.equal(await typoButtons.nth(1).getAttribute('aria-pressed'),'false');
    page.once('dialog',d=>d.accept());
    await page.locator('#apply-review').click();
    await page.waitForFunction(()=>document.querySelector('#body')?.textContent?.includes('Check the watre'),null,{timeout:10000});
    assert.match([...rows.values()].at(-1).editable.body,/Check the watre/);
    assert.doesNotMatch([...rows.values()].at(-1).editable.body,/Check the water/);

    // Browser acceptance: grammar changes are also opt-in, independent by occurrence.
    await page.locator('#body').evaluate(el=>{
      el.insertAdjacentHTML('beforeend','<p>The pressure is is stable. You could of reviewed it.</p>');
      el.dispatchEvent(new Event('input',{bubbles:true}));
    });
    const savesBeforeGrammar=commands.filter(x=>x==='save').length;
    await page.locator('#automated-review').click();
    await page.waitForTimeout(120);
    assert.equal(commands.filter(x=>x==='save').length,savesBeforeGrammar,'Dirty review must not write');
    page.once('dialog',d=>d.accept());
    await page.locator('#save').click();
    await page.locator('#automated-review').click();
    await page.getByRole('heading',{name:'Automated article review',exact:true}).waitFor();
    const repeatCard=page.locator('[data-proposal^="language-body-"]').filter({hasText:'Approve this change'}).first();
    assert.ok(await repeatCard.count()>=1,'Expected a grammar suggestion');
    const reportText=await page.locator('#dialog-content').innerText();
    assert.match(reportText,/is is/);
    assert.match(reportText,/could of/);
    const cards=page.locator('[data-proposal^="language-body-"]');
    assert.ok(await cards.count()>=2,'Expected separate grammar suggestions');
    await cards.first().click();
    assert.equal(await cards.first().getAttribute('aria-pressed'),'true');
    assert.equal(await cards.nth(1).getAttribute('aria-pressed'),'false');
    page.once('dialog',d=>d.accept());
    await page.locator('#apply-review').click();
    await page.waitForFunction(()=>document.querySelector('#body')?.textContent?.includes('pressure is stable'),null,{timeout:10000});
    assert.match([...rows.values()].at(-1).editable.body,/pressure is stable/);
    assert.match([...rows.values()].at(-1).editable.body,/could of reviewed it/,'Unapproved grammar suggestion unchanged');

    const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(axe.violations.map(v=>v.id),[]);
    checks.push(`${width}px: upload -> private draft -> evidence/fixes -> report download -> edit/save -> new version review; accessibility passed`);
    await context.close();
  }
  assert.ok([...rows.values()].every(row=>row.state==='draft'));assert.ok(commands.every(c=>['create','save'].includes(c)));assert.deepEqual(errors,[]);
  console.log(JSON.stringify({checks,commands,errors,scope:'local browser; synthetic identity and DB; no hosted claim'},null,2));
} finally {await browser?.close();await new Promise(r=>server.close(r));}
