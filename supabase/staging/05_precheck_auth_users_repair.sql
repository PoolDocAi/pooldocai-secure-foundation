-- ============================================================================
-- POOLDOCAI TASK-008 PART-1C: PRECHECK AUTH USERS DATA REPAIR (READ-ONLY)
-- Target: Staging Project rzkgmvyyeclrpomrlyft ONLY
--
-- Safety:
-- - STRICTLY READ-ONLY (SELECT queries only, zero mutations)
-- - Inspects exact four synthetic test accounts
-- - Audits NULL token columns (email_change, email_change_token_new, recovery_token)
-- - Confirms identities and company memberships are intact
-- ============================================================================

DO $$
DECLARE
  v_user_count integer;
  v_null_email_change integer;
  v_null_email_change_new integer;
  v_null_recovery_token integer;
  v_identity_count integer;
  v_member_count integer;
  v_target_ids CONSTANT uuid[] := ARRAY[
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid,
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc'::uuid,
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd'::uuid
  ];
BEGIN
  RAISE NOTICE '=== POOLDOCAI: AUDITING SYNTHETIC AUTH USERS (READ-ONLY PRECHECK) ===';

  -- 1. Verify exact 4 synthetic users exist in auth.users
  SELECT count(*) INTO v_user_count
  FROM auth.users
  WHERE id = ANY(v_target_ids);

  IF v_user_count <> 4 THEN
    RAISE EXCEPTION '[PRECHECK FAILED] Expected exactly 4 synthetic users in auth.users, found: %', v_user_count;
  END IF;
  RAISE NOTICE '  [PASS] All 4 synthetic users confirmed in auth.users.';

  -- 2. Audit NULL token columns
  SELECT
    count(*) FILTER (WHERE email_change IS NULL),
    count(*) FILTER (WHERE email_change_token_new IS NULL),
    count(*) FILTER (WHERE recovery_token IS NULL)
  INTO
    v_null_email_change,
    v_null_email_change_new,
    v_null_recovery_token
  FROM auth.users
  WHERE id = ANY(v_target_ids);

  RAISE NOTICE '  [AUDIT] NULL column counts among 4 synthetic users:';
  RAISE NOTICE '    - email_change IS NULL:           %', v_null_email_change;
  RAISE NOTICE '    - email_change_token_new IS NULL: %', v_null_email_change_new;
  RAISE NOTICE '    - recovery_token IS NULL:         %', v_null_recovery_token;

  -- 3. Verify matching auth.identities
  SELECT count(*) INTO v_identity_count
  FROM auth.identities
  WHERE user_id = ANY(v_target_ids) AND provider = 'email';

  IF v_identity_count <> 4 THEN
    RAISE EXCEPTION '[PRECHECK FAILED] Expected 4 matching auth.identities, found: %', v_identity_count;
  END IF;
  RAISE NOTICE '  [PASS] All 4 auth.identities records confirmed.';

  -- 4. Verify matching public.company_members
  SELECT count(*) INTO v_member_count
  FROM public.company_members
  WHERE user_id = ANY(v_target_ids);

  IF v_member_count <> 4 THEN
    RAISE EXCEPTION '[PRECHECK FAILED] Expected 4 company_members rows, found: %', v_member_count;
  END IF;
  RAISE NOTICE '  [PASS] All 4 company_members records confirmed.';

  RAISE NOTICE '=== PRECHECK COMPLETE: Synthetic accounts ready for bounded data repair ===';
END $$;
