-- REVIEW ONLY, NOT A DEPLOYABLE MIGRATION. Never run against Production.
-- Requires Scout-bound preflight digest; exact PG17 guarded role transfer below.
-- No activation: enforcement starts OFF. Terminal ROLLBACK is intentional.
BEGIN;
-- Transaction-native snapshot supports exact rollback, including NULL ACLs and
-- original grantors/OIDs. Snapshot is created BEFORE the candidate savepoint.
CREATE FUNCTION pg_temp.mfa_snapshot() RETURNS jsonb LANGUAGE sql AS $snapshot$
 SELECT jsonb_build_object(
 'schemas',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.nspname) FROM
   (SELECT nspname,nspowner,nspacl FROM pg_namespace WHERE nspname IN ('auth','resources_cms','storage')) x),
 'auth_acl',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.oid) FROM
   (SELECT c.oid,c.relowner,c.relacl,(SELECT jsonb_agg(jsonb_build_array(a.attnum,a.attacl) ORDER BY a.attnum)
    FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='auth') x),
 'functions',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.oid) FROM
   (SELECT p.oid,p.proowner,p.proacl,pg_get_functiondef(p.oid) AS definition FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='resources_cms') x),
 'memberships',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.roleid,x.member,x.grantor) FROM pg_auth_members x),
 'policies',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.oid) FROM pg_policy x
    JOIN pg_class c ON c.oid=x.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('resources_cms','storage')),
 'storage_relation',(SELECT to_jsonb(r) FROM (SELECT relowner,relacl,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='storage.objects'::regclass) r),
 'storage_policies',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.oid) FROM pg_policy x WHERE x.polrelid='storage.objects'::regclass),
 'cms_tables',(SELECT jsonb_agg(to_jsonb(x) ORDER BY x.oid) FROM
   (SELECT c.oid,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='resources_cms' AND c.relkind IN ('r','p')) x)
 )
