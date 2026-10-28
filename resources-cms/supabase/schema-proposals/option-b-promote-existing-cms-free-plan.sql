-- REVIEW CANDIDATE ONLY. DO NOT EXECUTE until CMS project backup + checksum
-- + archive decompression + owner acceptance/restore strategy are confirmed.
-- Target ONLY Supabase project rzkgmvyyeclrpomrlyft, NOT core Production.
-- Owner chose Option B: reuse isolated Free-tier CMS database as Production.
-- Phase 1 (below) moves publication policy to PRODUCTION but DISABLES new publication
-- until owner login, editor/revision controls and site delivery are re-verified.
-- NO CMS content, revisions, historical audit rows, permissions, or other tables change.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF current_database() <> 'postgres' OR current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Require approved Supabase CMS project postgres executor';
  END IF;
  IF (SELECT count(*) FROM information_schema.tables WHERE table_schema='resources_cms' AND table_type='BASE TABLE') <> 21 OR
     (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='resources_cms' AND c.relkind='r' AND NOT c.relrowsecurity) <> 0 OR
     (SELECT count(*) FROM resources_cms.articles) <> 5 OR
     (SELECT count(*) FROM resources_cms.articles WHERE state='published') <> 2 OR
     (SELECT count(*) FROM resources_cms.articles WHERE state='draft') <> 3 OR
     (SELECT count(*) FROM resources_cms.members WHERE active AND role='owner') <> 1 OR
     (SELECT count(*) FROM resources_cms.approved_import_allowlist) <> 34 OR
     (SELECT count(*) FROM resources_cms.owner_release_policy WHERE id AND destination='staging' AND enabled) <> 1 OR
     (SELECT count(*) FROM resources_cms.owner_release_policy) <> 1 OR
     (SELECT count(*) FROM storage.objects) <> 0 OR
     (SELECT count(*) FROM resources_cms.media) <> 0
  THEN
    RAISE EXCEPTION 'CMS source changed since authorized preflight, abort without modifying project';
  END IF;
  IF EXISTS(SELECT 1 FROM resources_cms.publication_blocks WHERE article_id IN
    (SELECT id FROM resources_cms.articles WHERE state='published')) THEN
    RAISE EXCEPTION 'Published article has unresolved publication block';
  END IF;
  IF EXISTS(SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='resources_cms' AND grantee IN ('anon','authenticated')) THEN
    RAISE EXCEPTION 'CMS direct table permissions unexpectedly exposed';
  END IF;
END $preflight$;

UPDATE resources_cms.owner_release_policy
SET destination = 'production', enabled = false
WHERE id AND destination='staging' AND enabled;

DO $postflight$
BEGIN
  IF (SELECT count(*) FROM resources_cms.owner_release_policy WHERE destination='production' AND NOT enabled) <> 1 OR
     (SELECT count(*) FROM resources_cms.public_index()) <> 2 OR
     (SELECT count(*) FROM resources_cms.members WHERE role='owner' AND active) <> 1
  THEN
    RAISE EXCEPTION 'CMS option-B promotion validation failed; transaction will roll back';
  END IF;
END $postflight$;
COMMIT;

-- SEPARATE, EXPLICITLY REVIEWED later step, NOT included in this transaction:
-- UPDATE resources_cms.owner_release_policy SET enabled=true
-- WHERE id AND destination='production' AND NOT enabled;
-- Confirm live authenticated owner release_info returns destination 'production'
-- and new articles still require exact checksum/revision owner authorization.
