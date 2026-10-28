-- PoolDocAI CMS: independently observed core Production baseline.
-- Captured 2026-10-27 UTC from owfeebydlyacssqpnmkq.
-- READ-ONLY. Re-run after any reviewed CMS installation to detect accidental
-- changes to existing PUBLIC application schema, RLS and API role grants.
-- No raw customer records, JWTs, owner email, credentials or passwords included.
-- A FAIL can also indicate a separately authorized concurrent core release:
-- inspect differences; never automatically revert or overwrite unrelated work.
WITH
tables AS (
 SELECT format('%I.%I|%s|%s|%s',n.nspname,c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity) item
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind IN ('r','p')
),
columns AS (
 SELECT format('%I.%I.%I:%s:%s',n.nspname,c.relname,a.attname,a.atttypid::regtype,a.attnotnull) item
 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
 JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relkind IN ('r','p')
   AND a.attnum>0 AND NOT a.attisdropped
),
policies AS (
 SELECT format('%I.%I|%s|%s|%s',schemaname,tablename,policyname,cmd,roles) item
 FROM pg_policies WHERE schemaname='public'
),
funcs AS (
 SELECT n.nspname||'.'||p.oid::regprocedure::text||'|'||
  encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') item
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public'
),
api_grants AS (
 SELECT format('%s|%s|%s',grantee,table_schema||'.'||table_name,privilege_type) item
 FROM information_schema.role_table_grants
 WHERE table_schema='public' AND grantee IN ('anon','authenticated','service_role')
 UNION ALL
 SELECT format('%s|%s|%s',grantee,routine_schema||'.'||routine_name,privilege_type) item
 FROM information_schema.role_routine_grants
 WHERE routine_schema='public' AND grantee IN ('anon','authenticated','service_role')
),
actual AS (
 SELECT
  (SELECT count(*) FROM tables) table_count,
  (SELECT count(*) FROM policies) policy_count,
  (SELECT count(*) FROM funcs) function_count,
  (SELECT count(*) FROM api_grants) grant_count,
  (SELECT encode(sha256(convert_to(string_agg(item,E'\n' ORDER BY item),'UTF8')),'hex') FROM tables) tables_hash,
  (SELECT encode(sha256(convert_to(string_agg(item,E'\n' ORDER BY item),'UTF8')),'hex') FROM columns) columns_hash,
  (SELECT encode(sha256(convert_to(string_agg(item,E'\n' ORDER BY item),'UTF8')),'hex') FROM policies) policies_hash,
  (SELECT encode(sha256(convert_to(string_agg(item,E'\n' ORDER BY item),'UTF8')),'hex') FROM funcs) funcs_hash,
  (SELECT encode(sha256(convert_to(string_agg(item,E'\n' ORDER BY item),'UTF8')),'hex') FROM api_grants) grants_hash
)
SELECT
 table_count=44 AS unchanged_public_table_count,
 policy_count=63 AS unchanged_rls_policy_count,
 function_count=42 AS unchanged_core_function_count,
 grant_count=326 AS unchanged_api_grant_count,
 tables_hash='72afcbe7f57ef5ffcf7053fd93ee9ad5b26b98cb7d2773448cbbe99327f2b4e8' AS unchanged_public_table_metadata,
 columns_hash='f5771186fac83ea9eb520add44d052aafdb6d638264883d8e5348e9b5e05fd1d' AS unchanged_public_columns,
 policies_hash='72875c860d488d8a90b893c6b0543d088a7490ca07281e5c9b5a50b05c05635b' AS unchanged_core_rls_policies,
 funcs_hash='86314f272629696c43e29ff23bfe6f01b89cc073a3ad5454d11e6a54844b4c0a' AS unchanged_core_functions,
 grants_hash='2e54cb1c57688340b24e959c7545a9e87d9a3d3f336bb452c10d39219ed9a07b' AS unchanged_api_table_and_routine_grants
FROM actual;