$snapshot$;
CREATE TEMP TABLE mfa_start_state ON COMMIT DROP AS SELECT pg_temp.mfa_snapshot() AS state;
SAVEPOINT mfa_candidate_start;
DO $storage_contract$ DECLARE v_storage_result record; BEGIN
 SELECT * INTO v_storage_result FROM (
-- READ-ONLY V3 policy composition contract. No Storage DDL.
-- Compare full parsed expressions (whitespace only normalized); no substring
-- matching that could overlook an OR bypass. Unexpected CMS policies fail.
WITH expected(name,cmd,permissive,roles,qual,check_expr) AS (VALUES
('resources_cms_boundary_select','r',false,ARRAY['anon'::regrole::oid,'authenticated'::regrole::oid]::oid[],'((bucket_id <> ''resources-cms-media''::text) OR resources_cms.owner_storage_member(ARRAY[''owner''::text, ''editor''::text, ''reviewer''::text, ''viewer''::text]))',NULL),
('resources_cms_media_member_select','r',true,ARRAY['authenticated'::regrole::oid]::oid[],'((bucket_id = ''resources-cms-media''::text) AND resources_cms.owner_storage_member(ARRAY[''owner''::text, ''editor''::text, ''reviewer''::text, ''viewer''::text]))',NULL),
('resources_cms_boundary_insert','a',false,ARRAY['anon'::regrole::oid,'authenticated'::regrole::oid]::oid[],NULL,'((bucket_id <> ''resources-cms-media''::text) OR ((owner_id = (auth.uid())::text) AND resources_cms.owner_storage_orphan_object(name)))'),
('resources_cms_media_insert','a',true,ARRAY['authenticated'::regrole::oid]::oid[],NULL,'((bucket_id = ''resources-cms-media''::text) AND (owner_id = (auth.uid())::text) AND resources_cms.owner_storage_orphan_object(name))'),
('resources_cms_boundary_delete','d',false,ARRAY['anon'::regrole::oid,'authenticated'::regrole::oid]::oid[],'((bucket_id <> ''resources-cms-media''::text) OR ((owner_id = (auth.uid())::text) AND resources_cms.owner_storage_orphan_object(name)))',NULL),
('resources_cms_media_delete','d',true,ARRAY['authenticated'::regrole::oid]::oid[],'((bucket_id = ''resources-cms-media''::text) AND (owner_id = (auth.uid())::text) AND resources_cms.owner_storage_orphan_object(name))',NULL),
('resources_cms_boundary_update','w',false,ARRAY['anon'::regrole::oid,'authenticated'::regrole::oid]::oid[],'(bucket_id <> ''resources-cms-media''::text)','(bucket_id <> ''resources-cms-media''::text)')), actual AS (
 SELECT p.polname::text name,p.polcmd::text cmd,p.polpermissive permissive,
 p.polroles roles,pg_get_expr(p.polqual,p.polrelid) qual,pg_get_expr(p.polwithcheck,p.polrelid) check_expr
 FROM pg_policy p WHERE p.polrelid='storage.objects'::regclass
), checks AS (
 SELECT e.name, coalesce(a.cmd=e.cmd AND a.permissive=e.permissive AND a.roles=e.roles
 AND regexp_replace(coalesce(a.qual,''),'\s','','g')=regexp_replace(coalesce(e.qual,''),'\s','','g')
 AND regexp_replace(coalesce(a.check_expr,''),'\s','','g')=regexp_replace(coalesce(e.check_expr,''),'\s','','g'),false) valid
 FROM expected e LEFT JOIN actual a USING(name)
 UNION ALL SELECT 'no_unexpected_cms_policy',NOT EXISTS(
 SELECT 1 FROM actual a WHERE a.name NOT IN (SELECT name FROM expected)
 AND (coalesce(a.qual,'')||coalesce(a.check_expr,'')) ~ '(resources-cms-media|owner_storage_)')
 UNION ALL SELECT 'storage_rls',(SELECT relrowsecurity FROM pg_class WHERE oid='storage.objects'::regclass)
 UNION ALL SELECT 'helper_owner_definer',count(*)=2 AND bool_and(p.proowner='resources_cms_command_owner'::regrole AND p.prosecdef)
 FROM pg_proc p WHERE p.oid IN ('resources_cms.owner_storage_member(text[])'::regprocedure,'resources_cms.owner_storage_orphan_object(text)'::regprocedure)
 UNION ALL SELECT 'helper_api_acl',
 has_function_privilege('authenticated','resources_cms.owner_storage_member(text[])','EXECUTE')
 AND has_function_privilege('anon','resources_cms.owner_storage_member(text[])','EXECUTE')
 AND has_function_privilege('authenticated','resources_cms.owner_storage_orphan_object(text)','EXECUTE')
 AND NOT has_function_privilege('anon','resources_cms.owner_storage_orphan_object(text)','EXECUTE')
 UNION ALL SELECT 'helper_no_public_execute',NOT EXISTS(
 SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 WHERE p.oid IN ('resources_cms.owner_storage_member(text[])'::regprocedure,'resources_cms.owner_storage_orphan_object(text)'::regprocedure)
 AND a.grantee=0 AND a.privilege_type='EXECUTE')
), inventory AS (
 SELECT encode(sha256(convert_to(coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.polname)::text,'[]'),'UTF8')),'hex') digest
 FROM pg_policy p WHERE p.polrelid='storage.objects'::regclass
)
SELECT bool_and(coalesce(c.valid,false)) AS composition_valid,
 (SELECT digest FROM inventory) AS inventory_digest,
 (SELECT digest FROM inventory)=nullif(current_setting('resources_cms.review_storage_policy_digest',true),'') AS digest_bound,
 jsonb_object_agg(c.name,c.valid) AS checks FROM checks c
) contract;
 IF v_storage_result.composition_valid IS DISTINCT FROM true OR v_storage_result.digest_bound IS DISTINCT FROM true THEN RAISE EXCEPTION 'Storage helper policy composition/digest drift'; END IF;
