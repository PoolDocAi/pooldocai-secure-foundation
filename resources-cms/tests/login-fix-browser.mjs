import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
let failure={status:500,type:'text/plain',body:'A server error has occurred. synthetic-private-detail'};
let submissions=0;
const server=createServer((req,res)=>{
 const p=new URL(req.url,'http://localhost').pathname;
 if(p==='/api/login'){submissions++;res.writeHead(failure.status,{'Content-Type':failure.type});res.end(failure.body);return;}
 if(p==='/admin/'){res.end('<h1>Mocked private dashboard</h1>');return;}
 const files={'/admin/login':['hosted-login.html','text/html'],'/public/login.js':['login.js','application/javascript'],'/public/admin.css':['admin.css','text/css']};
 if(p==='/logo.svg'){res.setHeader('Content-Type','image/svg+xml');res.end(readFileSync(new URL('../evidence/live/logo.svg',import.meta.url)));return;}
 if(!files[p]){res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type',files[p][1]);res.end(readFileSync(new URL('../public/'+files[p][0],import.meta.url)));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({executablePath:process.env.CMS_CHROMIUM||'/tmp/chromium',args:['--no-sandbox']});
const context=await browser.newContext();const page=await context.newPage();let assertions=0;
async function submit(){await page.goto(origin+'/admin/login');await page.getByLabel('Email address').fill('synthetic@example.test');await page.getByLabel('Password',{exact:true}).fill('synthetic-only');await page.getByRole('button',{name:'Sign in securely'}).click();}
try {
 for(const width of [320,390,1440]){
  await page.setViewportSize({width,height:900});
  for(const test of [
   {status:500,type:'text/plain',body:'A server error has occurred. synthetic-private-detail',expected:'Sign-in service unavailable (HTTP 500). Please try again.'},
   {status:401,type:'text/html',body:'<html>Authentication Required synthetic-private-detail</html>',expected:'Sign-in service unavailable (HTTP 401). Please try again.'},
   {status:500,type:'application/json',body:'broken{synthetic-private-detail',expected:'Sign-in service returned an invalid response. Please try again.'},
   {status:403,type:'application/json',body:'{"error":"Login rejected"}',expected:'Sign-in is not authorized for this workspace.'},
  ]){failure=test;await submit();await page.getByText(test.expected,{exact:true}).waitFor();assertions++;assert.equal(await page.getByRole('button',{name:'Sign in securely'}).isEnabled(),true);assertions++;assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assertions++;assert.doesNotMatch(await page.locator('#error').innerText(),/synthetic-private-detail|Unexpected token/);assertions++;}
 }
 failure={status:200,type:'application/json',body:'{"id":"00000000-0000-4000-8000-000000000001","role":"owner"}'};
 await submit();await page.getByRole('heading',{name:'Mocked private dashboard'}).waitFor();assertions++;
 console.log(JSON.stringify({assertions,passed:assertions,failed:0,submissions,widths:[320,390,1440],provider:'mocked; no real credentials or Auth calls'}));
}finally{await browser.close();await new Promise(r=>server.close(r));}
