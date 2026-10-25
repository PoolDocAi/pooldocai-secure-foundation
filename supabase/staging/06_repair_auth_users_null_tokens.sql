-- ============================================================================
-- POOLDOCAI TASK-008 PART-1C: BOUNDED AUTH USERS DATA REPAIR (TRANSACTIONAL)
-- Target: Staging Project rzkgmvyyeclrpomrlyft ONLY
--
-- P0 ROOT CAUSE REMEDIATION:
-- Replaces NULL values in email_change, email_change_token_new, and recovery_token
-- with empty strings ('') strictly for the four pre-approved synthetic test accounts.
-- This resolves GoTrue Go sql.Scanner "converting NULL to string is unsupported"
-- which triggers HTTP 500 Database error loading user on GET /auth/v1/admin/users/:id.
--
-- STRICT SAFETY & ISOLATION BOUNDARIES:
-- 1. Strictly bounded to the 4 synthetic test UUIDs (NO blanket UPDATE).
-- 2. Strictly atomic transaction: rolls back if rows affected <> 4 or postcheck fails.
-- 3. Preserves all existing IDs, emails, bcrypt password hashes, roles, metadata,
--    identities, company memberships, and timestamps.
-- 4. Audit logging: prints before and after NULL counts.
-- 5. REQUIRES EXPLICIT OWNER APPROVAL BEFORE EXECUTION ON STAGING.
-- ============================================================================

DO $$
DECLARE
  v_user_count integer;
  v_updated_rows integer;
  v_null_before integer;
  v_null_after integer;
  v_identity_count integer;
  v_member_count integer;
  v_target_ids CONSTANT uuid[] := ARRAY[
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid,
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd'::uuid
  ];
BEGIN
  RAISE NOTICE '=== POOLDOCAI: STARTING BOUNDED TRANSACTIONAL AUTH DATA REPAIR ===';

  -- 1. Preflight: Verify exact target accounts exist
  SELECT count(*) INTO v_user_count
  FROM auth.users
  WHERE id = ANY(v_target_ids);

  IF v_user_count <> 4 THEN
    RAISE EXCEPTION '[REPAIR ABORTED] Target account allowlist mismatch: expected 4 users, found %', v_user_count;
  END IF;

  -- 2. Audit: Count NULLs before repair
  SELECT count(*) INTO v_null_before
  FROM auth.users
  WHERE id = ANY(v_target_ids)
    AND (email_change IS NULL OR email_change_token_new IS NULL OR recovery_token IS NULL);

  RAISE NOTICE '  [AUDIT BEFORE] Synthetic users with NULL token fields: % / 4', v_null_before;

  -- 3. Bounded Mutation: Coalesce NULLs to '' strictly on the 4 synthetic accounts
  UPDATE auth.users
  SET
    email_change = COALESCE(email_change, ''),
    email_change_token_new = COALESCE(email_change_token_new, ''),
    recovery_token = COALESCE(recovery_token, '')
  WHERE id = ANY(v_target_ids);

  GET DIAGNOSTICS v_updated_rows = ROW_COUNT;

  IF v_updated_rows <> 4 THEN
    RAISE EXCEPTION '[REPAIR ABORTED] Expected exactly 4 rows updated, actual: %. Rolling back transaction.', v_updated_rows;
  END IF;
  RAISE NOTICE '  [PASS] Updated exactly % synthetic auth.users rows.', v_updated_rows;

  -- 4. Postcheck: Verify zero NULLs remain on target accounts
  SELECT count(*) INTO v_null_after
  FROM auth.users
  WHERE id = ANY(v_target_ids)
    AND (email_change IS NULL OR email_change_token_new IS NULL OR recovery_token IS NULL);

  IF v_null_after <> 0 THEN
    RAISE EXCEPTION '[REPAIR ABORTED] Target accounts still have NULL token fields after repair: %. Rolling back.', v_null_after;
  END IF;
  RAISE NOTICE '  [AUDIT AFTER] Synthetic users with NULL token fields: 0 / 4 (All resolved to empty strings).';

  -- 5. Integrity Check: Verify identities and company memberships remained 100% intact
  SELECT count(*) INTO v_identity_count
  FROM auth.identities
  WHERE user_id = ANY(v_target_ids) AND provider = 'email';

  IF v_identity_count <> 4 THEN
    RAISE EXCEPTION '[REPAIR ABORTED] Identity integrity violation: expected 4 identities, found %', v_identity_count;
  END IF;

  SELECT count(*) INTO v_member_count
  FROM public.company_members
  WHERE user_id = ANY(v_target_ids);

  IF v_member_count <> 4 THEN
    RAISE EXCEPTION '[REPAIR ABORTED] Membership integrity violation: expected 4 members, found %', v_member_count;
  END IF;

  RAISE NOTICE '  [PASS] Identities (4/4) and company memberships (4/4) verified 100%% intact.';
  RAISE NOTICE '=== BOUNDED AUTH DATA REPAIR COMPLETED SUCCESSFULLY ===';
END $$;