END $storage_contract$;
DO $guard$ BEGIN
 IF current_user<>'postgres' OR (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN
   RAISE EXCEPTION 'Expected hosted non-superuser postgres executor'; END IF;
 IF (SELECT count(*) FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member JOIN pg_roles g ON g.oid=a.grantor
   WHERE r.rolname='resources_cms_command_owner' AND m.rolname='postgres' AND g.rolname='supabase_admin'
   AND a.admin_option AND NOT a.inherit_option AND NOT a.set_option)<>1 THEN RAISE EXCEPTION 'Managed membership mismatch'; END IF;
 IF pg_has_role('postgres','resources_cms_command_owner','SET') OR pg_has_role('postgres','resources_cms_command_owner','USAGE')
   OR has_schema_privilege('resources_cms_command_owner','resources_cms','CREATE')
   OR has_schema_privilege('resources_cms_command_owner','auth','USAGE') THEN RAISE EXCEPTION 'Unexpected starting privilege'; END IF;
 IF NOT has_schema_privilege('postgres','resources_cms','CREATE') OR NOT has_schema_privilege('postgres','auth','USAGE')
   OR NOT has_function_privilege('postgres','auth.jwt()','EXECUTE') OR NOT has_function_privilege('postgres','auth.uid()','EXECUTE') THEN
   RAISE EXCEPTION 'Reader/executor missing existing privileges; no grant bypass'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='resources_cms_command_owner' AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit)) THEN
   RAISE EXCEPTION 'Unsafe command-owner role'; END IF;
 IF (SELECT proowner FROM pg_proc WHERE oid='resources_cms.actor()'::regprocedure)<> 'postgres'::regrole THEN RAISE EXCEPTION 'Actor owner drift'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc WHERE oid IN ('resources_cms.owner_storage_member(text[])'::regprocedure,
   'resources_cms.owner_storage_orphan_object(text)'::regprocedure) AND proowner<>'resources_cms_command_owner'::regrole) THEN
   RAISE EXCEPTION 'Storage helper owner drift'; END IF;
 IF NOT has_column_privilege('postgres','auth.sessions','id','SELECT') OR NOT has_column_privilege('postgres','auth.sessions','user_id','SELECT')
   OR NOT has_column_privilege('postgres','auth.sessions','aal','SELECT') OR NOT has_column_privilege('postgres','auth.sessions','factor_id','SELECT')
   OR NOT has_column_privilege('postgres','auth.sessions','not_after','SELECT') OR NOT has_column_privilege('postgres','auth.mfa_factors','id','SELECT')
   OR NOT has_column_privilege('postgres','auth.mfa_factors','user_id','SELECT') OR NOT has_column_privilege('postgres','auth.mfa_factors','status','SELECT')
   OR NOT has_column_privilege('postgres','auth.mfa_factors','factor_type','SELECT') THEN RAISE EXCEPTION 'Auth read dependency missing'; END IF;
END $guard$;
-- Established PG17 procedure: a separate grantor-specific SET-only row.
GRANT resources_cms_command_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
GRANT CREATE ON SCHEMA resources_cms TO resources_cms_command_owner;
DO $guard$ BEGIN
 IF (SELECT count(*) FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member JOIN pg_roles g ON g.oid=a.grantor
   WHERE r.rolname='resources_cms_command_owner' AND m.rolname='postgres' AND g.rolname='postgres'
   AND NOT a.admin_option AND NOT a.inherit_option AND a.set_option)<>1
   OR NOT has_schema_privilege('resources_cms_command_owner','resources_cms','CREATE') THEN RAISE EXCEPTION 'Temporary privilege mismatch'; END IF;
END $guard$;
CREATE TABLE resources_cms.mfa_policy (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 require_aal2 boolean NOT NULL DEFAULT false
);
INSERT INTO resources_cms.mfa_policy VALUES (true,false);
ALTER TABLE resources_cms.mfa_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON resources_cms.mfa_policy FROM PUBLIC,anon,authenticated,resources_cms_runtime;
GRANT SELECT ON resources_cms.mfa_policy TO resources_cms_command_owner;
CREATE POLICY cms_mfa_policy_read ON resources_cms.mfa_policy FOR SELECT
 TO resources_cms_command_owner USING(true);
