import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const editor = readFileSync(new URL('../public/admin.js', import.meta.url), 'utf8');
const begin = editor.indexOf('async function verifyPublishedDelivery(');
const end = editor.indexOf('async function requestOwnerPublication(', begin);
assert.ok(begin >= 0 && end > begin, 'Reachability check must be wired to the owner editor');
const source = editor.slice(begin, end);

function checker(fetchImpl) {
  return runInNewContext(source + '\nverifyPublishedDelivery;', { fetch: fetchImpl });
}
const route = '/resources/new-article-2026/';
const title = 'New test article';
function htmlResponse(html, status=200, type='text/html; charset=utf-8') {
  return {
    status,
    headers: { get: key => key.toLowerCase() === 'content-type' ? type : null },
    text: async () => html,
  };
}

test('checks the actual same-origin GET URL without caches or cross-origin redirects', async () => {
  let observed;
  const fn = checker(async (url, options) => {
    observed = {url,options};
    return htmlResponse('<title>New test article</title><link rel="canonical" href="https://pooldocai.com/resources/new-article-2026/">');
  });
  const result = await fn('new-article-2026',title);
  assert.equal(result.ok,true);
  assert.equal(result.path,route);
  assert.equal(observed.url,route);
  assert.equal(observed.options.cache,'no-store');
  assert.equal(observed.options.redirect,'manual');
  assert.equal(observed.options.credentials,'same-origin');
  assert.equal(observed.options.method,'GET');
});

test('flags Vercel 404 instead of falsely reporting publication complete', async () => {
  const result = await checker(async () => htmlResponse('',404))('new-article-2026',title);
  assert.equal(result.ok,false);
  assert.match(result.reason,/HTTP 404/);
});

test('does not confuse HTML login page or static fallback with the article', async () => {
  const check = checker(async () => htmlResponse('<html><title>Login</title></html>'));
  assert.equal((await check('new-article-2026',title)).ok,false);
  const wrongTitle = checker(async () => htmlResponse('<link href="https://pooldocai.com/resources/new-article-2026/"><h1>Unrelated content</h1>'));
  assert.equal((await wrongTitle('new-article-2026',title)).ok,false);
});

test('rejects wrong content type, network failure and malformed slugs', async () => {
  assert.equal((await checker(async () => htmlResponse('{"ok":true}',200,'application/json'))('new-article-2026',title)).ok,false);
  assert.equal((await checker(async () => {throw Error('offline')})('new-article-2026',title)).ok,false);
  let called=false;
  const invalid=await checker(async () => {called=true;return htmlResponse('');})('../admin/',title);
  assert.equal(invalid.ok,false);
  assert.equal(called,false);
});

test('owner confirmation flow surfaces routing failure distinctly from database publication', () => {
  const publishBlock = editor.slice(end, editor.indexOf('async function pickMedia',end));
  assert.match(publishBlock,/await verifyPublishedDelivery\(published\.data\?\.slug, published\.data\?\.title\)/);
  assert.match(publishBlock,/website reachability FAILED/);
  assert.match(publishBlock,/Authorize revision and publish/);
});
