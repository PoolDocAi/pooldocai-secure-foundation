import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerProductionProposal } from '../scripts/owner-production-proposal.mjs';

test('Production owner migration is an explicitly disabled initial release', () => {
  const sql=ownerProductionProposal();
  assert.ok(sql.startsWith('-- PRODUCTION REVIEW CANDIDATE'));
  assert.match(sql,/INSERT INTO resources_cms\.owner_release_policy VALUES\(true,'production',false\)/);
  assert.doesNotMatch(sql,/VALUES\(true,'staging',true\)/);
  assert.doesNotMatch(sql,/4ab7d56e-57f4-4aed-9244-26ee801afab2/);
  assert.doesNotMatch(sql,/schema_migrations\)<>46/);
  assert.ok(sql.trimEnd().endsWith('COMMIT;'));
});

test('Production owner migration assembles every private-import and rights dependency', () => {
  const sql=ownerProductionProposal();
  for (const part of [
    'CREATE FUNCTION resources_cms.safe_public_html(',
    'CREATE FUNCTION resources_cms.owner_import(',
    'CREATE FUNCTION resources_cms.media_release_ready(',
    'CREATE FUNCTION resources_cms.owner_publish(',
    'CREATE FUNCTION resources_cms.guard_revision_body(',
    'CREATE TABLE resources_cms.approved_import_allowlist(',
    'CREATE TABLE resources_cms.owner_import_sources(',
    'CREATE TABLE resources_cms.media_rights_reviews(',
  ]) assert.ok(sql.includes(part), 'missing '+part);
  assert.ok(sql.indexOf('CREATE FUNCTION resources_cms.safe_public_html(') <
    sql.indexOf('CREATE FUNCTION resources_cms.guard_revision_body('));
  assert.ok(sql.indexOf('CREATE FUNCTION resources_cms.media_release_ready(') <
    sql.indexOf('CREATE FUNCTION resources_cms.owner_publish('));
});

test('Production SQL changes role only at expected ownership boundaries', () => {
  const sql=ownerProductionProposal();
  assert.doesNotMatch(sql,/\bRESET ROLE;\s+RESET ROLE;/i);
  assert.doesNotMatch(sql,/\bSET ROLE resources_cms_command_owner;\s+SET ROLE resources_cms_command_owner;/i);
  assert.ok(sql.indexOf('CREATE TABLE resources_cms.approved_import_allowlist(') > sql.indexOf('RESET ROLE;'));
  assert.ok(sql.indexOf('CREATE FUNCTION resources_cms.owner_import(') > sql.indexOf('CREATE TABLE resources_cms.owner_import_sources('));
  assert.equal((sql.match(/\bBEGIN;/g)||[]).length,1);
  assert.equal((sql.match(/\bCOMMIT;/g)||[]).length,1);
});

test('Production owner authorization requires an existing verified active Auth user and empty CMS baseline', () => {
  const sql=ownerProductionProposal();
  assert.match(sql,/JOIN auth\.users u ON u\.id=m\.user_id/);
  assert.match(sql,/u\.email_confirmed_at IS NOT NULL/);
  assert.match(sql,/u\.deleted_at IS NULL/);
  assert.match(sql,/count\(\*\) FROM resources_cms\.articles\)<>0/);
  assert.match(sql,/GRANT resources_cms_command_owner TO postgres/);
  assert.match(sql,/REVOKE resources_cms_command_owner FROM postgres GRANTED BY postgres RESTRICT/);
  assert.match(sql,/CREATE OR REPLACE FUNCTION resources_cms\.public_article/);
});
