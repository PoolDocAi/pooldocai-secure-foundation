-- PROPOSAL ONLY. Not for use after any owner navigation edits. No CASCADE.
-- Obtain a verified independent backup and compare permission fingerprints first.
BEGIN;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM resources_cms.navigation_versions) OR EXISTS(SELECT 1 FROM resources_cms.navigation_receipts) OR EXISTS(SELECT 1 FROM resources_cms.navigation_state WHERE version<>0 OR published_version IS NOT NULL) THEN RAISE EXCEPTION 'Navigation was used; preserve data and stop'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid='resources_cms_command_owner'::regrole AND (inherit_option OR set_option)) THEN RAISE EXCEPTION 'Unexpected owner membership'; END IF;
END $$;
GRANT resources_cms_command_owner TO postgres WITH ADMIN FALSE,INHERIT FALSE,SET TRUE GRANTED BY postgres;
-- Tables remain migration-executor-owned; their trigger is removed with the table.
DROP TABLE resources_cms.navigation_receipts;
DROP TABLE resources_cms.navigation_state;
DROP TABLE resources_cms.navigation_versions;
SET LOCAL ROLE resources_cms_command_owner;
DROP FUNCTION resources_cms.navigation_command(jsonb);
DROP FUNCTION resources_cms.navigation_query();
DROP FUNCTION resources_cms.navigation_public(text);
DROP FUNCTION resources_cms.navigation_validate(jsonb,jsonb);
DROP FUNCTION resources_cms.navigation_path(jsonb,text);
DROP FUNCTION resources_cms.navigation_immutable();
RESET ROLE;
REVOKE resources_cms_command_owner FROM postgres GRANTED BY postgres RESTRICT;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid='resources_cms_command_owner'::regrole AND (inherit_option OR set_option)) THEN RAISE EXCEPTION 'Temporary privilege remains'; END IF; END $$;
ROLLBACK;
