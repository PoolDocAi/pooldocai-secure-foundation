-- ============================================================================
-- POOLDOCAI STAGING POST-MIGRATION VERIFICATION SUITE
-- Target: Staging Project rzkgmvyyeclrpomrlyft ONLY
-- Performs read-only schema checks, RLS enforcement verification,
-- security RPC validation, negative controls, and multi-tenant isolation tests.
--
-- COMPATIBILITY NOTE:
-- Contains standard PostgreSQL statements (no psql meta-commands).
-- Safe for execution via Supabase Dashboard Web SQL Editor or psql client.
-- ============================================================================

DO $$
DECLARE
  v_table_count integer;
  v_non_rls_count integer;
  v_co_a_cnt integer;
  v_co_b_cnt integer;
  v_cross_tenant_cnt integer;
  v_push_sub_cnt integer;
  v_members_cnt integer;
BEGIN
  RAISE NOTICE '=== Starting PoolDocAI Staging Verification ===';

  -- 1. Verify Core Tables Exist
  SELECT count(*) INTO v_table_count
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN (
      'companies', 'company_members', 'service_requests', 'service_customers',
      'company_manuals', 'company_manual_chunks', 'platform_usage_events',
      'pooldocai_grounded_answer_cache', 'company_notifications',
      'user_notifications', 'notification_delivery_queue',
      'user_notification_preferences', 'user_push_subscriptions'
    );

  IF v_table_count < 13 THEN
    RAISE EXCEPTION 'Missing core schema tables in staging: found %/13', v_table_count;
  END IF;
  RAISE NOTICE 'PASS: All 13 core multi-tenant, manual chunk, and notification tables verified.';

  -- 2. Verify Row-Level Security (RLS) is ENABLED on ALL Public Tables
  SELECT count(*) INTO v_non_rls_count
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relrowsecurity = false;

  IF v_non_rls_count > 0 THEN
    RAISE EXCEPTION 'Security violation: found % public tables with RLS disabled', v_non_rls_count;
  END IF;
  RAISE NOTICE 'PASS: 100%% of public schema tables enforce Row Level Security.';

  -- 3. Verify RPC Functions Exist
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'pooldocai_register_push_subscription') THEN
    RAISE EXCEPTION 'Missing RPC pooldocai_register_push_subscription';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'pooldocai_claim_push_delivery_batch') THEN
    RAISE EXCEPTION 'Missing RPC pooldocai_claim_push_delivery_batch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'pooldocai_claim_email_delivery_batch') THEN
    RAISE EXCEPTION 'Missing RPC pooldocai_claim_email_delivery_batch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'pooldocai_check_manual_duplicate') THEN
    RAISE EXCEPTION 'Missing RPC pooldocai_check_manual_duplicate';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'search_company_manual_chunks_hybrid') THEN
    RAISE EXCEPTION 'Missing RPC search_company_manual_chunks_hybrid';
  END IF;
  RAISE NOTICE 'PASS: All required security RPCs verified (push, email, duplicate guard, hybrid retrieval).';

  -- 4. Verify Multi-Tenant Isolation (AquaPure vs BlueWave)
  -- Impersonate AquaPure Technician (switch role to non-superuser authenticated to enforce RLS)
  PERFORM set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  -- Assert that current role is non-superuser 'authenticated' and row_security_active returns true
  IF current_user <> 'authenticated' THEN
    RAISE EXCEPTION 'Security assertion failed: current_user is %, expected authenticated', current_user;
  END IF;
  IF NOT row_security_active('public.service_requests'::regclass) THEN
    RAISE EXCEPTION 'Security assertion failed: Row Security is NOT active on public.service_requests';
  END IF;
  IF NOT row_security_active('public.user_push_subscriptions'::regclass) THEN
    RAISE EXCEPTION 'Security assertion failed: Row Security is NOT active on public.user_push_subscriptions';
  END IF;
  IF NOT row_security_active('public.company_members'::regclass) THEN
    RAISE EXCEPTION 'Security assertion failed: Row Security is NOT active on public.company_members';
  END IF;

  SELECT count(*) INTO v_co_a_cnt
  FROM public.service_requests
  WHERE company_id = '11111111-1111-4111-8111-111111111111';

  -- Verify AquaPure Tech CANNOT see BlueWave Service Requests
  SELECT count(*) INTO v_cross_tenant_cnt
  FROM public.service_requests
  WHERE company_id = '22222222-2222-4222-8222-222222222222';

  -- Verify AquaPure Tech CANNOT see BlueWave Push Subscriptions
  SELECT count(*) INTO v_push_sub_cnt
  FROM public.user_push_subscriptions
  WHERE company_id = '22222222-2222-4222-8222-222222222222';

  -- Verify AquaPure Tech CANNOT see BlueWave Company Members
  SELECT count(*) INTO v_members_cnt
  FROM public.company_members
  WHERE company_id = '22222222-2222-4222-8222-222222222222';

  EXECUTE 'RESET ROLE';

  IF v_co_a_cnt <> 1 THEN
    RAISE EXCEPTION 'AquaPure technician could not read own company service request (got %)', v_co_a_cnt;
  END IF;

  IF v_cross_tenant_cnt <> 0 THEN
    RAISE EXCEPTION 'CRITICAL RLS LEAK: AquaPure tech can read BlueWave service requests! Found: %', v_cross_tenant_cnt;
  END IF;

  IF v_push_sub_cnt <> 0 THEN
    RAISE EXCEPTION 'CRITICAL RLS LEAK: AquaPure tech can read BlueWave push subscriptions! Found: %', v_push_sub_cnt;
  END IF;

  IF v_members_cnt <> 0 THEN
    RAISE EXCEPTION 'CRITICAL RLS LEAK: AquaPure tech can read BlueWave company members! Found: %', v_members_cnt;
  END IF;

  RAISE NOTICE 'PASS: Multi-tenant tenant boundary verified under authenticated role: zero cross-tenant visibility.';

  -- Impersonate BlueWave Technician
  PERFORM set_config('request.jwt.claim.sub', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT count(*) INTO v_co_b_cnt
  FROM public.service_requests
  WHERE company_id = '22222222-2222-4222-8222-222222222222';

  -- Verify BlueWave Tech CANNOT see AquaPure Service Requests
  SELECT count(*) INTO v_cross_tenant_cnt
  FROM public.service_requests
  WHERE company_id = '11111111-1111-4111-8111-111111111111';

  EXECUTE 'RESET ROLE';

  IF v_co_b_cnt <> 1 THEN
    RAISE EXCEPTION 'BlueWave technician could not read own company service request (got %)', v_co_b_cnt;
  END IF;

  IF v_cross_tenant_cnt <> 0 THEN
    RAISE EXCEPTION 'CRITICAL RLS LEAK: BlueWave tech can read AquaPure service requests! Found: %', v_cross_tenant_cnt;
  END IF;

  -- 5. Negative Control: Anonymous role cannot read private tenant records
  EXECUTE 'SET LOCAL ROLE anon';
  BEGIN
    SELECT count(*) INTO v_cross_tenant_cnt FROM public.service_requests;
    IF v_cross_tenant_cnt <> 0 THEN
      RAISE EXCEPTION 'CRITICAL SECURITY BREACH: Anonymous user can read service_requests! Found: %', v_cross_tenant_cnt;
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    -- Expected: permission denied by database grant
    NULL;
  END;

  BEGIN
    SELECT count(*) INTO v_cross_tenant_cnt FROM public.user_push_subscriptions;
    IF v_cross_tenant_cnt <> 0 THEN
      RAISE EXCEPTION 'CRITICAL SECURITY BREACH: Anonymous user can read user_push_subscriptions! Found: %', v_cross_tenant_cnt;
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    -- Expected: permission denied by database grant
    NULL;
  END;
  EXECUTE 'RESET ROLE';
  RAISE NOTICE 'PASS: Negative control verified: anonymous access completely denied (table privilege and RLS).';

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);

  RAISE NOTICE 'PASS: Bi-directional multi-tenant tenant isolation verified with active RLS enforcement.';
  RAISE NOTICE '=== ALL STAGING CHECKS PASSED SUCCESSFULLY ===';
END $$;
