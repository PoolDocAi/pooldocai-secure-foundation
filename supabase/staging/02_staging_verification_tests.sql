-- ============================================================================
-- POOLDOCAI STAGING POST-MIGRATION VERIFICATION SUITE
-- Target: Staging Project rzkgmvyyeclrpomrlyft ONLY
-- Performs read-only schema checks, RLS enforcement verification,
-- and multi-tenant isolation tests against synthetic fixtures.
-- ============================================================================

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_table_count integer;
  v_non_rls_count integer;
  v_co_a_cnt integer;
  v_co_b_cnt integer;
  v_cross_tenant_cnt integer;
  v_push_sub_cnt integer;
BEGIN
  RAISE NOTICE '=== Starting PoolDocAI Staging Verification ===';

  -- 1. Verify Core Tables Exist
  SELECT count(*) INTO v_table_count
  FROM pg_tables
  WHERE schemaname = 'public'
    AND tablename IN (
      'companies', 'company_members', 'service_requests', 'service_customers',
      'company_manuals', 'platform_usage_events', 'grounding_cost_cache',
      'company_notifications', 'user_notifications', 'notification_delivery_queue',
      'user_notification_preferences', 'user_push_subscriptions'
    );

  IF v_table_count < 12 THEN
    RAISE EXCEPTION 'Missing core schema tables in staging: found %/12', v_table_count;
  END IF;
  RAISE NOTICE 'PASS: All 12 core multi-tenant and notification tables verified.';

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
  RAISE NOTICE 'PASS: All required security RPCs verified.';

  -- 4. Verify Multi-Tenant Isolation (AquaPure vs BlueWave)
  -- Impersonate AquaPure Technician
  EXECUTE 'SET LOCAL "request.jwt.claim.sub" = ''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb''';
  EXECUTE 'SET LOCAL "request.jwt.claim.role" = ''authenticated''';

  SELECT count(*) INTO v_co_a_cnt
  FROM public.service_requests
  WHERE company_id = '11111111-1111-4111-8111-111111111111';

  IF v_co_a_cnt <> 1 THEN
    RAISE EXCEPTION 'AquaPure technician could not read own company service request (got %)', v_co_a_cnt;
  END IF;

  -- Verify AquaPure Tech CANNOT see BlueWave Service Requests
  SELECT count(*) INTO v_cross_tenant_cnt
  FROM public.service_requests
  WHERE company_id = '22222222-2222-4222-8222-222222222222';

  IF v_cross_tenant_cnt <> 0 THEN
    RAISE EXCEPTION 'CRITICAL RLS LEAK: AquaPure tech can read BlueWave service requests! Found: %', v_cross_tenant_cnt;
  END IF;

  -- Verify AquaPure Tech CANNOT see BlueWave Push Subscriptions
  SELECT count(*) INTO v_push_sub_cnt
  FROM public.user_push_subscriptions
  WHERE company_id = '22222222-2222-4222-8222-222222222222';

  IF v_push_sub_cnt <> 0 THEN
    RAISE EXCEPTION 'CRITICAL RLS LEAK: AquaPure tech can read BlueWave push subscriptions! Found: %', v_push_sub_cnt;
  END IF;

  RAISE NOTICE 'PASS: Multi-tenant tenant boundary verified: zero cross-tenant visibility.';

  -- Impersonate BlueWave Technician
  EXECUTE 'SET LOCAL "request.jwt.claim.sub" = ''dddddddd-dddd-4ddd-8ddd-dddddddddddd''';
  EXECUTE 'SET LOCAL "request.jwt.claim.role" = ''authenticated''';

  SELECT count(*) INTO v_co_b_cnt
  FROM public.service_requests
  WHERE company_id = '22222222-2222-4222-8222-222222222222';

  IF v_co_b_cnt <> 1 THEN
    RAISE EXCEPTION 'BlueWave technician could not read own company service request (got %)', v_co_b_cnt;
  END IF;

  -- Verify BlueWave Tech CANNOT see AquaPure Service Requests
  SELECT count(*) INTO v_cross_tenant_cnt
  FROM public.service_requests
  WHERE company_id = '11111111-1111-4111-8111-111111111111';

  IF v_cross_tenant_cnt <> 0 THEN
    RAISE EXCEPTION 'CRITICAL RLS LEAK: BlueWave tech can read AquaPure service requests! Found: %', v_cross_tenant_cnt;
  END IF;

  RAISE NOTICE 'PASS: Bi-directional multi-tenant tenant isolation verified.';
  RAISE NOTICE '=== ALL STAGING CHECKS PASSED SUCCESSFULLY ===';
END $$;
