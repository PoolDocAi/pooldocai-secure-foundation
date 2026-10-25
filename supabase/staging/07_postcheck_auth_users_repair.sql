-- ============================================================================
-- POOLDOCAI TASK-008 PART-1C: POSTCHECK AUTH USERS DATA REPAIR (READ-ONLY)
-- Target: Staging Project rzkgmvyyeclrpomrlyft ONLY
--
-- Safety:
-- - STRICTLY READ-ONLY (SELECT queries only, zero mutations)
-- - Verifies zero NULLs in email_change, email_change_token_new, and recovery_token
-- - Confirms all 4 synthetic users, identities, and company memberships remain intact
-- ============================================================================

DO $$
DECLARE
  v_user_count integer;
  v_null_count integer;
  v_empty_string_count integer;
  v_identity_count integer;
  v_member_count integer;
  v_target_ids CONSTANT uuid[] := ARRAY[
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid,
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd'::uuid
  ];
BEGIN
  RAISE NOTICE '=== POOLDOCAI: AUDITING SYNTHETIC AUTH USERS (READ-ONLY POSTCHECK) ===';

  -- 1. Verify exact 4 synthetic users exist
  SELECT count(*) INTO v_user_count
  FROM auth.users
  WHERE id = ANY(v_target_ids);

  IF v_user_count <> 4 THEN
    RAISE EXCEPTION '[POSTCHECK FAILED] Expected 4 synthetic users in auth.users, found: %', v_user_count;
  END IF;
  RAISE NOTICE '  [PASS] All 4 synthetic users confirmed in auth.users.';

  -- 2. Verify zero NULLs in target token columns
  SELECT count(*) INTO v_null_count
  FROM auth.users
  WHERE id = ANY(v_target_ids)
    AND (email_change IS NULL OR email_change_token_new IS NULL OR recovery_token IS NULL);

  IF v_null_count <> 0 THEN
    RAISE EXCEPTION '[POSTCHECK FAILED] Found % synthetic users still possessing NULL token fields.', v_null_count;
  END IF;
  RAISE NOTICE '  [PASS] Zero synthetic users have NULL token columns.';

  -- 3. Verify target token columns contain empty strings
  SELECT count(*) INTO v_empty_string_count
  FROM auth.users
  WHERE id = ANY(v_target_ids)
    AND email_change = ''
    AND email_change_token_new = ''
    AND recovery_token = '';

  IF v_empty_string_count <> 4 THEN
    RAISE EXCEPTION '[POSTCHECK FAILED] Expected 4 users with empty string tokens, found: %', v_empty_string_count;
  END IF;
  RAISE NOTICE '  [PASS] All 4 synthetic users have normalized empty string token columns (GoTrue compatible).';

  -- 4. Verify identities and memberships unchanged
  SELECT count(*) INTO v_identity_count
  FROM auth.identities
  WHERE user_id = ANY(v_target_ids) AND provider = 'email';

  IF v_identity_count <> 4 THEN
    RAISE EXCEPTION '[POSTCHECK FAILED] Expected 4 auth.identities, found: %', v_identity_count;
  END IF;

  SELECT count(*) INTO v_member_count
  FROM public.company_members
  WHERE user_id = ANY(v_target_ids);

  IF v_member_count <> 4 THEN
    RAISE EXCEPTION '[POSTCHECK FAILED] Expected 4 company_members rows, found: %', v_member_count;
  END IF;

  RAISE NOTICE '  [PASS] Identities (4/4) and company memberships (4/4) verified 100%% intact.';
  RAISE NOTICE '=== POSTCHECK COMPLETE: Synthetic accounts fully verified for GoTrue Auth Admin ===';
END $$;
