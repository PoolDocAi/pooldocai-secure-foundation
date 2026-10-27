import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
import {addLegalFooter,legalFooterNav,legalLinks} from '../scripts/footer-navigation.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const read=p=>readFileSync(resolve(root,p),'utf8');
test('three owner-approved links and direct email contact are unambiguous',()=>{
 assert.deepEqual(legalLinks,[
  {label:'Privacy Policy',href:'/privacy.html'},
  {label:'Terms of Service',href:'/terms.html'},
  {label:'Contact',href:'mailto:hello@pooldocai.com'}
 ]);
 const nav=legalFooterNav();
 assert.match(nav,/aria-label="Legal and contact"/);
 assert.match(nav,/href="mailto:hello@pooldocai.com">Contact<\/a>/);
});
test('marketing homepage preserves its one existing Resources link and privacy consent button',()=>{
 const original=read('index.html'),html=addLegalFooter(original);
 assert.ok(html.includes('<button class="privacy-link" id="privacy-button"'));
 assert.equal((html.match(/class="footer-resources"/g)||[]).length,1);
 assert.equal((html.match(/href="\/resources\/"/g)||[]).length,1);
 assert.ok(html.includes('href="/privacy.html"'));
 assert.ok(html.includes('href="/terms.html"'));
 assert.ok(html.includes('href="mailto:hello@pooldocai.com"'));
 assert.equal((html.match(/class="pd-legal-footer-links"/g)||[]).length,1);
 assert.equal(addLegalFooter(html),html,'footer enhancement must be idempotent');
 assert.ok(html.includes('<link rel="stylesheet" href="/legal-footer.css">'));
});
test('both approved published article snapshots get links without changing their canonical article URLs',()=>{
 for(const slug of ['green-pool-first-checks','pool-pump-wont-start']){
  const original=read('review-pages/'+slug+'/index.html'),html=addLegalFooter(original);
  assert.match(html,new RegExp('https://pooldocai.com/resources/'+slug+'/'));
  assert.ok(html.includes('mailto:hello@pooldocai.com'));
  assert.ok(html.includes('All resources'));
 }
});
test('public Resources Hub template links to real documents and preserves Privacy choices',()=>{
 const catalog=read('src/platform/catalog.mjs');
 for(const token of ['/privacy.html','/terms.html','mailto:hello@pooldocai.com','/#privacy-details','/legal-footer.css'])assert.ok(catalog.includes(token),token);
 assert.ok(!catalog.includes('<p>For the people behind better pools.</p>'),'removed homepage tagline must stay gone');
});
test('preview build includes legal pages, stylesheet and footer injection on homepage + articles',()=>{
 const build=read('scripts/build-review.mjs');
 for(const expected of ["'privacy.html'","'terms.html'","'legal-footer.css'","addLegalFooter(readFileSync('public/index.html'","addLegalFooter(html)"])assert.ok(build.includes(expected),expected);
 assert.match(build,/VERCEL_ENV.*!==.*preview/,'review build must refuse Production');
});
test('legal pages remain expressly drafts and do not link to nonexistent waitlist file',()=>{
 for(const page of ['privacy.html','terms.html']){
  const html=read(page);
  assert.match(html,/Draft — formal legal review required/i);
  assert.ok(html.includes('mailto:hello@pooldocai.com'));
  assert.ok(!html.includes('href="/waitlist.html"'));
  assert.ok(html.includes('href="/privacy.html"'));
  assert.ok(html.includes('href="/terms.html"'));
 }
});
