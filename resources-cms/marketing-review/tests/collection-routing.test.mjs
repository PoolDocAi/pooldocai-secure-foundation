import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, resolve} from 'node:path';
import {publicNavigation} from '../src/platform/navigation.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'));
const navigation = JSON.parse(readFileSync(resolve(root, 'review-navigation.json'), 'utf8'));
const catalog = JSON.parse(readFileSync(resolve(root, 'live-catalog.json'), 'utf8'));
const route = config.rewrites[0];
const pattern = new RegExp(route.source);
const publicFolders = publicNavigation(navigation, catalog).folders;

test('trailing-slash rule is narrowly scoped and precedes slashless rule', () => {
  assert.equal(route.destination, '/api/review?__path=/resources/collections/$1/');
  assert.equal(config.rewrites[1].source, '/resources/collections/:path*');
  assert.equal(config.trailingSlash, undefined);
});

test('canonical live collection folders match the rewrite exactly', () => {
  assert.ok(publicFolders.length > 0);
  for (const folder of publicFolders) {
    const match = pattern.exec(folder.url);
    assert.ok(match, folder.url);
    assert.equal(route.destination.replace('$1', match[1]), '/api/review?__path=' + folder.url);
    assert.equal(pattern.test(folder.url.slice(0, -1)), false);
  }
});

test('homepage, articles, APIs, and malformed collection URLs remain outside new rule', () => {
  for (const pathname of [
    '/', '/resources/', '/resources/pool-pump-wont-start/',
    '/resources/green-pool-first-checks/', '/api/public/resources',
    '/resources/collections/', '/resources/collections/../',
    '/resources/collections/foo/%2f/'
  ]) assert.equal(pattern.test(pathname), false, pathname);
});

test('server retains published-only folder lookup and trailing-slash normalization', () => {
  const source = readFileSync(resolve(root, 'api/review.mjs'), 'utf8');
  assert.ok(source.includes("path.startsWith('/resources/collections/')"));
  assert.ok(source.includes('normalizedPath'));
  assert.ok(source.includes('nav.folders.find(f=>f.url===normalizedPath)'));
  assert.ok(source.includes('if(!folder)return send(404'));
});