-- NO Auth schema/table/column grants. Reader functions stay postgres-owned,
-- using only postgres's existing USAGE/SELECT/EXECUTE privileges.
CREATE FUNCTION resources_cms.mfa_enforced() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT coalesce((SELECT require_aal2 FROM resources_cms.mfa_policy WHERE singleton),true)
$$;
-- Internal only. Never accepts target user/company or trusts user_metadata.
-- Storage uses managed auth.uid() because its session_user differs from REST.
CREATE FUNCTION resources_cms.mfa_identity(p_private boolean,p_storage boolean DEFAULT false) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE j jsonb:=auth.jwt(); u uuid; sid uuid;
BEGIN
 IF (NOT p_storage AND session_user<>'authenticator') OR j->>'role' IS DISTINCT FROM 'authenticated'
    OR coalesce((j->>'is_anonymous')::boolean,false) THEN RETURN NULL; END IF;
 u:=nullif(j->>'sub','')::uuid; sid:=nullif(j->>'session_id','')::uuid;
 IF u IS NULL OR sid IS NULL OR (p_storage AND auth.uid() IS DISTINCT FROM u)
    OR jsonb_typeof(j->'exp') IS DISTINCT FROM 'number'
    OR coalesce((j->>'exp')::numeric,0)<=extract(epoch FROM statement_timestamp()) THEN RETURN NULL; END IF;
 IF p_private THEN
   IF j->>'aal' IS DISTINCT FROM 'aal2' THEN RETURN NULL; END IF;
 ELSE
   IF j->>'aal' IS DISTINCT FROM 'aal1' OR jsonb_typeof(j->'iat') IS DISTINCT FROM 'number'
      OR coalesce((j->>'iat')::numeric,0)<extract(epoch FROM statement_timestamp())-300
      OR (j->>'iat')::numeric>extract(epoch FROM statement_timestamp())+30 THEN RETURN NULL; END IF;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM auth.sessions s WHERE s.id=sid AND s.user_id=u
   AND (s.not_after IS NULL OR s.not_after>statement_timestamp())
   AND (NOT p_private OR (s.aal::text='aal2' AND EXISTS(
     SELECT 1 FROM auth.mfa_factors f WHERE f.id=s.factor_id AND f.user_id=u
       AND f.status::text='verified' AND f.factor_type::text='totp')))) THEN RETURN NULL; END IF;
 RETURN u;
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN RETURN NULL;
END $$;
-- AAL1 can discover ONLY its own current CMS role for <=5 minutes after login.
-- No arguments, content, tokens, other members, Storage or mutation capability.
CREATE FUNCTION resources_cms.mfa_member_role() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE u uuid:=resources_cms.mfa_identity(false); r text;
BEGIN
 SELECT role INTO r FROM resources_cms.members WHERE user_id=u AND active;
 IF r IS NULL THEN RAISE EXCEPTION 'CMS membership denied' USING ERRCODE='42501'; END IF;
 RETURN r;
END $$;
CREATE FUNCTION resources_cms.mfa_private_role() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE u uuid:=resources_cms.mfa_identity(true); r text;
BEGIN
 -- Server enabled before database enforcement must fail closed.
 IF NOT resources_cms.mfa_enforced() THEN RAISE EXCEPTION 'MFA policy not ready' USING ERRCODE='42501'; END IF;
 SELECT role INTO r FROM resources_cms.members WHERE user_id=u AND active;
 IF r IS NULL THEN RAISE EXCEPTION 'CMS membership denied' USING ERRCODE='42501'; END IF;
 RETURN r;
END $$;
CREATE OR REPLACE FUNCTION resources_cms.actor() RETURNS uuid
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT CASE WHEN resources_cms.mfa_enforced() THEN resources_cms.mfa_identity(true)
 ELSE CASE WHEN session_user='authenticator' AND claims->>'role'='authenticated'
 THEN nullif(claims->>'sub','')::uuid ELSE NULL::uuid END END
 FROM (SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb AS claims) request_context
