import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createCMS } from '../server.mjs';
import { writeFileSync } from 'node:fs';
const origin='http://127.0.0.1:4213';
const cms=createCMS({origin});
await new Promise(r=>cms.server.listen(4213,'127.0.0.1',r));
const browser=await chromium.launch({executablePath:process.env.CMS_CHROMIUM,args:['--no-sandbox']});
const context=await browser.newContext();const page=await context.newPage();const results=[];
try {
 const rows=cms.db.prepare('SELECT a.* FROM articles a JOIN editorial_holds h ON h.article_id=a.id').all();
 assert.equal(rows.length,32);
 assert.equal((await context.request.get(origin+'/preview/'+rows[0].id)).status(),401);
 await page.goto(origin+'/admin/login');await page.getByLabel('Email address').fill('owner@pooldocai.local');await page.getByLabel('Password',{exact:true}).fill('local-development-only-password');await page.getByRole('button',{name:'Sign in securely'}).click();await page.getByRole('heading',{name:'A little knowledge. A lot of clarity.'}).waitFor();
 for(const row of rows){
  const data=JSON.parse(row.data);
  for(const width of [390,1440]){
   await page.setViewportSize({width,height:900});await page.goto(origin+'/preview/'+row.id);
   assert.equal(await page.locator('meta[name="robots"]').getAttribute('content'),'noindex, nofollow');
   assert.equal(await page.locator('h1').textContent(),data.title);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }
  const publicPage=await context.request.get(origin+'/resources/'+row.slug+'/');
  assert.equal(publicPage.status(),row.published?200:404);
  results.push({slug:row.slug,viewports:2,privateNoindex:true,publicStatus:publicPage.status()});
 }
 writeFileSync('evidence/editorial-v29-browser.json',JSON.stringify({passed:results.length,previews:results.length*2,results},null,2));
 console.log('PASS: 32 resources, 64 responsive private previews, public snapshot/privacy checks');
} finally {await browser.close();await new Promise(r=>cms.server.close(r));}
