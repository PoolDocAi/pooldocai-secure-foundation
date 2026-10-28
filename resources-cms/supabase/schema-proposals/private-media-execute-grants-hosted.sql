-- Staging ACL-only migration. No content, Storage policy, or function body changes.
BEGIN;
DO $preflight$ BEGIN
 IF current_user<>'postgres' OR NOT EXISTS(SELECT 1 FROM resources_cms.owner_release_policy WHERE id AND destination='staging') THEN RAISE EXCEPTION 'Staging administrator required'; END IF;
 IF pg_has_role('postgres','resources_cms_command_owner','SET') OR pg_has_role('postgres','resources_cms_command_owner','USAGE') THEN RAISE EXCEPTION 'Unexpected existing effective owner membership'; END IF;
 IF has_schema_privilege('resources_cms_command_owner','resources_cms','CREATE') THEN RAISE EXCEPTION 'Unexpected existing CREATE privilege'; END IF;
END $preflight$;
GRANT resources_cms_command_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
SET LOCAL ROLE resources_cms_command_owner;
-- ACL-only repair. Parent transaction must SET ROLE to the existing function
-- owner; a managed postgres administrator is not necessarily a superuser.
DO $guard$ BEGIN
 IF current_user <> 'resources_cms_command_owner' THEN
  RAISE EXCEPTION 'Execute grant repair requires the exact function owner';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='resources_cms' AND p.proname IN
   ('media_rights_details_valid','media_release_ready','media_rights_read','media_rights_command',
    'owner_storage_member','owner_storage_public_object','owner_storage_orphan_object')
  AND p.proowner<>current_user::regrole) THEN RAISE EXCEPTION 'Unexpected function owner'; END IF;
END $guard$;
REVOKE ALL ON FUNCTION resources_cms.media_rights_details_valid(jsonb),
 resources_cms.media_release_ready(uuid),resources_cms.media_rights_read(uuid),
 resources_cms.media_rights_command(uuid,uuid,integer,text,jsonb),
 resources_cms.owner_storage_member(text[]),resources_cms.owner_storage_public_object(text),
 resources_cms.owner_storage_orphan_object(text)
 FROM PUBLIC,anon,authenticated,resources_cms_runtime;
GRANT EXECUTE ON FUNCTION resources_cms.media_rights_read(uuid),
 resources_cms.media_rights_command(uuid,uuid,integer,text,jsonb),
 resources_cms.owner_storage_orphan_object(text) TO authenticated;
-- These two helpers are evaluated by Storage RLS, including anonymous SELECT.
GRANT EXECUTE ON FUNCTION resources_cms.owner_storage_member(text[]),
 resources_cms.owner_storage_public_object(text) TO anon,authenticated;
DO $verify$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace,
  LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE n.nspname='resources_cms' AND p.proname IN
   ('media_rights_details_valid','media_release_ready','media_rights_read','media_rights_command',
    'owner_storage_member','owner_storage_public_object','owner_storage_orphan_object')
  AND a.grantee=0 AND a.privilege_type='EXECUTE') THEN
  RAISE EXCEPTION 'PUBLIC execute survived ACL repair';
 END IF;
 IF has_function_privilege('anon','resources_cms.media_rights_read(uuid)','EXECUTE')
  OR has_function_privilege('anon','resources_cms.media_rights_command(uuid,uuid,integer,text,jsonb)','EXECUTE')
  OR has_function_privilege('authenticated','resources_cms.media_release_ready(uuid)','EXECUTE')
  OR has_function_privilege('anon','resources_cms.owner_storage_orphan_object(text)','EXECUTE') THEN
  RAISE EXCEPTION 'Unexpected API execution privilege';
 END IF;
END $verify$;

RESET ROLE;
REVOKE resources_cms_command_owner FROM postgres GRANTED BY postgres RESTRICT;
DO $cleanup$ BEGIN
 IF pg_has_role('postgres','resources_cms_command_owner','SET') OR pg_has_role('postgres','resources_cms_command_owner','USAGE') THEN RAISE EXCEPTION 'Temporary owner membership survived'; END IF;
END $cleanup$;
COMMIT;
