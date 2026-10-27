import {chromium} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import {createCMS} from '../server.mjs';
import {passwordHash,uid} from '../src/store.mjs';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const dir=mkdtempSync(join(tmpdir(),'cms-nav-')), origin='http://127.0.0.1:4199';
const cms=createCMS({dbPath:join(dir,'cms.sqlite'),mediaPath:join(dir,'media'),origin});
cms.db.prepare('INSERT INTO users VALUES(?,?,?,?,1)').run(uid(),'navigation@example.test',passwordHash('local-synthetic-navigation-password'),'owner');
await new Promise(r=>cms.server.listen(4199,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.CMS_CHROMIUM,args:['--no-sandbox']});
const context=await browser.newContext({viewport:{width:1440,height:900}}), page=await context.newPage();
const results=[], errors=[];page.on('pageerror',e=>errors.push(e.message));
const check=(name)=>{results.push({name,passed:true});console.log('PASS',name);};
async function select(name){if(await page.locator('#mobile-menu').isVisible())await page.locator('#mobile-menu').click();await page.locator(`[data-page="${name}"]`).click();await page.waitForFunction(()=>document.activeElement.id==='main');}
try{
 await page.goto(origin+'/admin/login');await page.getByLabel('Email address').fill('navigation@example.test');await page.getByLabel('Password',{exact:true}).fill('local-synthetic-navigation-password');await page.getByRole('button',{name:'Sign in securely'}).click();await page.locator('#browse').waitFor();
 const session=(await context.cookies()).find(c=>c.httpOnly)?.value;
 for(const width of [320,360,390,430,700,701,768,1024,1440]){
  await page.setViewportSize({width,height:844});
  if(width<=700){
   await page.waitForFunction(()=>document.querySelector("#cms-sidebar").inert);
   await page.locator('#mobile-menu').click();assert.equal(await page.locator('.workspace').evaluate(e=>e.inert),true);assert.equal(await page.locator('#cms-sidebar').getAttribute('aria-modal'),'true');
   await page.locator('#nav-close').focus();await page.keyboard.press('Shift+Tab');assert.equal(await page.locator('#logout').evaluate(e=>e===document.activeElement),true);
   await page.keyboard.press('Tab');assert.equal(await page.locator('#nav-close').evaluate(e=>e===document.activeElement),true);
   if(width===390){const a=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(a.violations.map(x=>x.id),[]);}
   await page.keyboard.press('Escape');assert.equal(await page.locator('#mobile-menu').getAttribute('aria-expanded'),'false');assert.equal(await page.locator('#mobile-menu').evaluate(e=>e===document.activeElement),true);check(`${width}px modal drawer focus trap, Escape, accessibility state`);
  }
  for(const name of ['library','dashboard','taxonomy','media','seo','knowledge','settings']){
   await select(name);assert.equal(new URL(page.url()).hash,'#'+name);assert.equal(await page.locator(`[data-page="${name}"]`).getAttribute('aria-current'),'page');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);check(`${width}px ${name} navigation and overflow`);
  }
 }
 assert.equal((await context.cookies()).find(c=>c.httpOnly)?.value,session);check('Same local authenticated session survives all section transitions');
 await page.setViewportSize({width:390,height:844});await select('dashboard');await select('library');await page.goBack();await page.locator('#browse').waitFor();assert.equal(new URL(page.url()).hash,'#dashboard');await page.goForward();await page.locator('#search').waitFor();assert.equal(new URL(page.url()).hash,'#library');check('Browser Back and Forward restore sections');
 await select('dashboard');await page.getByRole('button',{name:'New article'}).click();await page.getByLabel('Article title',{exact:true}).fill('Synthetic navigation draft');await page.getByRole('button',{name:'Create private draft'}).click();await page.getByLabel('Summary',{exact:true}).waitFor();
 await page.route('**/api/content/*',async route=>{if(route.request().method()==='PUT')return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Synthetic save outage"}'});await route.continue();});
 await page.getByLabel('Summary',{exact:true}).fill('Unsaved synthetic change');
 page.once('dialog',d=>d.dismiss());await page.locator('#mobile-menu').click();await page.locator('[data-page="library"]').click();assert.equal(await page.getByLabel('Summary',{exact:true}).inputValue(),'Unsaved synthetic change');await page.keyboard.press('Escape');check('Cancelled navigation preserves unsaved editor');
 page.once('dialog',d=>d.dismiss());await page.goBack();await page.waitForFunction(()=>location.hash==='#dashboard');assert.equal(await page.getByLabel('Summary',{exact:true}).inputValue(),'Unsaved synthetic change');check('Cancelled Back restores history position and editor');
 page.once('dialog',d=>d.dismiss());await page.locator('#mobile-logout').click();assert.equal(await page.getByLabel('Summary',{exact:true}).isVisible(),true);check('Cancelled logout preserves draft and session');
 page.once('dialog',d=>d.accept());await select('library');await page.locator('#search').waitFor();await page.goBack();await page.locator('#browse').waitFor();await page.goForward();await page.locator('#search').waitFor();check('History remains usable after cancelled dirty Back');
 await page.locator('#mobile-menu').click();await page.setViewportSize({width:1024,height:844});await page.waitForFunction(()=>!document.querySelector(".workspace").inert);assert.equal(await page.locator('.workspace').evaluate(e=>e.inert),false);assert.equal(await page.locator('#cms-sidebar').evaluate(e=>e.inert),false);check('Android-style viewport resize releases drawer modal state');
 await page.locator('#logout').click();await page.waitForURL('**/admin/login');await page.goto(origin+'/admin/');await page.waitForURL('**/admin/login');check('Local logout clears session and private route rejects access');
 assert.deepEqual(errors,[]);check('No browser JavaScript errors');
}finally{
 mkdirSync('evidence/navigation',{recursive:true});writeFileSync('evidence/navigation/results.json',JSON.stringify({results,errors,auth:'Real local SQLite session; Supabase hosted tests separate'},null,2));await browser.close();await new Promise(r=>cms.server.close(r));rmSync(dir,{recursive:true,force:true});
}
