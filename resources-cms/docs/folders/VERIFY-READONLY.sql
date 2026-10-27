-- Read-only; use only after separately authorized application of the proposal.
SELECT current_database(),current_user,version();
SELECT n.nspname,c.relname,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='resources_cms' AND c.relname IN('navigation_versions','navigation_state','navigation_receipts');
SELECT p.proname,pg_get_userbyid(p.proowner) owner,p.prosecdef,p.proconfig,p.proacl FROM pg_proc p WHERE p.pronamespace='resources_cms'::regnamespace AND p.proname LIKE 'navigation_%';
SELECT r.rolname role,m.rolname member,g.rolname grantor,a.admin_option,a.inherit_option,a.set_option FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member JOIN pg_roles g ON g.oid=a.grantor WHERE r.rolname='resources_cms_command_owner';
SELECT role_name,has_table_privilege(role_name,'resources_cms.navigation_versions','SELECT,INSERT,UPDATE,DELETE') any_table_access FROM (VALUES('anon'),('authenticated'),('service_role'),('resources_cms_runtime')) v(role_name);
SELECT version,published_version,redirects FROM resources_cms.navigation_state;
SELECT count(*) FROM resources_cms.navigation_versions;
SELECT count(*) FROM resources_cms.articles;
SELECT count(*) FROM resources_cms.publication_authorizations;
SELECT count(*) FROM resources_cms.knowledge_grants;
SELECT count(*) FROM supabase_migrations.schema_migrations;
