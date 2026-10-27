import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

// Local UI-only fixture. No live Auth calls, email or real credentials.
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path.startsWith('/api/recovery/')) { res.setHeader('Content-Type', 'application/json'); res.end('{"ok":true}'); return; }
  const files = { '/admin/recover': ['recovery.html','text/html'], '/admin/reset-password': ['recovery.html','text/html'], '/public/recovery.js': ['recovery.js','application/javascript'], '/public/admin.css': ['admin.css','text/css'] };
  if (!files[path]) { res.writeHead(404);res.end();return; }
  res.setHeader('Content-Type',files[path][1]);res.end(readFileSync(new URL('../public/'+files[path][0], import.meta.url)));
});
await new Promise(r => server.listen(0,'127.0.0.1',r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CMS_CHROMIUM || '/tmp/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext();
const page = await context.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
mkdirSync('evidence/recovery',{recursive:true});
let assertions=0;
try {
  for (const width of [320,390,768,1440]) {
    await page.setViewportSize({width,height:1000});
    for (const path of ['/admin/recover','/admin/reset-password']) {
      await page.goto(origin+path);
      assert.ok(await page.locator(path.endsWith('recover')?'#request-recovery':'#reset-password').isVisible());assertions++;
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assertions++;
      const result=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
      assert.deepEqual(result.violations.map(v=>({id:v.id,impact:v.impact})),[]);assertions++;
      await page.screenshot({path:`evidence/recovery/${path.endsWith('recover')?'request':'reset'}-${width}.png`,fullPage:true});
    }
  }
  await page.goto(origin+'/admin/reset-password');
  await page.getByLabel('New password',{exact:true}).fill('synthetic-password-only');
  await page.getByLabel('Confirm new password',{exact:true}).fill('different-synthetic-value');
  await page.getByRole('button',{name:'Set new password'}).click();
  assert.equal(await page.locator('#status').textContent(),'Passwords do not match.');assertions++;
  await page.getByLabel('Confirm new password',{exact:true}).fill('synthetic-password-only');
  await page.getByRole('button',{name:'Set new password'}).click();
  await page.getByText('Password updated. Return to sign in with your new password.').waitFor();
  assert.equal(await page.locator('#reset-password').isVisible(),false);assertions++;
  assert.deepEqual(errors,[]);assertions++;
  console.log(JSON.stringify({fixture:'UI only; mocked Auth API',assertions,passed:assertions,failed:0,widths:[320,390,768,1440],screenshots:8,axeScans:8}));
} finally {await browser.close();await new Promise(r=>server.close(r));}
