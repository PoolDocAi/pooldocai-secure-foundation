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
