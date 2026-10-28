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
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
    const page=await browser.newPage({viewport,reducedMotion:'no-preference'});
    const errors=[];
    page.on('pageerror',err=>errors.push(err.message));
    await page.goto('http://127.0.0.1:'+server.address().port+'/',{waitUntil:'load',timeout:30000});
    await page.waitForTimeout(250);
    console.log('BROWSER STATE '+viewport.width+' '+JSON.stringify({errors,ready:await page.evaluate(()=>document.readyState),script:[...await page.locator('script[src]').evaluateAll(nodes=>nodes.map(n=>n.src))],buttons:await page.locator('[data-step]').count()}));
    const img=await page.evaluate(()=>{const day=document.getElementById('day');return {w:day.naturalWidth,h:day.naturalHeight,sceneZ:getComputedStyle(document.querySelector('.scenery')).zIndex}});
    assert(img.w>0&&img.h>0,'Day image missing/broken: '+JSON.stringify(img));
    assert.equal(img.sceneZ,'0','Scenery behind canvas');
    const night=page.locator('[data-step="2"]');
    await night.click({timeout:10000});
    console.log('NIGHT CLICK STATE '+JSON.stringify({pressed:await night.getAttribute('aria-pressed'),errors,heading:await page.locator('#headline').innerText()}));
    assert.equal(await night.getAttribute('aria-pressed'),'true','Night selector did not activate');
    await page.waitForFunction(()=>document.getElementById('night').naturalWidth>0,{timeout:15000});
    assert.match(await page.locator('#headline').innerText(),/BETTER POOL DAYS/i,'Night headline did not update');
    const care=page.locator('[data-step="1"]');
    await care.click({timeout:10000});
    assert.equal(await care.getAttribute('aria-pressed'),'true','Pool-care selector did not activate');
    assert.match(await page.locator('#headline').innerText(),/LESS GUESSWORK/i,'Pool-care headline did not update');
    const day=page.locator('[data-step="0"]');
    await day.click({timeout:10000});
    assert.equal(await day.getAttribute('aria-pressed'),'true','Day selector did not activate');
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
    console.log('BROWSER PASS '+viewport.width+'x'+viewport.height+' backgrounds, scene buttons, footer, links');
    await page.close();
  }
}finally{if(browser)await browser.close();await new Promise(ok=>server.close(ok))}
