import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const admin = readFileSync(new URL('../public/admin.html',import.meta.url),'utf8');

test('private owner Studio View Resources Hub opens the actual live public Hub',()=>{
  const links=[...admin.matchAll(/<a\b([^>]*?)>\s*View Resources Hub\s*↗?\s*<\/a>/g)];
  assert.equal(links.length,1,'Exactly one View Resources Hub navigation link is required');
  assert.match(links[0][1],/href="https:\/\/pooldocai\.com\/resources\/"/);
  assert.match(links[0][1],/target="_blank"/);
  assert.match(links[0][1],/rel="[^"]*noopener[^"]*noreferrer[^"]*"/);
  assert.doesNotMatch(links[0][1],/href="\/resources\/"/);
});

test('admin Hub navigation does not point to staging CMS or unpublished drafts',()=>{
  assert.equal((admin.match(/View Resources Hub/g)||[]).length,1);
  assert.doesNotMatch(admin,/href="https:\/\/[^"]*\.supabase\.co\/resources\//i);
  assert.doesNotMatch(admin,/href="\/preview\//i);
});
