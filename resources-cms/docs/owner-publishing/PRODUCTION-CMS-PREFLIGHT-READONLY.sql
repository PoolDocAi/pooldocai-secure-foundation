-- PoolDocAI CMS Production preflight. READ ONLY. No DDL or data changes.
-- Target only the existing PoolDocAI Complete Supabase project,
-- owfeebydlyacssqpnmkq. Do not run on Staging and do not assume authorization.
select current_database() database_name,current_user, current_setting('server_version') postgres_version,
  to_regnamespace('resources_cms')::text as cms_schema,
  to_regrole('resources_cms_runtime')::text as cms_runtime_role,
  to_regrole('resources_cms_command_owner')::text as cms_command_owner_role,
  to_regclass('public.company_members')::text as existing_company_members;

-- Guarded release cannot proceed if CMS schema or its roles already exist,
-- unless separately reconciled with another owner-approved installation.
select n.nspname as existing_schema from pg_namespace n
where n.nspname = 'resources_cms';
select rolname,rolcanlogin,rolbypassrls,rolsuper from pg_roles
where rolname in('resources_cms_runtime','resources_cms_command_owner');
select (select count(*) from public.company_members) as existing_company_members_rows,
 (select count(*) from auth.users) as production_auth_user_count,
 (select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE') as public_table_count,
 (select count(*) from supabase_migrations.schema_migrations) as recorded_migrations;

-- Read-only security checks. Interpret each notice; existing core app warnings
-- are not a reason to weaken RPC grants or bypass RLS.
select p.proname,p.prosecdef,n.nspname
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='resources_cms' order by p.proname;

-- Follow these non-SQL checks separately before installation:
-- [ ] Recoverable database backup/snapshot verified
-- [ ] Exact Production CMS owner account created and email verified in Prod Auth
-- [ ] Production-specific migration reviewed: no Staging account UUID or
--     recorded-migration count; owner_release_policy.destination = 'production'
-- [ ] Explicit Data API custom schema resources_cms exposed (RPC EXECUTE only;
--     grant no direct table access to anon/authenticated)
-- [ ] Private 34-record checksum-verified import catalog available server-side;
--     32 approved+2 historical, no draft/asset bypass
-- [ ] Existing two historical published revisions exported and verified
-- [ ] No CMS owner membership seeded by copying a Staging Auth UUID
-- [ ] Separate owner authorization before public deployment or publication