$$;
-- has_role() already derives identity through actor().
-- V3: Storage authorization uses the existing policies and corrected helpers.
-- No Storage table-owner privileges, new Storage policy or managed-role path.
-- Compatibility reader for gate-OFF Storage only: same self UID as the old
-- auth.uid() call, no target argument, no Auth table reads, no API EXECUTE.
CREATE FUNCTION resources_cms.mfa_storage_subject() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$ SELECT auth.uid() $$;
REVOKE ALL ON FUNCTION resources_cms.mfa_storage_subject() FROM PUBLIC,anon,authenticated,resources_cms_runtime;
GRANT EXECUTE ON FUNCTION resources_cms.mfa_storage_subject() TO resources_cms_command_owner;
SET LOCAL ROLE resources_cms_command_owner;
CREATE OR REPLACE FUNCTION resources_cms.owner_storage_member(p_roles text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT CASE WHEN resources_cms.mfa_enforced() THEN EXISTS(
   SELECT 1 FROM resources_cms.members WHERE user_id=resources_cms.mfa_identity(true,true) AND active AND role=ANY(p_roles))
 ELSE EXISTS(SELECT 1 FROM resources_cms.members WHERE user_id=resources_cms.mfa_storage_subject() AND active AND role=ANY(p_roles)) END
$$;
CREATE OR REPLACE FUNCTION resources_cms.owner_storage_orphan_object(p_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT CASE WHEN NOT resources_cms.owner_storage_member(ARRAY['owner','editor']) THEN false
 ELSE p_name ~ '^images/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$'
 AND NOT EXISTS(SELECT 1 FROM resources_cms.media WHERE object_key=p_name) END
$$;
SET LOCAL ROLE postgres;
ALTER FUNCTION resources_cms.mfa_enforced() OWNER TO resources_cms_command_owner;
-- mfa_identity intentionally remains owned by postgres (narrow Auth reader).
ALTER FUNCTION resources_cms.mfa_member_role() OWNER TO resources_cms_command_owner;
ALTER FUNCTION resources_cms.mfa_private_role() OWNER TO resources_cms_command_owner;
-- Each ACL is changed by its legal owner, not by assumed INHERIT rights.
REVOKE ALL ON FUNCTION resources_cms.mfa_identity(boolean,boolean) FROM PUBLIC,anon,authenticated,resources_cms_runtime;
GRANT EXECUTE ON FUNCTION resources_cms.mfa_identity(boolean,boolean) TO resources_cms_command_owner;
SET LOCAL ROLE resources_cms_command_owner;
REVOKE ALL ON FUNCTION resources_cms.mfa_enforced(),resources_cms.mfa_member_role(),
 resources_cms.mfa_private_role() FROM PUBLIC,anon,authenticated,resources_cms_runtime;
GRANT EXECUTE ON FUNCTION resources_cms.mfa_member_role(),resources_cms.mfa_private_role() TO authenticated;
SET LOCAL ROLE postgres;
-- Guaranteed normal-path cleanup before transaction end. Any earlier error
-- aborts this entire transaction (no exception swallowing, no intermediate commit).
REVOKE CREATE ON SCHEMA resources_cms FROM resources_cms_command_owner;
REVOKE resources_cms_command_owner FROM postgres GRANTED BY postgres RESTRICT;
DO $postflight$ BEGIN
 IF pg_has_role('postgres','resources_cms_command_owner','SET') OR pg_has_role('postgres','resources_cms_command_owner','USAGE')
   OR has_schema_privilege('resources_cms_command_owner','resources_cms','CREATE') THEN RAISE EXCEPTION 'Temporary privilege remains'; END IF;
 IF (pg_temp.mfa_snapshot()->'memberships') IS DISTINCT FROM (SELECT state->'memberships' FROM mfa_start_state)
   OR (pg_temp.mfa_snapshot()->'schemas') IS DISTINCT FROM (SELECT state->'schemas' FROM mfa_start_state)
   OR (pg_temp.mfa_snapshot()->'storage_relation') IS DISTINCT FROM (SELECT state->'storage_relation' FROM mfa_start_state)
   OR (pg_temp.mfa_snapshot()->'storage_policies') IS DISTINCT FROM (SELECT state->'storage_policies' FROM mfa_start_state)
   OR (pg_temp.mfa_snapshot()->'auth_acl') IS DISTINCT FROM (SELECT state->'auth_acl' FROM mfa_start_state) THEN
   RAISE EXCEPTION 'Membership/schema/Auth ACL residue'; END IF;
 IF (SELECT count(*) FROM pg_proc WHERE oid IN ('resources_cms.mfa_identity(boolean,boolean)'::regprocedure,
   'resources_cms.mfa_storage_subject()'::regprocedure) AND proowner='postgres'::regrole)<>2
   OR has_function_privilege('authenticated','resources_cms.mfa_identity(boolean,boolean)','EXECUTE')
   OR has_function_privilege('authenticated','resources_cms.mfa_storage_subject()','EXECUTE')
   OR has_schema_privilege('resources_cms_command_owner','auth','USAGE') THEN RAISE EXCEPTION 'Reader capability boundary mismatch'; END IF;
 IF (SELECT require_aal2 FROM resources_cms.mfa_policy WHERE singleton) IS DISTINCT FROM false THEN RAISE EXCEPTION 'Enforcement activated'; END IF;
END $postflight$;
ROLLBACK;
