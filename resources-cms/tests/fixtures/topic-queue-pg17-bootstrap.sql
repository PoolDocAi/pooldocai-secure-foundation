-- Disposable PostgreSQL 17 fixture ONLY. Never execute against hosted Supabase.
\set ON_ERROR_STOP on
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE resources_cms_runtime NOLOGIN NOINHERIT;
CREATE ROLE authenticator LOGIN PASSWORD 'synthetic-auth-only' NOINHERIT;
GRANT authenticated, anon TO authenticator WITH SET TRUE, INHERIT FALSE;
CREATE ROLE postgres LOGIN PASSWORD 'synthetic-executor-only' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE supabase_admin CREATEROLE NOLOGIN;
SET ROLE supabase_admin;
CREATE ROLE resources_cms_command_owner NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
GRANT resources_cms_command_owner TO postgres
 WITH ADMIN TRUE, INHERIT FALSE, SET FALSE GRANTED BY supabase_admin;
RESET ROLE;
CREATE SCHEMA resources_cms AUTHORIZATION postgres;
SET ROLE postgres;
CREATE TABLE resources_cms.articles (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), state text NOT NULL
);
CREATE TABLE resources_cms.members (
 user_id uuid PRIMARY KEY, role text NOT NULL, active boolean NOT NULL DEFAULT true
);
CREATE TABLE resources_cms.editorial_holds(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
INSERT INTO resources_cms.articles(state)
 SELECT 'draft' FROM generate_series(1,35);
INSERT INTO resources_cms.editorial_holds
 SELECT gen_random_uuid() FROM generate_series(1,32);
INSERT INTO resources_cms.members(user_id,role,active) VALUES
 ('00000000-0000-4000-8000-000000000001','owner',true),
 ('00000000-0000-4000-8000-000000000002','viewer',true),
 ('00000000-0000-4000-8000-000000000003','owner',false);
CREATE FUNCTION resources_cms.actor() RETURNS uuid
 LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $actor$
 SELECT CASE WHEN session_user='authenticator' AND
   claims->>'role'='authenticated'
 THEN nullif(claims->>'sub','')::uuid ELSE NULL::uuid END
 FROM (SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb claims) ctx
 $actor$;
CREATE FUNCTION resources_cms.has_role(roles text[]) RETURNS boolean
 LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $role$
 SELECT EXISTS(SELECT 1 FROM resources_cms.members
    WHERE user_id=resources_cms.actor() AND active AND role=ANY(roles))
 $role$;
RESET ROLE;
GRANT USAGE ON SCHEMA resources_cms TO anon,authenticated,resources_cms_command_owner;
GRANT SELECT ON resources_cms.articles,resources_cms.members TO resources_cms_command_owner;
GRANT EXECUTE ON FUNCTION resources_cms.actor(),resources_cms.has_role(text[])
 TO resources_cms_command_owner;
