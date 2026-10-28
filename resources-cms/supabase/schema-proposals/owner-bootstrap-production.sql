-- REVIEW CANDIDATE ONLY — DO NOT APPLY AUTOMATICALLY.
-- Execute ONLY after:
-- (1) a recoverable Production backup is tested, (2) isolated CMS v1/v2
--     migrations are installed and verified, (3) owner has authorized rollout.
-- Replace the deliberately INVALID owner token at execution time with the
-- already-verified PROD Auth user UUID; never commit the real UUID.
-- NO schema, grants, application-core, or role changes are made here.
BEGIN;
DO $bootstrap$
DECLARE
  expected_owner uuid := '__REPLACE_WITH_VERIFIED_PRODUCTION_OWNER_UUID__'::uuid;
  row_count integer;
BEGIN
  IF current_user <> 'postgres' OR current_database() <> 'postgres' THEN
    RAISE EXCEPTION 'Requires controlled Supabase Production postgres executor';
  END IF;
  IF to_regnamespace('resources_cms') IS NULL OR
    to_regclass('resources_cms.members') IS NULL OR
    to_regclass('resources_cms.articles') IS NULL OR
    to_regrole('resources_cms_command_owner') IS NULL OR
    to_regclass('public.company_members') IS NULL THEN
    RAISE EXCEPTION 'Expected isolated CMS v1/v2 and existing application baseline not installed';
  END IF;
  IF (SELECT count(*) FROM resources_cms.members) <> 0 OR
     (SELECT count(*) FROM resources_cms.articles) <> 0 THEN
    RAISE EXCEPTION 'CMS already contains owners or articles; manual reconciliation required';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM auth.users u WHERE u.id = expected_owner
      AND u.email_confirmed_at IS NOT NULL
      AND u.deleted_at IS NULL
      AND (u.banned_until IS NULL OR u.banned_until < now())
      AND length(coalesce(u.encrypted_password, '')) > 0
  ) THEN RAISE EXCEPTION 'Owner UUID is not an active verified Production Auth user';
  END IF;
  INSERT INTO resources_cms.members(user_id,role,active)
  VALUES(expected_owner,'owner',true);
  GET DIAGNOSTICS row_count = ROW_COUNT;
  IF row_count <> 1 OR
    (SELECT count(*) FROM resources_cms.members WHERE role='owner' AND active) <> 1 THEN
    RAISE EXCEPTION 'Owner provisioning did not produce exactly one active CMS owner';
  END IF;
  IF has_table_privilege('anon','resources_cms.members','SELECT') OR
     has_table_privilege('authenticated','resources_cms.members','SELECT') OR
     has_table_privilege('anon','resources_cms.articles','SELECT') OR
     has_table_privilege('authenticated','resources_cms.articles','SELECT') THEN
    RAISE EXCEPTION 'CMS private table privilege unexpectedly exposed to Data API roles';
  END IF;
END $bootstrap$;
COMMIT;
-- Follow with read-only membership count, owner login, auth/CSRF and RLS tests.
-- Do not enable public article publishing or publish any content in this step.
