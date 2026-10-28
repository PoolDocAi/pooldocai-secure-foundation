// Browser acceptance of generated static public marketing build. No production writes or form submissions.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join,resolve,extname,sep} from 'node:path';
import {chromium} from 'playwright';
import chromiumBinary from '@sparticuz/chromium';

const root=resolve('public');
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.webp':'image/webp','.svg':'image/svg+xml','.xml':'application/xml','.txt':'text/plain'};
const server=createServer(async(req,res)=>{
  const raw=new URL(req.url,'http://localhost').pathname;
  const rel=decodeURIComponent(raw).replace(/^\/+/, '');
  let file=resolve(root,rel);
  if(!file.startsWith(root+sep)&&file!==root){res.writeHead(403).end();return}
  if(raw.endsWith('/')||raw==='/')file=join(file,'index.html');
  try{const buf=await readFile(file);res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream'});res.end(buf)}
  catch{res.writeHead(404).end('not found')}
});
await new Promise((ok,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',ok)});
let browser;
try{
  const bin=await chromiumBinary.executablePath();
  browser=await chromium.launch({executablePath:bin,args:chromiumBinary.args,headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:900},reducedMotion:'no-preference'});
  const errors=[];
  page.on('pageerror',err=>errors.push(err.message));
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
    errors.length=0;
    await page.setViewportSize(viewport);
    await page.goto('http://127.0.0.1:'+server.address().port+'/',{waitUntil:'load',timeout:30000});
    await page.waitForTimeout(250);
    console.log('BROWSER STATE '+viewport.width+' '+JSON.stringify({errors,ready:await page.evaluate(()=>document.readyState),script:[...await page.locator('script[src]').evaluateAll(nodes=>nodes.map(n=>n.src))],buttons:await page.locator('[data-step]').count()}));
    const img=await page.evaluate(()=>{const day=document.getElementById('day');return {w:day.naturalWidth,h:day.naturalHeight,sceneZ:getComputedStyle(document.querySelector('.scenery')).zIndex}});
    assert(img.w>0&&img.h>0,'Day image missing/broken: '+JSON.stringify(img));
    assert.equal(img.sceneZ,'0','Scenery behind canvas');
    const night=page.locator('[data-step="2"]');
    await night.click({timeout:10000});
    console.log('NIGHT CLICK STATE '+JSON.stringify({pressed:await night.getAttribute('aria-pressed'),errors,heading:await page.locator('#headline').innerText()}));
    await page.waitForFunction(()=>document.querySelector('[data-step="2"]')?.getAttribute('aria-pressed')==='true',null,{timeout:15000});
    await page.waitForFunction(()=>document.getElementById('night').naturalWidth>0,null,{timeout:15000});
    assert.match(await page.locator('#headline').innerText(),/BETTER POOL DAYS/i,'Night headline did not update');
    const care=page.locator('[data-step="1"]');
    await care.click({timeout:10000});
    await page.waitForFunction(()=>document.querySelector('[data-step="1"]')?.getAttribute('aria-pressed')==='true',null,{timeout:10000});
    assert.match(await page.locator('#headline').innerText(),/LESS GUESSWORK/i,'Pool-care headline did not update');
    const day=page.locator('[data-step="0"]');
    await day.click({timeout:10000});
    await page.waitForFunction(()=>document.querySelector('[data-step="0"]')?.getAttribute('aria-pressed')==='true',null,{timeout:10000});
    assert.match(await page.locator('#headline').innerText(),/SMARTER/i,'Day headline did not update');
    assert.equal(await page.locator('a[href="/resources/"]').count(),1,'Duplicate Resources link');
    assert.equal(await page.locator('a[href*="pooldocai-resources-cms-private-owner-review.vercel.app/admin/"]').count(),1,'Admin missing');
    assert.equal(await page.getByText('Something smarter is on the horizon').count(),0,'Removed copy still visible');
    const foot=await page.locator('.launch-footer').evaluate(el=>{
      const b=el.getBoundingClientRect(),brand=el.querySelector('.launch-footer-brand').getBoundingClientRect(),nav=el.querySelector('.launch-footer-links').getBoundingClientRect();
      return {center:b.x+b.width/2,brand:brand.x+brand.width/2,nav:nav.y,brandBottom:brand.bottom}
    });
    assert(Math.abs(foot.center-foot.brand)<2,'Footer brand is not centered');
    assert(foot.nav>=foot.brandBottom,'Footer links must be below PoolDocAI');
    assert.deepEqual(errors,[],'Unhandled homepage JavaScript error(s): '+errors.join('; '));
    for(const dot of await page.locator('[data-step]').all()){
      assert.equal((await dot.textContent()).trim(),'','Scene control must be visibly unlabeled');
      assert(await dot.getAttribute('aria-label'),'Scene control needs an accessible label');
    }
    await page.locator('.assistant-launcher').click();
    await page.locator('#widget-resource-search').fill('');
    await page.locator('#widget-resource-search').press('Enter');
    await page.locator('.pd-widget-card').first().waitFor();
    assert.equal(await page.locator('.pd-widget-card').count(),2);
    await page.locator('#widget-resource-search').fill('pump');
    await page.locator('#widget-resource-search').press('Enter');
    await page.waitForFunction(()=>document.querySelector('.pd-widget-status')?.textContent==='1 published resource');
    assert.match(await page.locator('.pd-widget-card').innerText(),/pump/i);
    await page.locator('#widget-resource-search').fill('green');
    await page.locator('#widget-resource-search').press('Enter');
    await page.waitForFunction(()=>document.querySelector('.pd-widget-card h3')?.textContent.toLowerCase().includes('green'));
    assert.equal(await page.locator('.pd-widget-card').count(),1);
    await page.locator('#widget-resource-search').fill('zzzz-no-approved-guide');
    await page.locator('#widget-resource-search').press('Enter');
    await page.locator('.pd-empty').waitFor();
    assert.equal(await page.locator('.pd-widget-card').count(),0);
    assert.match(await page.locator('.pd-widget-status').innerText(),/No published resource/);
    await page.locator('[data-close]').click();
    const catalog=await (await page.request.get('http://127.0.0.1:'+server.address().port+'/published-guides.json')).json();
    assert.deepEqual(catalog.map(r=>r.slug).sort(),['green-pool-first-checks','pool-pump-wont-start']);
    for(const guide of catalog){
      const response=await page.request.get('http://127.0.0.1:'+server.address().port+guide.url);
      assert.equal(response.status(),200,'Guide link must resolve');
    }
    assert.deepEqual(errors,[]);
    console.log('BROWSER PASS '+viewport.width+'x'+viewport.height+' backgrounds, scene buttons, footer, links');
  }
  await page.close();
}finally{if(browser)await browser.close();await new Promise(ok=>server.close(ok))}
