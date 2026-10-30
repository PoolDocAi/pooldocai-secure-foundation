-- REVIEW ONLY: read-only inventory. No SQL in this package may be sent to a
-- hosted database under current authorization. Future target: CMS STAGING ONLY
-- rzkgmvyyeclrpomrlyft; verify connection separately, not by this literal label.
-- Scout must bind the returned catalog/ACL/policy snapshot to a reviewed digest.
SELECT version(),current_user,session_user,current_database();
SELECT n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relowner::regrole,c.relacl
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE (n.nspname='resources_cms' AND c.relkind IN ('r','p'))
 OR (n.nspname='auth' AND c.relname IN ('sessions','mfa_factors'))
 OR (n.nspname='storage' AND c.relname IN ('objects','buckets')) ORDER BY 1,2;
SELECT table_schema,table_name,column_name,data_type FROM information_schema.columns
 WHERE (table_schema='auth' AND table_name IN ('sessions','mfa_factors'))
 OR (table_schema='resources_cms' AND table_name='members') ORDER BY 1,2,3;
SELECT p.oid::regprocedure,p.proowner::regrole,p.prosecdef,p.proconfig,p.proacl,
 pg_get_functiondef(p.oid) AS definition,md5(pg_get_functiondef(p.oid)) AS drift_fingerprint
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='resources_cms'
 ORDER BY p.oid::regprocedure::text;
SELECT * FROM pg_policies WHERE schemaname IN ('resources_cms','storage') ORDER BY schemaname,tablename,policyname;
-- ACL restoration must distinguish table-level from column-level grants.
SELECT c.oid::regclass,a.attname,a.attacl FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
 WHERE a.attrelid IN ('auth.sessions'::regclass,'auth.mfa_factors'::regclass)
 AND a.attnum>0 AND NOT a.attisdropped ORDER BY 1,2;
SELECT d.classid::regclass,d.objid,d.objsubid,d.refclassid::regclass,d.refobjid,d.refobjsubid,d.deptype
 FROM pg_depend d WHERE d.refobjid IN ('resources_cms.actor()'::regprocedure,'resources_cms.has_role(text[])'::regprocedure)
 OR d.objid IN ('resources_cms.actor()'::regprocedure,'resources_cms.has_role(text[])'::regprocedure);
-- SQL/plpgsql bodies stored as strings do not all appear in pg_depend. Review
-- EVERY authenticated-executable private definer body, including platform,
-- navigation, media, owner commands, backup/export and policy helper paths.
SELECT p.oid::regprocedure,p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='resources_cms' AND has_function_privilege('authenticated',p.oid,'EXECUTE');
SELECT rolname,rolsuper,rolcanlogin,rolbypassrls,rolinherit FROM pg_roles
 WHERE rolname IN ('resources_cms_command_owner','resources_cms_runtime','authenticator','authenticated','anon');
SELECT * FROM pg_auth_members WHERE roleid IN
 (SELECT oid FROM pg_roles WHERE rolname IN ('resources_cms_command_owner','resources_cms_runtime'));
-- Hard-stop predicates: every row must be true AND manual dependency review pass.
SELECT
 to_regclass('resources_cms.mfa_policy') IS NULL AS candidate_absent,
 to_regprocedure('resources_cms.mfa_member_role()') IS NULL AS bootstrap_absent,
 to_regprocedure('resources_cms.mfa_private_role()') IS NULL AS private_role_absent,
 (SELECT NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname='resources_cms_command_owner') AS owner_role_safe,
 (SELECT relrowsecurity FROM pg_class WHERE oid='storage.objects'::regclass) AS storage_rls,
 EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='storage' AND policyname='resources_cms_boundary_update' AND permissive='RESTRICTIVE') AS existing_update_fence,
 (SELECT count(*)=0 FROM information_schema.role_table_grants WHERE table_schema='resources_cms' AND grantee IN ('anon','authenticated')) AS no_direct_cms_table_grants;
-- Do not blanket grant role membership to make this succeed. Ownership transfer
-- requires the existing separately authorized managed-PG17 SET-only procedure;
-- verify and remove only its temporary grantor-specific row, preserving managed
-- rows. No privileges or schema settings are changed by this inventory.
-- Corrected reader model: NO grant of Auth USAGE/SELECT is proposed.
-- Verify existing reader capabilities; stop instead of escalating grant authority.
SELECT has_schema_privilege('postgres','auth','USAGE') AS reader_usage,
 has_schema_privilege('postgres','auth','USAGE WITH GRANT OPTION') AS reader_can_grant_usage,
 has_schema_privilege('resources_cms_command_owner','auth','USAGE') AS command_owner_auth_usage,
 has_function_privilege('postgres','auth.jwt()','EXECUTE') AS reader_jwt,
 has_function_privilege('postgres','auth.uid()','EXECUTE') AS reader_uid;
-- Current reader_usage must be true; reader_can_grant_usage and command-owner
-- Auth USAGE are expected false. No new Auth ACL appears in corrected proposal.

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
;
-- inventory_digest must be independently reviewed/bound before a later authorized
-- transaction. A missing expected digest stops the candidate. No digest is an
-- authorization to run SQL. Storage owner is informational; no DDL rights needed.
