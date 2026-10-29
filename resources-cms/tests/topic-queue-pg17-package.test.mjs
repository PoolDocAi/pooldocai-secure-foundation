import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assemblePg17TopicQueueSql} from '../scripts/topic-queue-pg17-review.mjs';

const source=readFileSync(new URL('../security/staging-topic-queue-candidate.sql',import.meta.url),'utf8');
const sql=assemblePg17TopicQueueSql(source);
const at=value=>sql.indexOf(value);
test('review-only PG17 package preserves candidate DDL in a single transaction',()=>{
 assert.match(sql,/^-- REVIEW ONLY, NOT AN APPROVED MIGRATION/);
 assert.equal((sql.match(/^BEGIN;$/gm)||[]).length,1);
 assert.equal((sql.match(/^COMMIT;$/gm)||[]).length,1);
 assert(at('BEGIN;')<at('DO $topic_preflight$'));
 assert(at('DO $topic_preflight$')<at('CREATE TABLE resources_cms.topic_queue'));
 assert(at('GRANT CREATE ON SCHEMA resources_cms TO resources_cms_command_owner')<at('ALTER FUNCTION resources_cms.topic_queue_list() OWNER'));
 assert(at('ALTER FUNCTION resources_cms.topic_queue_command(text,uuid,integer,jsonb) OWNER')<at('REVOKE CREATE ON SCHEMA resources_cms'));
 assert(at('REVOKE resources_cms_command_owner FROM postgres GRANTED BY postgres RESTRICT')<at('DO $topic_postflight$'));
 assert(at('DO $topic_postflight$')<sql.lastIndexOf('COMMIT;'));
 assert(sql.includes(source.slice(source.indexOf('CREATE TABLE resources_cms.topic_queue'),source.indexOf('COMMIT;'))),
   'source candidate DDL must be preserved byte-for-byte');
 assert.match(sql,/Weekly care of your pool/);
 assert.doesNotMatch(sql,/ALTER TABLE resources_cms\.articles|DROP TABLE|TRUNCATE TABLE|UPDATE resources_cms\.articles/i);
});
test('PG17 role preflight checks managed grantor, non-superuser and no broad membership',()=>{
 assert.match(sql,/current_user<>'postgres'/);
 assert.match(sql,/current_setting\('server_version_num'\)::int<170000/);
 assert.match(sql,/g\.rolname='supabase_admin' AND a\.admin_option/);
 assert.match(sql,/pg_has_role\('postgres','resources_cms_command_owner','SET'\)/);
 assert.match(sql,/rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls/);
 assert.match(sql,/to_regclass\('resources_cms\.topic_queue'\) IS NOT NULL/);
 assert.match(sql,/has_schema_privilege\('resources_cms_command_owner','resources_cms','CREATE'\)/);
});
test('temporary privileges are grantor-scoped, revoked, verified; queue remains private',()=>{
 assert.match(sql,/GRANT resources_cms_command_owner TO postgres\s+WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres/);
 assert.match(sql,/GRANT CREATE ON SCHEMA resources_cms TO resources_cms_command_owner/);
 assert.match(sql,/REVOKE CREATE ON SCHEMA resources_cms FROM resources_cms_command_owner/);
 assert.match(sql,/REVOKE resources_cms_command_owner FROM postgres GRANTED BY postgres RESTRICT/);
 assert.match(sql,/'resources_cms\.topic_queue_list\(\)'::regprocedure/);
 assert.match(sql,/c\.relrowsecurity/);
 assert.match(sql,/has_table_privilege\('anon',c\.oid/);
 assert.match(sql,/has_table_privilege\('authenticated',c\.oid/);
 assert.match(sql,/has_function_privilege\('anon','resources_cms\.topic_queue_list\(\)','EXECUTE'\)/);
 assert.match(sql,/NOT has_function_privilege\('authenticated','resources_cms\.topic_queue_list\(\)','EXECUTE'\)/);
 assert.match(sql,/count\(\*\) FROM resources_cms\.topic_queue\)<>8/);
});
test('packaging rejects changed or incomplete source instead of silently upgrading',()=>{
 assert.throws(()=>assemblePg17TopicQueueSql(''),/Unreviewed/);
 assert.throws(()=>assemblePg17TopicQueueSql(source.replace('ALTER FUNCTION resources_cms.topic_queue_list() OWNER TO resources_cms_command_owner;','')), /Unreviewed/);
 assert.throws(()=>assemblePg17TopicQueueSql(source.replace('COMMIT;','')), /Unreviewed/);
 assert.throws(()=>assemblePg17TopicQueueSql(source+'COMMIT;'),/Unreviewed/);
});
