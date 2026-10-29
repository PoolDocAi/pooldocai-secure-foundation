-- Run after applying all migrations in a non-production Supabase project.
-- Static assertions catch missing RLS/grants; tenant-boundary behavior must also be tested
-- using two real test users from different companies (see SECURITY_TEST_PLAN.md).
do $$
begin
  if not (select relrowsecurity from pg_class where oid='public.company_manual_chunks'::regclass) then raise exception 'RLS missing on company_manual_chunks'; end if;
  if not (select relrowsecurity from pg_class where oid='public.technician_job_records'::regclass) then raise exception 'RLS missing on technician_job_records'; end if;
  if not (select relrowsecurity from pg_class where oid='public.service_customers'::regclass) then raise exception 'RLS missing on service_customers'; end if;
  if not (select relrowsecurity from pg_class where oid='public.document_processing_jobs'::regclass) then raise exception 'RLS missing on document_processing_jobs'; end if;
  if has_table_privilege('anon','public.company_manual_chunks','select') then raise exception 'anon can read extracted company text'; end if;
  if has_table_privilege('authenticated','public.company_manual_chunks','select') then raise exception 'authenticated can directly read extracted company text'; end if;
  if has_table_privilege('authenticated','public.shared_learning_knowledge','select') then raise exception 'authenticated can directly read shared knowledge table'; end if;
  if has_table_privilege('authenticated','public.learning_review_queue','select') then raise exception 'authenticated can directly read learning review queue'; end if;
  if has_function_privilege('authenticated','public.pooldocai_claim_document_job()','execute') then raise exception 'authenticated can claim worker jobs'; end if;
  if has_function_privilege('anon','public.pooldocai_enqueue_document_job(uuid,uuid,boolean)','execute') then raise exception 'anon can enqueue worker jobs'; end if;
  if (select public.is_platform_admin()) is null then raise exception 'is_platform_admin unexpectedly null'; end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='company_members' and column_name='can_view_job_notes') then raise exception 'company member note permission missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='company_members' and column_name='can_upload_documents') then raise exception 'company member document upload permission missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='company_members' and column_name='can_review_documents') then raise exception 'company member document review permission missing'; end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='companies' and policyname='companies_update_admin' and cmd='UPDATE' and qual ilike '%is_platform_admin%') then raise exception 'platform-only company subscription update policy missing'; end if;
  if exists (select 1 from pg_policies where schemaname='public' and tablename='companies' and policyname='companies_update_admin' and cmd='UPDATE' and qual ilike '%is_company_admin%') then raise exception 'company admins must not be able to edit subscription-level company controls'; end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='companies' and policyname='companies_insert_platform_owner' and cmd='INSERT' and with_check ilike '%is_platform_admin%') then raise exception 'platform-owner-only company creation policy missing'; end if;
  if has_table_privilege('anon','public.companies','insert') then raise exception 'anon can insert company subscriptions'; end if;
  -- Trigger-only SECURITY DEFINER functions must not be exposed as client RPCs.
  if has_function_privilege('anon','public.enforce_company_seat_limit()','execute')
     or has_function_privilege('authenticated','public.enforce_company_seat_limit()','execute') then
    raise exception 'trigger-only seat-limit function is directly executable by API roles';
  end if;
  if has_function_privilege('anon','public.protect_company_plan_fields()','execute')
     or has_function_privilege('authenticated','public.protect_company_plan_fields()','execute') then
    raise exception 'trigger-only company-plan guard is directly executable by API roles';
  end if;
  if has_function_privilege('anon','public.pooldocai_audit_initial_document_consent()','execute')
     or has_function_privilege('authenticated','public.pooldocai_audit_initial_document_consent()','execute') then
    raise exception 'trigger-only consent audit function is directly executable by API roles';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid='public.company_members'::regclass and tgname='company_member_seat_limit' and not tgisinternal and tgenabled <> 'D') then
    raise exception 'seat-limit trigger was damaged by execute-privilege hardening';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid='public.companies'::regclass and tgname='protect_company_plan_fields' and not tgisinternal and tgenabled <> 'D') then
    raise exception 'company plan protection trigger was damaged by execute-privilege hardening';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid='public.company_manuals'::regclass and tgname='company_manuals_initial_consent_audit' and not tgisinternal and tgenabled <> 'D') then
    raise exception 'initial document consent audit trigger was damaged by execute-privilege hardening';
  end if;
  if not exists (select 1 from pg_trigger where tgrelid='public.company_members'::regclass and tgname='company_member_default_permissions_insert' and not tgisinternal) then raise exception 'company member default insert trigger missing'; end if;
  if not exists (select 1 from pg_trigger where tgrelid='public.company_members'::regclass and tgname='company_member_self_change_guard' and not tgisinternal) then raise exception 'company member self-change guard missing'; end if;
  if has_table_privilege('authenticated','public.company_member_access_audit','insert') then raise exception 'authenticated can forge member access audit history'; end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='company_manuals' and policyname='manuals_company_read' and qual ilike '%can_review_company_documents%' and qual ilike '%can_upload_company_documents%') then raise exception 'company manuals read policy must honor upload/review permissions'; end if;
  if has_function_privilege('anon','public.pooldocai_consume_public_demo_turn(text,text,integer,integer)','execute') then raise exception 'anon can call the demo turn quota RPC directly'; end if;
  if position('demo_session.turns_used + 1' in pg_get_functiondef('public.pooldocai_consume_public_demo_turn(text,text,integer,integer)'::regprocedure)) = 0 then raise exception 'public demo quota RPC is missing the qualified turns_used increment fix'; end if;
end $$;

-- Verify public demo cap is eight turns and a separate mode-specific session gets its own allowance.
do $$
declare
  homeowner_hash text := 'ci-demo-homeowner-' || md5(clock_timestamp()::text || random()::text);
  fieldtech_hash text := 'ci-demo-fieldtech-' || md5(clock_timestamp()::text || random()::text);
  r record;
  i integer;
begin
  for i in 1..8 loop
    select * into r from public.pooldocai_consume_public_demo_turn(homeowner_hash, 'turn-' || i::text, 99, 24);
    if not r.allowed then raise exception 'Homeowner demo was blocked before turn % of 8', i; end if;
  end loop;
  select * into r from public.pooldocai_consume_public_demo_turn(homeowner_hash, 'turn-8', 99, 24);
  if not r.allowed or r.turns_used <> 8 then raise exception 'Retrying a used Homeowner turn should be idempotent at 8 turns'; end if;
  select * into r from public.pooldocai_consume_public_demo_turn(homeowner_hash, 'turn-9', 99, 24);
  if r.allowed then raise exception 'Homeowner demo allowed a ninth turn even when a caller requests 99'; end if;

  for i in 1..8 loop
    select * into r from public.pooldocai_consume_public_demo_turn(fieldtech_hash, 'turn-' || i::text, 99, 24);
    if not r.allowed then raise exception 'Field Tech demo was blocked before turn % of 8', i; end if;
  end loop;
  select * into r from public.pooldocai_consume_public_demo_turn(fieldtech_hash, 'turn-8', 99, 24);
  if not r.allowed or r.turns_used <> 8 then raise exception 'Retrying a used Field Tech turn should be idempotent at 8 turns'; end if;
  select * into r from public.pooldocai_consume_public_demo_turn(fieldtech_hash, 'turn-9', 99, 24);
  if r.allowed then raise exception 'Field Tech demo allowed a ninth turn even when a caller requests 99'; end if;

  delete from public.public_demo_sessions where session_hash in (homeowner_hash, fieldtech_hash);
end $$;

-- Inspect tenant-aware policies for the main private tables.
select schemaname, tablename, policyname, roles, cmd, qual, with_check
from pg_policies
where schemaname='public' and tablename in ('companies','company_members','service_requests','service_customers','company_manuals','technician_job_records')
order by tablename, policyname;


-- Feature-expansion schema guards: invitations, usage metering, billing webhooks,
-- semantic retrieval, page-level citations and industry activation constraints.
do $$
begin
  if to_regclass('public.pooldocai_model_rate_cards') is null then raise exception 'model rate-card table missing'; end if;
  if to_regclass('public.pooldocai_usage_alerts') is null then raise exception 'usage alert table missing'; end if;
  if to_regclass('public.pooldocai_stripe_webhook_events') is null then raise exception 'Stripe webhook idempotency ledger missing'; end if;
  if to_regclass('public.industry_modules') is null or to_regclass('public.industry_safety_rules') is null then raise exception 'industry module tables missing'; end if;
  if to_regprocedure('public.search_company_manual_chunks_hybrid(uuid,text,extensions.vector,integer)') is null then raise exception 'hybrid private document search function missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='company_manual_chunks' and column_name='page_start') then raise exception 'PDF page range metadata missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='technician_invitation_requests' and column_name='expires_at') then raise exception 'invitation expiry support missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema='public' and table_name='technician_job_records' and column_name='client_job_id') then raise exception 'offline sync idempotency column missing'; end if;
  if not exists (select 1 from pg_trigger where tgrelid='public.companies'::regclass and tgname='companies_industry_active_guard' and not tgisinternal) then raise exception 'planned industry activation guard missing'; end if;
  if has_table_privilege('authenticated','public.pooldocai_stripe_webhook_events','insert') then raise exception 'authenticated clients can forge Stripe webhook ledger entries'; end if;
end $$;

-- Companies cannot be assigned to HVAC while the module remains planned/unreviewed.
do $$
begin
  begin
    insert into public.companies(name,status,plan_name,seat_limit,industry_key)
    values ('CI planned industry guard','pilot','pilot',1,'hvac');
    raise exception 'planned HVAC module unexpectedly accepted';
  exception when check_violation then
    null;
  end;
end $$;

-- Temporary-account validity RPC is required by restrictive RLS policies, but must not
-- reveal or validate another user's temporary-access state.
DO $$
BEGIN
  IF position('p_user_id is distinct from (select auth.uid())' IN lower(pg_get_functiondef('public.temporary_access_is_valid(uuid)'::regprocedure))) = 0 THEN
    RAISE EXCEPTION 'temporary_access_is_valid must deny arbitrary cross-user ID checks';
  END IF;
  IF has_function_privilege('anon','public.temporary_access_is_valid(uuid)','execute') THEN
    RAISE EXCEPTION 'anonymous clients can invoke temporary_access_is_valid';
  END IF;
END $$;


-- Explicit company learning consent changes must be audited and must not be a client-callable RPC.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.companies'::regclass
      AND tgname='companies_diagnostic_learning_consent_audit'
      AND NOT tgisinternal AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'company diagnostic-learning consent audit trigger is missing or disabled';
  END IF;
  IF has_function_privilege('anon','public.pooldocai_audit_diagnostic_learning_consent()','execute')
     OR has_function_privilege('authenticated','public.pooldocai_audit_diagnostic_learning_consent()','execute') THEN
    RAISE EXCEPTION 'trigger-only diagnostic consent audit function is callable through the client API';
  END IF;
END $$;
-- Case-level diagnostic learning consent, terms version, and atomic approval verification
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='diagnostic_cases' AND column_name='case_learning_opt_in'
  ) THEN
    RAISE EXCEPTION 'diagnostic_cases.case_learning_opt_in column is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='diagnostic_cases' AND column_name='learning_terms_version'
  ) THEN
    RAISE EXCEPTION 'diagnostic_cases.learning_terms_version column is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid='public.diagnostic_cases'::regclass
      AND tgname='diagnostic_cases_learning_consent_audit'
      AND NOT tgisinternal AND tgenabled <> 'D'
  ) THEN
    RAISE EXCEPTION 'diagnostic_cases_learning_consent_audit trigger is missing or disabled';
  END IF;

  IF has_function_privilege('anon','public.pooldocai_audit_case_learning_consent()','execute')
     OR has_function_privilege('authenticated','public.pooldocai_audit_case_learning_consent()','execute') THEN
    RAISE EXCEPTION 'trigger-only case consent audit function is callable through the client API';
  END IF;

  IF to_regprocedure('public.pooldocai_approve_learning_case(uuid,text,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'atomic pooldocai_approve_learning_case function is missing';
  END IF;

  IF has_function_privilege('anon','public.pooldocai_approve_learning_case(uuid,text,uuid,text)','execute')
     OR has_function_privilege('authenticated','public.pooldocai_approve_learning_case(uuid,text,uuid,text)','execute') THEN
    RAISE EXCEPTION 'atomic learning approval function must not be callable by public/anon/authenticated roles';
  END IF;
END $$;

-- Migration 030: Restrictive temporary-account Storage expiry guard
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'storage' AND tablename = 'objects') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'storage' AND tablename = 'objects' AND policyname = 'temporary_access_storage_expiry_guard'
    ) THEN
      RAISE EXCEPTION 'storage.objects is missing restrictive policy temporary_access_storage_expiry_guard';
    END IF;
  END IF;
END $$;


-- Migration 034: Stripe webhook claim ownership fencing, atomic billing application, and lease governance
DO $$
DECLARE
  v_test_event_id text := 'evt_ci_concurrency_test_' || md5(clock_timestamp()::text || random()::text);
  v_claim1 jsonb;
  v_claim2 jsonb;
  v_claim3 jsonb;
  v_claim4 jsonb;
  v_claim5 jsonb;
  v_token1 text;
  v_token2 text;
  v_stale_apply jsonb;
  v_stale_release jsonb;
  v_valid_apply jsonb;
  v_bad_apply jsonb;
  v_test_company_id uuid := gen_random_uuid();
  v_test_event_stale text := 'evt_ci_stale_' || md5(clock_timestamp()::text || random()::text);
  v_claim_stale jsonb;
  v_res_stale jsonb;
  v_test_event_inv_a text := 'evt_ci_inv_a_' || md5(clock_timestamp()::text || random()::text);
  v_test_event_inv_bad text := 'evt_ci_inv_bad_' || md5(clock_timestamp()::text || random()::text);
  v_test_event_inv_nosub text := 'evt_ci_inv_nosub_' || md5(clock_timestamp()::text || random()::text);
  v_test_event_same_paid text := 'evt_ci_same_paid_' || md5(clock_timestamp()::text || random()::text);
  v_test_event_same_fail text := 'evt_ci_same_fail_' || md5(clock_timestamp()::text || random()::text);
  v_test_event_same_newer text := 'evt_ci_same_newer_' || md5(clock_timestamp()::text || random()::text);
  v_test_event_same_rec text := 'evt_ci_same_rec_' || md5(clock_timestamp()::text || random()::text);
  v_claim_inv_a jsonb;
  v_claim_inv_bad jsonb;
  v_claim_inv_nosub jsonb;
  v_claim_same_paid jsonb;
  v_claim_same_fail jsonb;
  v_claim_same_newer jsonb;
  v_claim_same_rec jsonb;
  v_res_inv_a jsonb;
  v_res_inv_bad jsonb;
  v_res_inv_nosub jsonb;
  v_res_same_paid jsonb;
  v_res_same_fail jsonb;
  v_res_same_newer jsonb;
  v_res_same_rec jsonb;
  v_company_rec record;
BEGIN
  -- 1. Routine existence checks
  IF to_regprocedure('public.pooldocai_claim_stripe_webhook_event(text,text,integer,integer)') IS NULL THEN
    RAISE EXCEPTION 'atomic pooldocai_claim_stripe_webhook_event function is missing';
  END IF;
  IF to_regprocedure('public.pooldocai_apply_and_finalize_stripe_webhook(text,text,uuid,jsonb,jsonb,text,boolean,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'atomic pooldocai_apply_and_finalize_stripe_webhook function is missing';
  END IF;
  IF to_regprocedure('public.pooldocai_release_stripe_webhook_event(text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'atomic pooldocai_release_stripe_webhook_event function is missing';
  END IF;

  -- 2. Privilege checks: Restrictive execution rights
  IF has_function_privilege('anon','public.pooldocai_claim_stripe_webhook_event(text,text,integer,integer)','execute')
     OR has_function_privilege('authenticated','public.pooldocai_claim_stripe_webhook_event(text,text,integer,integer)','execute') THEN
    RAISE EXCEPTION 'atomic webhook claim function must not be callable by public/anon/authenticated roles';
  END IF;
  IF has_function_privilege('anon','public.pooldocai_apply_and_finalize_stripe_webhook(text,text,uuid,jsonb,jsonb,text,boolean,jsonb)','execute')
     OR has_function_privilege('authenticated','public.pooldocai_apply_and_finalize_stripe_webhook(text,text,uuid,jsonb,jsonb,text,boolean,jsonb)','execute') THEN
    RAISE EXCEPTION 'webhook apply and finalize function must not be callable by public/anon/authenticated roles';
  END IF;
  IF has_function_privilege('anon','public.pooldocai_release_stripe_webhook_event(text,text,text)','execute')
     OR has_function_privilege('authenticated','public.pooldocai_release_stripe_webhook_event(text,text,text)','execute') THEN
    RAISE EXCEPTION 'webhook release function must not be callable by public/anon/authenticated roles';
  END IF;

  -- 3. Column presence checks
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pooldocai_stripe_webhook_events' AND column_name='claim_token') THEN
    RAISE EXCEPTION 'claim_token column is missing from pooldocai_stripe_webhook_events';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='pooldocai_stripe_webhook_events' AND column_name='lease_generation') THEN
    RAISE EXCEPTION 'lease_generation column is missing from pooldocai_stripe_webhook_events';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='companies' AND column_name='last_billing_event_created') THEN
    RAISE EXCEPTION 'last_billing_event_created column is missing from companies';
  END IF;

  -- 4. Initial claim on a fresh event succeeds and returns unpredictable token + monotonic lease generation
  v_claim1 := public.pooldocai_claim_stripe_webhook_event(v_test_event_id, 'customer.subscription.updated', 60, 5);
  IF (v_claim1->>'status') <> 'claimed' OR (v_claim1->>'attempts')::int <> 1 THEN
    RAISE EXCEPTION 'Initial claim failed: %', v_claim1;
  END IF;
  v_token1 := v_claim1->>'claim_token';
  IF v_token1 IS NULL OR NOT v_token1 LIKE 'claim_%' THEN
    RAISE EXCEPTION 'Initial claim must return a valid unpredictable claim_token: %', v_claim1;
  END IF;
  IF (v_claim1->>'lease_generation')::int <> 1 THEN
    RAISE EXCEPTION 'Initial claim must return lease_generation 1: %', v_claim1;
  END IF;

  -- 5. Immediate second claim while lease is active is rejected with in_progress
  v_claim2 := public.pooldocai_claim_stripe_webhook_event(v_test_event_id, 'customer.subscription.updated', 60, 5);
  IF (v_claim2->>'status') <> 'in_progress' OR (v_claim2->>'retry_after')::int < 1 THEN
    RAISE EXCEPTION 'Concurrent active claim unexpectedly succeeded: %', v_claim2;
  END IF;

  -- 6. Strict validation: empty claim token is rejected
  v_bad_apply := public.pooldocai_apply_and_finalize_stripe_webhook(v_test_event_id, '', NULL, NULL, NULL, NULL, true);
  IF (v_bad_apply->>'success')::boolean <> false OR (v_bad_apply->>'status') <> 'invalid_claim_token' THEN
    RAISE EXCEPTION 'Empty claim token must be rejected on apply: %', v_bad_apply;
  END IF;

  -- 7. Fencing check: wrong claim token is rejected
  v_stale_apply := public.pooldocai_apply_and_finalize_stripe_webhook(v_test_event_id, 'claim_wrong_token_123', NULL, NULL, NULL, NULL, true);
  IF (v_stale_apply->>'success')::boolean <> false OR (v_stale_apply->>'fenced')::boolean <> true THEN
    RAISE EXCEPTION 'Wrong claim token must be fenced out on apply: %', v_stale_apply;
  END IF;

  -- 8. Simulate first worker timing out (lease expired 70 seconds ago)
  UPDATE public.pooldocai_stripe_webhook_events
  SET claimed_at = clock_timestamp() - interval '70 seconds',
      processing_error = 'Simulated worker pause'
  WHERE stripe_event_id = v_test_event_id;

  -- 9. Retry claim after lease expiration acquires the claim on attempt 2 with a NEW token and lease_generation 2
  v_claim3 := public.pooldocai_claim_stripe_webhook_event(v_test_event_id, 'customer.subscription.updated', 60, 5);
  IF (v_claim3->>'status') <> 'claimed' OR (v_claim3->>'attempts')::int <> 2 THEN
    RAISE EXCEPTION 'Retry after lease expiry failed: %', v_claim3;
  END IF;
  v_token2 := v_claim3->>'claim_token';
  IF v_token2 = v_token1 THEN
    RAISE EXCEPTION 'Subsequent claim must receive a distinct token: %', v_claim3;
  END IF;
  IF (v_claim3->>'lease_generation')::int <> 2 THEN
    RAISE EXCEPTION 'Lease generation must increment to 2: %', v_claim3;
  END IF;

  -- 10. Stale worker trying to apply with old token1 is FENCED OUT
  v_stale_apply := public.pooldocai_apply_and_finalize_stripe_webhook(v_test_event_id, v_token1, NULL, NULL, NULL, NULL, true);
  IF (v_stale_apply->>'success')::boolean <> false OR (v_stale_apply->>'status') <> 'fenced_out' THEN
    RAISE EXCEPTION 'Stale worker with token1 must be fenced out: %', v_stale_apply;
  END IF;

  -- 11. Stale worker trying to release with old token1 is FENCED OUT
  v_stale_release := public.pooldocai_release_stripe_webhook_event(v_test_event_id, v_token1, 'Stale failure');
  IF (v_stale_release->>'success')::boolean <> false OR (v_stale_release->>'status') <> 'fenced_out' THEN
    RAISE EXCEPTION 'Stale worker release with token1 must be fenced out: %', v_stale_release;
  END IF;

  -- 12. Active worker with valid token2 successfully applies and finalizes
  v_valid_apply := public.pooldocai_apply_and_finalize_stripe_webhook(v_test_event_id, v_token2, NULL, NULL, NULL, 'Legitimate processing note', true);
  IF (v_valid_apply->>'success')::boolean <> true OR (v_valid_apply->>'processed')::boolean <> true THEN
    RAISE EXCEPTION 'Active worker finalization failed: %', v_valid_apply;
  END IF;

  -- 13. Subsequent deliveries of fully processed event return already_processed (idempotent)
  v_claim4 := public.pooldocai_claim_stripe_webhook_event(v_test_event_id, 'customer.subscription.updated', 60, 5);
  IF (v_claim4->>'status') <> 'already_processed' OR (v_claim4->>'duplicate')::boolean <> true THEN
    RAISE EXCEPTION 'Processed event was not acknowledged idempotently: %', v_claim4;
  END IF;

  -- 14. Test bounded attempts: simulate 5 failed attempts on a new event
  v_test_event_id := 'evt_ci_max_attempts_' || md5(clock_timestamp()::text || random()::text);
  INSERT INTO public.pooldocai_stripe_webhook_events (stripe_event_id, event_type, processed, attempts, claimed_at)
  VALUES (v_test_event_id, 'invoice.payment_failed', false, 5, clock_timestamp() - interval '70 seconds');

  v_claim5 := public.pooldocai_claim_stripe_webhook_event(v_test_event_id, 'invoice.payment_failed', 60, 5);
  IF (v_claim5->>'status') <> 'max_attempts_exceeded' THEN
    RAISE EXCEPTION 'Max attempts exceeded was not enforced: %', v_claim5;
  END IF;

  -- 15. Migration 035: Company row lock and conditional ordering guard
  INSERT INTO public.companies (id, name, status, plan_name, seat_limit, billing_status, billing_period_start)
  VALUES (v_test_company_id, 'SQL Security Guard Test Co', 'active', 'pro_complete', 5, 'active', '2026-03-01T00:00:00Z');

  v_claim_stale := public.pooldocai_claim_stripe_webhook_event(v_test_event_stale, 'customer.subscription.updated', 60, 5);
  IF (v_claim_stale->>'status') <> 'claimed' THEN
    RAISE EXCEPTION 'Claim for stale ordering test event failed: %', v_claim_stale;
  END IF;

  -- Attempt to apply older February update to company with March period start
  v_res_stale := public.pooldocai_apply_and_finalize_stripe_webhook(
    v_test_event_stale,
    v_claim_stale->>'claim_token',
    v_test_company_id,
    '{"plan_name": "solo_tech", "billing_status": "active", "billing_period_start": "2026-02-01T00:00:00Z"}'::jsonb,
    NULL,
    NULL,
    false
  );

  IF (v_res_stale->>'success')::boolean <> true
     OR (v_res_stale->>'status') <> 'ignored'
     OR (v_res_stale->>'reason') <> 'stale_out_of_order_event' THEN
    RAISE EXCEPTION 'Database-side ordering guard failed to ignore stale event: %', v_res_stale;
  END IF;

  SELECT plan_name, billing_period_start INTO v_company_rec FROM public.companies WHERE id = v_test_company_id;
  IF v_company_rec.plan_name <> 'pro_complete' OR v_company_rec.billing_period_start <> '2026-03-01 00:00:00+00'::timestamptz THEN
    RAISE EXCEPTION 'Company state was corrupted by stale out-of-order event: %', v_company_rec;
  END IF;

  -- 16. Migration 036: Event provenance validation and old invoice protection against replacement subscription
  UPDATE public.companies
  SET stripe_subscription_id = 'sub_replacement_b',
      plan_name = 'enterprise',
      billing_status = 'active',
      billing_period_start = '2026-03-15T00:00:00Z'
  WHERE id = v_test_company_id;

  v_claim_inv_a := public.pooldocai_claim_stripe_webhook_event(v_test_event_inv_a, 'invoice.payment_failed', 60, 5);
  IF (v_claim_inv_a->>'status') <> 'claimed' THEN
    RAISE EXCEPTION 'Claim for invoice test event failed: %', v_claim_inv_a;
  END IF;

  -- Attempt to apply old failed invoice belonging to superseded sub_initial_a
  v_res_inv_a := public.pooldocai_apply_and_finalize_stripe_webhook(
    v_test_event_inv_a,
    v_claim_inv_a->>'claim_token',
    v_test_company_id,
    '{"billing_status": "past_due"}'::jsonb,
    NULL,
    NULL,
    false,
    '{"subscription_id": "sub_initial_a", "period_start": "2026-02-15T00:00:00Z", "event_type": "invoice.payment_failed"}'::jsonb
  );

  IF (v_res_inv_a->>'success')::boolean <> true
     OR (v_res_inv_a->>'status') <> 'ignored'
     OR (v_res_inv_a->>'reason') <> 'stale_old_subscription_invoice' THEN
    RAISE EXCEPTION 'Old subscription invoice was not safely ignored: %', v_res_inv_a;
  END IF;

  SELECT billing_status, stripe_subscription_id INTO v_company_rec FROM public.companies WHERE id = v_test_company_id;
  IF v_company_rec.billing_status <> 'active' OR v_company_rec.stripe_subscription_id <> 'sub_replacement_b' THEN
    RAISE EXCEPTION 'Old subscription invoice corrupted active replacement subscription: %', v_company_rec;
  END IF;

  -- Verify missing invoice provenance on tenant with active subscription fails closed
  v_claim_inv_bad := public.pooldocai_claim_stripe_webhook_event(v_test_event_inv_bad, 'invoice.payment_failed', 60, 5);
  v_res_inv_bad := public.pooldocai_apply_and_finalize_stripe_webhook(
    v_test_event_inv_bad,
    v_claim_inv_bad->>'claim_token',
    v_test_company_id,
    '{"billing_status": "past_due"}'::jsonb,
    NULL,
    NULL,
    false,
    '{"event_type": "invoice.payment_failed"}'::jsonb -- missing subscription_id and period_start
  );

  IF (v_res_inv_bad->>'success')::boolean <> false
     OR (v_res_inv_bad->>'status') <> 'missing_invoice_provenance' THEN
    RAISE EXCEPTION 'Invoice with missing provenance did not fail closed: %', v_res_inv_bad;
  END IF;

  -- 17. Migration 037: Strict invoice subscription provenance & same-period event ordering
  -- Permutation A: Missing subscription ID with present period fails closed
  v_claim_inv_nosub := public.pooldocai_claim_stripe_webhook_event(v_test_event_inv_nosub, 'invoice.payment_failed', 60, 5);
  v_res_inv_nosub := public.pooldocai_apply_and_finalize_stripe_webhook(
    v_test_event_inv_nosub,
    v_claim_inv_nosub->>'claim_token',
    v_test_company_id,
    '{"billing_status": "past_due"}'::jsonb,
    NULL,
    NULL,
    false,
    '{"period_start": "2026-03-15T00:00:00Z", "event_type": "invoice.payment_failed"}'::jsonb
  );

  IF (v_res_inv_nosub->>'success')::boolean <> false
     OR (v_res_inv_nosub->>'status') <> 'missing_invoice_provenance' THEN
    RAISE EXCEPTION 'Invoice with missing subscription ID did not fail closed: %', v_res_inv_nosub;
  END IF;

  -- Permutation B: Same-subscription same-period invoice ordering (P1 Blocker 2)
  -- 1. Payment succeeded at 12:05:00 applies and records last_billing_event_created
  v_claim_same_paid := public.pooldocai_claim_stripe_webhook_event(v_test_event_same_paid, 'invoice.payment_succeeded', 60, 5);
  v_res_same_paid := public.pooldocai_apply_and_finalize_stripe_webhook(
    v_test_event_same_paid,
    v_claim_same_paid->>'claim_token',
    v_test_company_id,
    '{"billing_status": "active"}'::jsonb,
    NULL,
    NULL,
    false,
    '{"subscription_id": "sub_replacement_b", "period_start": "2026-03-15T00:00:00Z", "event_type": "invoice.payment_succeeded", "event_created": "2026-03-20T12:05:00Z"}'::jsonb
  );

  IF (v_res_same_paid->>'success')::boolean <> true
     OR (v_res_same_paid->>'status') <> 'applied' THEN
    RAISE EXCEPTION 'Payment succeeded in same period failed to apply: %', v_res_same_paid;
  END IF;

  SELECT billing_status, last_billing_event_created INTO v_company_rec FROM public.companies WHERE id = v_test_company_id;
  IF v_company_rec.billing_status <> 'active' OR v_company_rec.last_billing_event_created <> '2026-03-20 12:05:00+00'::timestamptz THEN
    RAISE EXCEPTION 'Company state not updated with event timestamp: %', v_company_rec;
  END IF;

  -- 2. Delayed payment failed at 12:00:00 (older) arrives for same sub & period: MUST BE IGNORED
  v_claim_same_fail := public.pooldocai_claim_stripe_webhook_event(v_test_event_same_fail, 'invoice.payment_failed', 60, 5);
  v_res_same_fail := public.pooldocai_apply_and_finalize_stripe_webhook(
    v_test_event_same_fail,
    v_claim_same_fail->>'claim_token',
    v_test_company_id,
    '{"billing_status": "past_due"}'::jsonb,
    NULL,
    NULL,
    false,
    '{"subscription_id": "sub_replacement_b", "period_start": "2026-03-15T00:00:00Z", "event_type": "invoice.payment_failed", "event_created": "2026-03-20T12:00:00Z"}'::jsonb
  );

  IF (v_res_same_fail->>'success')::boolean <> true
     OR (v_res_same_fail->>'status') <> 'ignored'
     OR (v_res_same_fail->>'reason') <> 'stale_out_of_order_invoice' THEN
    RAISE EXCEPTION 'Older payment failure in same period was not safely ignored: %', v_res_same_fail;
  END IF;

  SELECT billing_status INTO v_company_rec FROM public.companies WHERE id = v_test_company_id;
  IF v_company_rec.billing_status <> 'active' THEN
    RAISE EXCEPTION 'Delayed failure corrupted active billing status: %', v_company_rec;
  END IF;

  -- 3. Newer payment failure at 12:10:00 arrives: MUST APPLY
  v_claim_same_newer := public.pooldocai_claim_stripe_webhook_event(v_test_event_same_newer, 'invoice.payment_failed', 60, 5);
  v_res_same_newer := public.pooldocai_apply_and_finalize_stripe_webhook(
    v_test_event_same_newer,
    v_claim_same_newer->>'claim_token',
    v_test_company_id,
    '{"billing_status": "past_due"}'::jsonb,
    NULL,
    NULL,
    false,
    '{"subscription_id": "sub_replacement_b", "period_start": "2026-03-15T00:00:00Z", "event_type": "invoice.payment_failed", "event_created": "2026-03-20T12:10:00Z"}'::jsonb
  );

  IF (v_res_same_newer->>'success')::boolean <> true
     OR (v_res_same_newer->>'status') <> 'applied' THEN
    RAISE EXCEPTION 'Newer payment failure in same period failed to apply: %', v_res_same_newer;
  END IF;

  SELECT billing_status INTO v_company_rec FROM public.companies WHERE id = v_test_company_id;
  IF v_company_rec.billing_status <> 'past_due' THEN
    RAISE EXCEPTION 'Newer failure did not transition company to past_due: %', v_company_rec;
  END IF;

  -- 4. Recovery payment succeeded at 12:15:00 arrives: RESTORES ACTIVE
  v_claim_same_rec := public.pooldocai_claim_stripe_webhook_event(v_test_event_same_rec, 'invoice.payment_succeeded', 60, 5);
  v_res_same_rec := public.pooldocai_apply_and_finalize_stripe_webhook(
    v_test_event_same_rec,
    v_claim_same_rec->>'claim_token',
    v_test_company_id,
    '{"billing_status": "active"}'::jsonb,
    NULL,
    NULL,
    false,
    '{"subscription_id": "sub_replacement_b", "period_start": "2026-03-15T00:00:00Z", "event_type": "invoice.payment_succeeded", "event_created": "2026-03-20T12:15:00Z"}'::jsonb
  );

  IF (v_res_same_rec->>'success')::boolean <> true
     OR (v_res_same_rec->>'status') <> 'applied' THEN
    RAISE EXCEPTION 'Recovery payment in same period failed to apply: %', v_res_same_rec;
  END IF;

  SELECT billing_status INTO v_company_rec FROM public.companies WHERE id = v_test_company_id;
  IF v_company_rec.billing_status <> 'active' THEN
    RAISE EXCEPTION 'Recovery payment did not restore active status: %', v_company_rec;
  END IF;

  -- Clean up test company and test events
  DELETE FROM public.companies WHERE id = v_test_company_id;
  DELETE FROM public.pooldocai_stripe_webhook_events WHERE stripe_event_id LIKE 'evt_ci_%';
END $$;

-- Security Review: Strict learning approval metadata, cross-tenant denial, and public_demo quarantine
DO $$
DECLARE
  v_admin_id uuid := '00000000-0000-0000-0000-000000000001'::uuid;
  v_co_a uuid := '11111111-1111-1111-1111-111111111111'::uuid;
  v_co_b uuid := '22222222-2222-2222-2222-222222222222'::uuid;
  v_manual_a uuid := gen_random_uuid();
  v_manual_b uuid := gen_random_uuid();
  v_manual_revoked uuid := gen_random_uuid();
  v_queue_public uuid := gen_random_uuid();
  v_queue_manual_a uuid := gen_random_uuid();
  v_queue_cross uuid := gen_random_uuid();
  v_queue_revoked uuid := gen_random_uuid();
  v_case_test uuid := gen_random_uuid();
  v_case_unverified uuid := gen_random_uuid();
  v_queue_unverified uuid := gen_random_uuid();
  v_err_msg text;
  v_pub_rec public.shared_learning_knowledge%ROWTYPE;
BEGIN
  -- 0. Setup admin user for rights attestation and learning approval
  INSERT INTO auth.users (id, email, aud, role)
  VALUES (v_admin_id, 'ci-admin@example.com', 'authenticated', 'authenticated')
  ON CONFLICT (id) DO NOTHING;

  -- 1. Setup companies
  INSERT INTO public.companies (id, name, diagnostic_learning_opt_in)
  VALUES
    (v_co_a, 'Company A Test', true),
    (v_co_b, 'Company B Test', true)
  ON CONFLICT (id) DO UPDATE SET diagnostic_learning_opt_in = true;

  -- 2. Setup manuals with equipment provenance metadata and required rights attestation
  INSERT INTO public.company_manuals (
    id, company_id, title, storage_path, shared_learning_opt_in,
    equipment_category, manufacturer_normalized, model_normalized,
    knowledge_scope, general_learning_rights_attested,
    rights_attested_at, rights_attested_by
  )
  VALUES
    (v_manual_a, v_co_a, 'Pentair IntelliFlo Manual', 'test/path/a', true, 'pump', 'pentair', 'intelliflo_vsf', 'general_candidate', true, now(), v_admin_id),
    (v_manual_b, v_co_b, 'Hayward SuperPump Manual', 'test/path/b', true, 'pump', 'hayward', 'super_pump', 'general_candidate', true, now(), v_admin_id),
    (v_manual_revoked, v_co_a, 'Revoked Consent Manual', 'test/path/revoked', false, 'pump', 'pentair', 'intelliflo_vsf', 'company_private', false, now(), v_admin_id)
  ON CONFLICT (id) DO NOTHING;

  -- 2b. Setup a valid diagnostic case to satisfy foreign key on learning_review_queue
  INSERT INTO public.diagnostic_cases (
    id, tenant_id, case_status, technician_verified, case_learning_opt_in,
    learning_terms_version, equipment_category, resolution_summary_redacted
  )
  VALUES (
    v_case_test, v_co_a, 'resolved', true, true,
    '2026-10-v1', 'pump', 'Verified procedure completed successfully'
  );

  -- 3. TEST P0-3: public_demo approval MUST be rejected
  INSERT INTO public.learning_review_queue (id, case_id, tenant_id, source_kind, proposed_lesson_redacted, supporting_source_ids, status)
  VALUES (v_queue_public, v_case_test, NULL, 'public_demo', 'Public demo visitor fix advice here for testing.', '{}', 'pending');

  BEGIN
    PERFORM public.pooldocai_approve_learning_case(v_queue_public, 'Cleaned lesson', v_admin_id, 'Reviewer signoff');
    RAISE EXCEPTION 'public_demo approval unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    v_err_msg := SQLERRM;
    IF v_err_msg NOT LIKE '%Public demo visitor-reported answers cannot be published%' THEN
      RAISE EXCEPTION 'Unexpected error message on public_demo approval: %', v_err_msg;
    END IF;
  END;

  -- 4. TEST P0-4: Consented company_manual approval populates non-null provenance metadata
  INSERT INTO public.learning_review_queue (id, case_id, tenant_id, source_kind, proposed_lesson_redacted, supporting_source_ids, status)
  VALUES (v_queue_manual_a, v_case_test, v_co_a, 'company_manual', 'Pentair IntelliFlo drive replacement procedure text.', ARRAY[v_manual_a::text, (v_manual_a::text || '#chunk-0')], 'pending');

  PERFORM public.pooldocai_approve_learning_case(v_queue_manual_a, 'Pentair IntelliFlo drive replacement approved lesson', v_admin_id, 'Senior tech signoff');

  SELECT * INTO v_pub_rec FROM public.shared_learning_knowledge WHERE source_queue_id = v_queue_manual_a;
  IF v_pub_rec.equipment_category <> 'pump'
     OR v_pub_rec.manufacturer_normalized <> 'pentair'
     OR v_pub_rec.model_normalized <> 'intelliflo_vsf' THEN
    RAISE EXCEPTION 'Consented manual publication lost equipment metadata: category=%, make=%, model=%',
      v_pub_rec.equipment_category, v_pub_rec.manufacturer_normalized, v_pub_rec.model_normalized;
  END IF;

  -- 5. TEST P0-4: Cross-tenant manual approval MUST FAIL CLOSED
  -- Tenant A queue item attempting to cite Tenant B manual
  INSERT INTO public.learning_review_queue (id, case_id, tenant_id, source_kind, proposed_lesson_redacted, supporting_source_ids, status)
  VALUES (v_queue_cross, v_case_test, v_co_a, 'company_manual', 'Attempting cross-tenant manual publication.', ARRAY[v_manual_b::text, (v_manual_b::text || '#chunk-0')], 'pending');

  BEGIN
    PERFORM public.pooldocai_approve_learning_case(v_queue_cross, 'Cross tenant lesson', v_admin_id, 'Signoff');
    RAISE EXCEPTION 'Cross-tenant manual approval unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    v_err_msg := SQLERRM;
    IF v_err_msg NOT LIKE '%not found or does not belong to tenant%' THEN
      RAISE EXCEPTION 'Unexpected error on cross-tenant manual approval: %', v_err_msg;
    END IF;
  END;

  -- 6. TEST P0-4: Manual consent withdrawal MUST reject approval
  INSERT INTO public.learning_review_queue (id, case_id, tenant_id, source_kind, proposed_lesson_redacted, supporting_source_ids, status)
  VALUES (v_queue_revoked, v_case_test, v_co_a, 'company_manual', 'Revoked consent manual lesson.', ARRAY[v_manual_revoked::text], 'pending');

  BEGIN
    PERFORM public.pooldocai_approve_learning_case(v_queue_revoked, 'Revoked lesson', v_admin_id, 'Signoff');
    RAISE EXCEPTION 'Revoked manual approval unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    v_err_msg := SQLERRM;
    IF v_err_msg NOT LIKE '%Source company manual opt-in consent is missing or revoked%' THEN
      RAISE EXCEPTION 'Unexpected error on revoked manual approval: %', v_err_msg;
    END IF;
  END;

  -- 7. TEST P0: Unverified technician case MUST be rejected
  INSERT INTO public.diagnostic_cases (
    id, tenant_id, case_status, technician_verified, case_learning_opt_in,
    learning_terms_version, equipment_category, resolution_summary_redacted,
    contributor_user_id, contributor_accepted_at
  )
  VALUES (
    v_case_unverified, v_co_a, 'resolved', false, true,
    '2026-10-v1', 'pump', '',
    v_admin_id, now()
  );

  INSERT INTO public.case_learning_consents (
    case_id, company_id, actor_user_id, purpose, terms_version, consent_status
  ) VALUES (
    v_case_unverified, v_co_a, v_admin_id, 'case_learning_sharing', '2026-10-v1', 'granted'
  );

  INSERT INTO public.learning_review_queue (id, case_id, tenant_id, source_kind, proposed_lesson_redacted, supporting_source_ids, status)
  VALUES (v_queue_unverified, v_case_unverified, v_co_a, 'technician_job', 'Unverified technician note.', '{}', 'pending');

  BEGIN
    PERFORM public.pooldocai_approve_learning_case(v_queue_unverified, 'Unverified lesson', v_admin_id, 'Signoff');
    RAISE EXCEPTION 'Unverified technician case approval unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    v_err_msg := SQLERRM;
    IF v_err_msg NOT LIKE '%Only a resolved technician-verified case%' THEN
      RAISE EXCEPTION 'Unexpected error on unverified case approval: %', v_err_msg;
    END IF;
  END;

  -- Cleanup test rows
  DELETE FROM public.case_learning_consents WHERE case_id IN (v_case_test, v_case_unverified);
  DELETE FROM public.shared_learning_knowledge WHERE source_queue_id IN (v_queue_public, v_queue_manual_a, v_queue_cross, v_queue_revoked, v_queue_unverified);
  DELETE FROM public.learning_review_queue WHERE id IN (v_queue_public, v_queue_manual_a, v_queue_cross, v_queue_revoked, v_queue_unverified);
  DELETE FROM public.diagnostic_cases WHERE id IN (v_case_test, v_case_unverified);
  DELETE FROM public.company_manuals WHERE id IN (v_manual_a, v_manual_b, v_manual_revoked);
  DELETE FROM public.companies WHERE id IN (v_co_a, v_co_b);
  DELETE FROM auth.users WHERE id = v_admin_id;
END $$;

-- 8. TEST TASK-005 PART-7: Company Manual Search RPCs Metadata & Isolation Contract
DO $$
DECLARE
  v_co_a uuid := gen_random_uuid();
  v_co_b uuid := gen_random_uuid();
  v_man_a1 uuid := gen_random_uuid();
  v_man_a2 uuid := gen_random_uuid();
  v_man_disabled uuid := gen_random_uuid();
  v_man_pending uuid := gen_random_uuid();
  v_man_b uuid := gen_random_uuid();
  v_chk_a1 uuid := gen_random_uuid();
  v_chk_a2 uuid := gen_random_uuid();
  v_chk_disabled uuid := gen_random_uuid();
  v_chk_pending uuid := gen_random_uuid();
  v_chk_b uuid := gen_random_uuid();
  v_user_id uuid := gen_random_uuid();
  v_rec record;
  v_cnt integer := 0;
BEGIN
  -- Ensure test user exists for rights attestation foreign key
  INSERT INTO auth.users (id, email, aud, role)
  VALUES (v_user_id, 'ci-part7@example.com', 'authenticated', 'authenticated')
  ON CONFLICT (id) DO NOTHING;

  -- Ensure 'pool' industry module is active
  INSERT INTO public.industry_modules (industry_key, display_name, status)
  VALUES ('pool', 'Pool Industry', 'active')
  ON CONFLICT (industry_key) DO UPDATE SET status = 'active';

  -- Insert companies
  INSERT INTO public.companies (id, name, industry_key, status)
  VALUES
    (v_co_a, 'Tenant Alpha Part7', 'pool', 'active'),
    (v_co_b, 'Tenant Beta Part7', 'pool', 'active');

  -- 1. Tenant A: Pentair IntelliFlo (enabled, ready)
  INSERT INTO public.company_manuals (
    id, company_id, title, storage_path, document_type, reference_enabled, extraction_status,
    manufacturer_normalized, model_normalized, equipment_category, industry_key,
    rights_attested_at, rights_attested_by, knowledge_scope
  )
  VALUES (
    v_man_a1, v_co_a, 'Pentair IntelliFlo VSF Manual', 'path/a1', 'manual', true, 'ready',
    'pentair', 'intelliflo_vsf', 'pump', 'pool',
    now(), v_user_id, 'company_private'
  );

  INSERT INTO public.company_manual_chunks (id, company_id, manual_id, chunk_index, title, content_text, industry_key)
  VALUES (v_chk_a1, v_co_a, v_man_a1, 0, 'IntelliFlo Troubleshooting', 'Pentair IntelliFlo VSF variable speed pump drive electronics and motor keypad display blank troubleshooting.', 'pool');

  -- 2. Tenant A: Hayward H-Series (enabled, ready, different equipment family)
  INSERT INTO public.company_manuals (
    id, company_id, title, storage_path, document_type, reference_enabled, extraction_status,
    manufacturer_normalized, model_normalized, equipment_category, industry_key,
    rights_attested_at, rights_attested_by, knowledge_scope
  )
  VALUES (
    v_man_a2, v_co_a, 'Hayward Universal H-Series Heater Manual', 'path/a2', 'manual', true, 'ready',
    'hayward', 'h_series', 'heater', 'pool',
    now(), v_user_id, 'company_private'
  );

  INSERT INTO public.company_manual_chunks (id, company_id, manual_id, chunk_index, title, content_text, industry_key)
  VALUES (v_chk_a2, v_co_a, v_man_a2, 0, 'H-Series Heater Lockout', 'Hayward Universal H-Series gas heater ignition lockout IF code displayed and blower vacuum switch.', 'pool');

  -- 3. Tenant A: Disabled reference manual (reference_enabled = false)
  INSERT INTO public.company_manuals (
    id, company_id, title, storage_path, document_type, reference_enabled, extraction_status,
    manufacturer_normalized, model_normalized, equipment_category, industry_key,
    rights_attested_at, rights_attested_by, knowledge_scope
  )
  VALUES (
    v_man_disabled, v_co_a, 'Disabled IntelliFlo Reference', 'path/dis', 'manual', false, 'ready',
    'pentair', 'intelliflo_vsf', 'pump', 'pool',
    now(), v_user_id, 'company_private'
  );

  INSERT INTO public.company_manual_chunks (id, company_id, manual_id, chunk_index, title, content_text, industry_key)
  VALUES (v_chk_disabled, v_co_a, v_man_disabled, 0, 'Disabled Chunk', 'Pentair IntelliFlo VSF disabled reference chunk should never appear in search results.', 'pool');

  -- 4. Tenant A: Pending extraction status (extraction_status = 'queued')
  INSERT INTO public.company_manuals (
    id, company_id, title, storage_path, document_type, reference_enabled, extraction_status,
    manufacturer_normalized, model_normalized, equipment_category, industry_key,
    rights_attested_at, rights_attested_by, knowledge_scope
  )
  VALUES (
    v_man_pending, v_co_a, 'Pending IntelliFlo Reference', 'path/pend', 'manual', true, 'queued',
    'pentair', 'intelliflo_vsf', 'pump', 'pool',
    now(), v_user_id, 'company_private'
  );

  INSERT INTO public.company_manual_chunks (id, company_id, manual_id, chunk_index, title, content_text, industry_key)
  VALUES (v_chk_pending, v_co_a, v_man_pending, 0, 'Pending Chunk', 'Pentair IntelliFlo VSF pending extraction chunk should never appear in search results.', 'pool');

  -- 5. Tenant B: Private Pentair Manual (Tenant B only)
  INSERT INTO public.company_manuals (
    id, company_id, title, storage_path, document_type, reference_enabled, extraction_status,
    manufacturer_normalized, model_normalized, equipment_category, industry_key,
    rights_attested_at, rights_attested_by, knowledge_scope
  )
  VALUES (
    v_man_b, v_co_b, 'Tenant B Pentair IntelliFlo Manual', 'path/b', 'manual', true, 'ready',
    'pentair', 'intelliflo_vsf', 'pump', 'pool',
    now(), v_user_id, 'company_private'
  );

  INSERT INTO public.company_manual_chunks (id, company_id, manual_id, chunk_index, title, content_text, industry_key)
  VALUES (v_chk_b, v_co_b, v_man_b, 0, 'Tenant B Chunk', 'Pentair IntelliFlo VSF private manual belonging strictly to Tenant B.', 'pool');

  -- TEST A: search_company_manual_chunks (Keyword fallback RPC)
  v_cnt := 0;
  FOR v_rec IN SELECT * FROM public.search_company_manual_chunks(v_co_a, 'IntelliFlo', 10) LOOP
    v_cnt := v_cnt + 1;
    -- Must only return Tenant A IntelliFlo enabled ready chunk
    IF v_rec.id <> v_chk_a1 THEN
      RAISE EXCEPTION 'search_company_manual_chunks returned unexpected chunk ID: % (manual_id: %)', v_rec.id, v_rec.manual_id;
    END IF;
    -- Verify metadata columns are populated accurately
    IF v_rec.manufacturer_normalized <> 'pentair'
       OR v_rec.model_normalized <> 'intelliflo_vsf'
       OR v_rec.equipment_category <> 'pump'
       OR v_rec.reference_enabled <> true
       OR v_rec.extraction_status <> 'ready'
       OR v_rec.retrieval_method <> 'keyword' THEN
      RAISE EXCEPTION 'search_company_manual_chunks returned corrupt metadata contract: %', row_to_json(v_rec);
    END IF;
  END LOOP;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'search_company_manual_chunks expected exactly 1 match for Tenant A IntelliFlo, got %', v_cnt;
  END IF;

  -- TEST B: search_company_manual_chunks_hybrid
  v_cnt := 0;
  FOR v_rec IN SELECT * FROM public.search_company_manual_chunks_hybrid(v_co_a, 'IntelliFlo', NULL, 10) LOOP
    v_cnt := v_cnt + 1;
    IF v_rec.id <> v_chk_a1 THEN
      RAISE EXCEPTION 'search_company_manual_chunks_hybrid returned unexpected chunk ID: %', v_rec.id;
    END IF;
    IF v_rec.manufacturer_normalized <> 'pentair'
       OR v_rec.model_normalized <> 'intelliflo_vsf'
       OR v_rec.equipment_category <> 'pump'
       OR v_rec.reference_enabled <> true
       OR v_rec.extraction_status <> 'ready' THEN
      RAISE EXCEPTION 'search_company_manual_chunks_hybrid returned corrupt metadata contract: %', row_to_json(v_rec);
    END IF;
  END LOOP;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'search_company_manual_chunks_hybrid expected exactly 1 match for Tenant A IntelliFlo, got %', v_cnt;
  END IF;

  -- TEST C: Multi-tenant isolation - Tenant B queries IntelliFlo
  v_cnt := 0;
  FOR v_rec IN SELECT * FROM public.search_company_manual_chunks_hybrid(v_co_b, 'IntelliFlo', NULL, 10) LOOP
    v_cnt := v_cnt + 1;
    -- Must only see Tenant B chunk
    IF v_rec.id <> v_chk_b THEN
      RAISE EXCEPTION 'Cross-tenant leak: Tenant B search returned chunk from another tenant: %', v_rec.id;
    END IF;
  END LOOP;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'Tenant B search expected exactly 1 match, got %', v_cnt;
  END IF;

  -- Cleanup Part-7 test data
  DELETE FROM public.company_manual_chunks WHERE id IN (v_chk_a1, v_chk_a2, v_chk_disabled, v_chk_pending, v_chk_b);
  DELETE FROM public.company_manuals WHERE id IN (v_man_a1, v_man_a2, v_man_disabled, v_man_pending, v_man_b);
  DELETE FROM public.companies WHERE id IN (v_co_a, v_co_b);
  DELETE FROM auth.users WHERE id = v_user_id;
END $$;

-- 9. TEST TASK-005 PART-7 FOLLOW-UP: Active Company Status Enforcement in Search RPCs
DO $$
DECLARE
  v_co_active uuid := gen_random_uuid();
  v_co_suspended uuid := gen_random_uuid();
  v_user_id uuid := gen_random_uuid();
  v_man_active uuid := gen_random_uuid();
  v_man_suspended uuid := gen_random_uuid();
  v_chk_active uuid := gen_random_uuid();
  v_chk_suspended uuid := gen_random_uuid();
  v_rec record;
  v_cnt integer := 0;
BEGIN
  -- Setup test user for rights attestation FK
  INSERT INTO auth.users (id, email, aud, role)
  VALUES (v_user_id, 'ci-active-status@example.com', 'authenticated', 'authenticated')
  ON CONFLICT (id) DO NOTHING;

  -- Ensure active 'pool' industry module
  INSERT INTO public.industry_modules (industry_key, display_name, status)
  VALUES ('pool', 'Pool Industry', 'active')
  ON CONFLICT (industry_key) DO UPDATE SET status = 'active';

  -- Create one active company and one suspended company
  INSERT INTO public.companies (id, name, industry_key, status)
  VALUES
    (v_co_active, 'Active Company Test', 'pool', 'active'),
    (v_co_suspended, 'Suspended Company Test', 'pool', 'suspended');

  -- Create matching valid manuals for both companies
  INSERT INTO public.company_manuals (
    id, company_id, title, storage_path, document_type, reference_enabled, extraction_status,
    manufacturer_normalized, model_normalized, equipment_category, industry_key,
    rights_attested_at, rights_attested_by, knowledge_scope
  )
  VALUES
    (v_man_active, v_co_active, 'Active Pentair IntelliFlo Manual', 'path/act', 'manual', true, 'ready',
     'pentair', 'intelliflo_vsf', 'pump', 'pool', now(), v_user_id, 'company_private'),
    (v_man_suspended, v_co_suspended, 'Suspended Pentair IntelliFlo Manual', 'path/susp', 'manual', true, 'ready',
     'pentair', 'intelliflo_vsf', 'pump', 'pool', now(), v_user_id, 'company_private');

  -- Create chunks for both
  INSERT INTO public.company_manual_chunks (id, company_id, manual_id, chunk_index, title, content_text, industry_key)
  VALUES
    (v_chk_active, v_co_active, v_man_active, 0, 'Active Chunk', 'Active tenant Pentair IntelliFlo troubleshooting procedures.', 'pool'),
    (v_chk_suspended, v_co_suspended, v_man_suspended, 0, 'Suspended Chunk', 'Suspended tenant Pentair IntelliFlo troubleshooting procedures.', 'pool');

  -- 1. Verify Active Company returns results for both keyword and hybrid search
  v_cnt := 0;
  FOR v_rec IN SELECT * FROM public.search_company_manual_chunks(v_co_active, 'IntelliFlo', 10) LOOP
    v_cnt := v_cnt + 1;
  END LOOP;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'Active company search_company_manual_chunks expected 1 row, got %', v_cnt;
  END IF;

  v_cnt := 0;
  FOR v_rec IN SELECT * FROM public.search_company_manual_chunks_hybrid(v_co_active, 'IntelliFlo', NULL, 10) LOOP
    v_cnt := v_cnt + 1;
  END LOOP;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'Active company search_company_manual_chunks_hybrid expected 1 row, got %', v_cnt;
  END IF;

  -- 2. Verify Suspended Company returns ZERO results for both keyword and hybrid search
  v_cnt := 0;
  FOR v_rec IN SELECT * FROM public.search_company_manual_chunks(v_co_suspended, 'IntelliFlo', 10) LOOP
    v_cnt := v_cnt + 1;
  END LOOP;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'Suspended company search_company_manual_chunks leaked rows: got %', v_cnt;
  END IF;

  v_cnt := 0;
  FOR v_rec IN SELECT * FROM public.search_company_manual_chunks_hybrid(v_co_suspended, 'IntelliFlo', NULL, 10) LOOP
    v_cnt := v_cnt + 1;
  END LOOP;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'Suspended company search_company_manual_chunks_hybrid leaked rows: got %', v_cnt;
  END IF;

  -- Teardown Section 9 test fixtures
  DELETE FROM public.company_manual_chunks WHERE id IN (v_chk_active, v_chk_suspended);
  DELETE FROM public.company_manuals WHERE id IN (v_man_active, v_man_suspended);
  DELETE FROM public.companies WHERE id IN (v_co_active, v_co_suspended);
  DELETE FROM auth.users WHERE id = v_user_id;
END $$;

-- 10. TEST TASK-007 PART-1: Company Notifications & Delivery Foundation
DO $$
DECLARE
  v_co_a uuid := gen_random_uuid();
  v_co_b uuid := gen_random_uuid();
  v_user_a_admin uuid := gen_random_uuid();
  v_user_a_tech uuid := gen_random_uuid();
  v_user_a_susp uuid := gen_random_uuid();
  v_user_b_admin uuid := gen_random_uuid();
  v_notif_1 uuid;
  v_notif_2 uuid;
  v_notif_dup uuid;
  v_notif_admin uuid;
  v_notif_pref uuid;
  v_user_notif_id uuid;
  v_cnt integer := 0;
  v_read_at timestamptz;
  v_ok boolean;
  v_res_a jsonb;
  v_res_b jsonb;
  v_sr_id uuid := gen_random_uuid();
  v_reconciled integer := 0;
BEGIN
  -- Setup test users
  INSERT INTO auth.users (id, email, aud, role)
  VALUES
    (v_user_a_admin, 'ci-notif-a-admin@example.com', 'authenticated', 'authenticated'),
    (v_user_a_tech, 'ci-notif-a-tech@example.com', 'authenticated', 'authenticated'),
    (v_user_a_susp, 'ci-notif-a-susp@example.com', 'authenticated', 'authenticated'),
    (v_user_b_admin, 'ci-notif-b-admin@example.com', 'authenticated', 'authenticated')
  ON CONFLICT (id) DO NOTHING;

  -- Create companies A and B
  INSERT INTO public.companies (id, name, industry_key, status, seat_limit)
  VALUES
    (v_co_a, 'Company A Notifications Test', 'pool', 'active', 10),
    (v_co_b, 'Company B Notifications Test', 'pool', 'active', 10);

  -- Add company members
  INSERT INTO public.company_members (company_id, user_id, role, status, display_name)
  VALUES
    (v_co_a, v_user_a_admin, 'company_admin', 'active', 'Admin A'),
    (v_co_a, v_user_a_tech, 'technician', 'active', 'Tech A'),
    (v_co_a, v_user_a_susp, 'technician', 'suspended', 'Suspended Tech A'),
    (v_co_b, v_user_b_admin, 'company_admin', 'active', 'Admin B');

  -- 1. Publish notification for Company A targeting 'all'
  v_notif_1 := public.pooldocai_publish_company_notification(
    v_co_a,
    'service_request_created',
    'New Customer Request',
    'Customer requested pump triage',
    '{"request_id": "req-1"}'::jsonb,
    'dedupe-sr-1',
    'all',
    NULL
  );

  IF v_notif_1 IS NULL THEN
    RAISE EXCEPTION 'Failed to publish notification 1';
  END IF;

  -- Verify user notifications created for active members of Company A (Admin A and Tech A), NOT suspended member (Suspended A) or Company B
  SELECT count(*) INTO v_cnt FROM public.user_notifications WHERE notification_id = v_notif_1;
  IF v_cnt <> 2 THEN
    RAISE EXCEPTION 'Expected 2 recipient notifications for notif_1, got %', v_cnt;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.user_notifications WHERE notification_id = v_notif_1 AND user_id = v_user_a_admin) THEN
    RAISE EXCEPTION 'Admin A missing user_notification';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_notifications WHERE notification_id = v_notif_1 AND user_id = v_user_a_tech) THEN
    RAISE EXCEPTION 'Tech A missing user_notification';
  END IF;
  IF EXISTS (SELECT 1 FROM public.user_notifications WHERE notification_id = v_notif_1 AND user_id = v_user_a_susp) THEN
    RAISE EXCEPTION 'Suspended Tech A illegally received user_notification';
  END IF;
  IF EXISTS (SELECT 1 FROM public.user_notifications WHERE notification_id = v_notif_1 AND user_id = v_user_b_admin) THEN
    RAISE EXCEPTION 'Cross-tenant leak: Company B admin received Company A user_notification';
  END IF;

  -- 2. Verify Idempotent publication with same dedupe key does not duplicate recipients
  v_notif_dup := public.pooldocai_publish_company_notification(
    v_co_a,
    'service_request_created',
    'New Customer Request (Updated)',
    'Customer updated pump triage notes',
    '{"request_id": "req-1", "updated": true}'::jsonb,
    'dedupe-sr-1',
    'all',
    NULL
  );
  IF v_notif_dup <> v_notif_1 THEN
    RAISE EXCEPTION 'Expected same notification_id on duplicate publish, got % vs %', v_notif_dup, v_notif_1;
  END IF;

  SELECT count(*) INTO v_cnt FROM public.user_notifications WHERE notification_id = v_notif_1;
  IF v_cnt <> 2 THEN
    RAISE EXCEPTION 'Duplicate publish created duplicate user_notifications: count is %', v_cnt;
  END IF;

  -- 3. Verify targeted technician-only notification
  v_notif_2 := public.pooldocai_publish_company_notification(
    v_co_a,
    'service_request_assigned',
    'Service Request Assigned',
    'You have been assigned to job #42',
    '{"job_id": "job-42"}'::jsonb,
    'dedupe-job-42',
    'assigned_technician',
    v_user_a_tech
  );
  SELECT count(*) INTO v_cnt FROM public.user_notifications WHERE notification_id = v_notif_2;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'Expected exactly 1 targeted recipient for notif_2, got %', v_cnt;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.user_notifications WHERE notification_id = v_notif_2 AND user_id = v_user_a_tech) THEN
    RAISE EXCEPTION 'Targeted Tech A missing notification 2';
  END IF;

  -- 4. Verify Delivery Queue Entries
  SELECT count(*) INTO v_cnt FROM public.notification_delivery_queue WHERE notification_id = v_notif_1 AND channel = 'in_app' AND delivery_status = 'delivered';
  IF v_cnt <> 2 THEN
    RAISE EXCEPTION 'Expected 2 delivered in_app queue records, got %', v_cnt;
  END IF;

  SELECT count(*) INTO v_cnt FROM public.notification_delivery_queue WHERE notification_id = v_notif_1 AND channel = 'email' AND delivery_status = 'pending';
  IF v_cnt <> 2 THEN
    RAISE EXCEPTION 'Expected 2 pending email queue records, got %', v_cnt;
  END IF;

  SELECT count(*) INTO v_cnt FROM public.notification_delivery_queue WHERE notification_id = v_notif_1 AND channel = 'web_push' AND delivery_status = 'deferred';
  IF v_cnt <> 2 THEN
    RAISE EXCEPTION 'Expected 2 deferred web_push queue records, got %', v_cnt;
  END IF;

  -- 5. Test RPC Read State & Marking Read
  SELECT id INTO v_user_notif_id FROM public.user_notifications WHERE notification_id = v_notif_2 AND user_id = v_user_a_tech;

  PERFORM set_config('request.jwt.claim.sub', v_user_a_tech::text, true);
  v_ok := public.pooldocai_mark_notification_read(v_user_notif_id);
  IF NOT v_ok THEN
    RAISE EXCEPTION 'Expected mark_notification_read to return true';
  END IF;

  SELECT read_at INTO v_read_at FROM public.user_notifications WHERE id = v_user_notif_id;
  IF v_read_at IS NULL THEN
    RAISE EXCEPTION 'read_at was not updated by mark_notification_read';
  END IF;

  v_ok := public.pooldocai_mark_notification_read(v_user_notif_id);
  IF v_ok THEN
    RAISE EXCEPTION 'Expected second mark_notification_read to return false';
  END IF;

  -- 6. Test Recipient Spoof Protection: User B cannot mark read User A notification
  SELECT id INTO v_user_notif_id FROM public.user_notifications WHERE notification_id = v_notif_1 AND user_id = v_user_a_admin;
  PERFORM set_config('request.jwt.claim.sub', v_user_b_admin::text, true);
  v_ok := public.pooldocai_mark_notification_read(v_user_notif_id);
  IF v_ok THEN
    RAISE EXCEPTION 'User B illegally marked read User A notification';
  END IF;

  -- 7. Test Recipient Restriction Bypass Prevention on company_notifications
  v_notif_admin := public.pooldocai_publish_company_notification(
    v_co_a,
    'admin_alert',
    'Admin Alert',
    'Confidential admin notification',
    '{"confidential": true}'::jsonb,
    'dedupe-admin-1',
    'admin',
    NULL
  );

  -- Admin A has user_notification and CAN see the event
  PERFORM set_config('request.jwt.claim.sub', v_user_a_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_cnt FROM public.company_notifications WHERE id = v_notif_admin;
  EXECUTE 'RESET ROLE';
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'Admin A should be able to view admin notification, got %', v_cnt;
  END IF;

  -- Tech A has NO user_notification and CANNOT see the event
  PERFORM set_config('request.jwt.claim.sub', v_user_a_tech::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_cnt FROM public.company_notifications WHERE id = v_notif_admin;
  EXECUTE 'RESET ROLE';
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'Tech A illegally viewed admin-only company event via company_notifications';
  END IF;

  -- User B (Company B) CANNOT see the event
  PERFORM set_config('request.jwt.claim.sub', v_user_b_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  SELECT count(*) INTO v_cnt FROM public.company_notifications WHERE id = v_notif_admin;
  EXECUTE 'RESET ROLE';
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'Company B admin illegally viewed Company A event via company_notifications';
  END IF;

  -- 8. Test Composite FK Constraint Preventing Cross-Company Linkage
  PERFORM set_config('request.jwt.claim.sub', '', true);
  BEGIN
    INSERT INTO public.user_notifications (notification_id, company_id, user_id, recipient_role)
    VALUES (v_notif_1, v_co_b, v_user_b_admin, 'company_admin');
    RAISE EXCEPTION 'Cross-company notification linkage unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    -- Expected: composite foreign key prevents cross-tenant linkage
    NULL;
  END;

  -- 9. Test Preference Enforcement on Enqueue
  INSERT INTO public.user_notification_preferences (user_id, company_id, channel, enabled)
  VALUES (v_user_a_tech, v_co_a, 'email', false)
  ON CONFLICT (user_id, company_id, channel) DO UPDATE SET enabled = false;

  v_notif_pref := public.pooldocai_publish_company_notification(
    v_co_a,
    'preference_test',
    'Preference Test',
    'Checking channel preferences',
    '{}'::jsonb,
    'dedupe-pref-1',
    'all',
    NULL
  );

  SELECT count(*) INTO v_cnt FROM public.notification_delivery_queue
  WHERE notification_id = v_notif_pref AND user_id = v_user_a_tech AND channel = 'email' AND delivery_status = 'opted_out';
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'Expected email queue status opted_out for Tech A, got %', v_cnt;
  END IF;

  -- 10. Test Multi-Company User Inbox Isolation
  INSERT INTO public.company_members (company_id, user_id, role, status, display_name)
  VALUES (v_co_b, v_user_a_admin, 'technician', 'active', 'Admin A in Co B');

  PERFORM set_config('request.jwt.claim.sub', v_user_a_admin::text, true);

  v_res_a := public.pooldocai_get_user_notifications(p_company_id := v_co_a);
  IF (v_res_a->>'company_id')::uuid <> v_co_a THEN
    RAISE EXCEPTION 'Expected Company A notifications, got %', v_res_a->>'company_id';
  END IF;

  v_res_b := public.pooldocai_get_user_notifications(p_company_id := v_co_b);
  IF (v_res_b->>'company_id')::uuid <> v_co_b THEN
    RAISE EXCEPTION 'Expected Company B notifications, got %', v_res_b->>'company_id';
  END IF;

  BEGIN
    PERFORM public.pooldocai_get_user_notifications(p_company_id := gen_random_uuid());
    RAISE EXCEPTION 'Expected NOT_A_MEMBER_OF_SPECIFIED_COMPANY exception';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%NOT_A_MEMBER_OF_SPECIFIED_COMPANY%' THEN
      RAISE;
    END IF;
  END;

  -- 11. Test Durable Service Request Outbox Trigger
  PERFORM set_config('request.jwt.claim.sub', '', true);
  INSERT INTO public.service_requests (id, company_id, request_summary, source_type, priority)
  VALUES (v_sr_id, v_co_a, 'Heater temperature sensor error', 'customer_widget', 'high');

  -- Verify notification was created automatically and durably by trigger
  SELECT count(*) INTO v_cnt FROM public.company_notifications
  WHERE company_id = v_co_a AND dedupe_key = 'sr-created-' || v_sr_id::text;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'Durable trigger failed to create company_notification for service request, count=%', v_cnt;
  END IF;

  -- Verify user notifications populated for company admin
  SELECT count(*) INTO v_cnt FROM public.user_notifications
  WHERE company_id = v_co_a AND notification_id = (
    SELECT id FROM public.company_notifications WHERE company_id = v_co_a AND dedupe_key = 'sr-created-' || v_sr_id::text
  );
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'Expected 1 user_notifications from service request trigger, got %', v_cnt;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.user_notifications
    WHERE company_id = v_co_a AND user_id = v_user_a_admin AND notification_id = (
      SELECT id FROM public.company_notifications WHERE company_id = v_co_a AND dedupe_key = 'sr-created-' || v_sr_id::text
    )
  ) THEN
    RAISE EXCEPTION 'Admin A missing user_notification from service request trigger';
  END IF;

  -- 12. Test Service Request Notification Idempotency on Replay
  PERFORM public.pooldocai_publish_company_notification(
    p_company_id := v_co_a,
    p_event_type := 'service_request_created',
    p_title := 'New Customer Service Request',
    p_body := 'Service requested: Heater temperature sensor error',
    p_data := '{"replayed": true}'::jsonb,
    p_dedupe_key := 'sr-created-' || v_sr_id::text,
    p_target_role := 'admin',
    p_target_user_id := NULL
  );

  SELECT count(*) INTO v_cnt FROM public.company_notifications
  WHERE company_id = v_co_a AND dedupe_key = 'sr-created-' || v_sr_id::text;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'Idempotency violation: duplicate company_notification created on replay, count=%', v_cnt;
  END IF;

  -- 13. Test Service Request Notification Reconciliation RPC
  -- Delete notification to simulate a missing alert
  DELETE FROM public.company_notifications WHERE company_id = v_co_a AND dedupe_key = 'sr-created-' || v_sr_id::text;

  v_reconciled := public.pooldocai_reconcile_service_request_notifications(v_co_a, 24);
  IF v_reconciled <> 1 THEN
    RAISE EXCEPTION 'Expected reconcile function to heal 1 missing notification, got %', v_reconciled;
  END IF;

  SELECT count(*) INTO v_cnt FROM public.company_notifications
  WHERE company_id = v_co_a AND dedupe_key = 'sr-created-' || v_sr_id::text;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'Expected reconciled notification to exist, got %', v_cnt;
  END IF;

  -- Second run should be 0 (no-op idempotency)
  v_reconciled := public.pooldocai_reconcile_service_request_notifications(v_co_a, 24);
  IF v_reconciled <> 0 THEN
    RAISE EXCEPTION 'Expected second reconcile run to return 0, got %', v_reconciled;
  END IF;

  -- 14. Test Multi-Company Independent Marking (A vs B) and Fail-Closed Boundary
  -- Publish a notification in Company B targeting technicians so Admin A (who is a technician in Co B from Test 10) has unread notifications
  PERFORM public.pooldocai_publish_company_notification(
    p_company_id := v_co_b,
    p_event_type := 'service_request_created',
    p_title := 'New Co B Service Request',
    p_body := 'Service requested for Co B',
    p_data := '{"company": "B"}'::jsonb,
    p_dedupe_key := 'sr-co-b-test-1',
    p_target_role := 'technician',
    p_target_user_id := NULL
  );

  PERFORM set_config('request.jwt.claim.sub', v_user_a_admin::text, true);

  -- Mark all read for Company A only
  PERFORM public.pooldocai_mark_all_notifications_read(p_company_id := v_co_a);

  v_res_a := public.pooldocai_get_user_notifications(p_company_id := v_co_a);
  IF (v_res_a->>'unread_count')::integer <> 0 THEN
    RAISE EXCEPTION 'Expected 0 unread notifications for Company A, got %', v_res_a->>'unread_count';
  END IF;

  -- Company B must still have unread notifications for Admin A
  v_res_b := public.pooldocai_get_user_notifications(p_company_id := v_co_b);
  IF (v_res_b->>'unread_count')::integer = 0 THEN
    RAISE EXCEPTION 'Expected unread notifications to remain for Company B';
  END IF;

  -- Now mark all read for Company B
  PERFORM public.pooldocai_mark_all_notifications_read(p_company_id := v_co_b);
  v_res_b := public.pooldocai_get_user_notifications(p_company_id := v_co_b);
  IF (v_res_b->>'unread_count')::integer <> 0 THEN
    RAISE EXCEPTION 'Expected 0 unread notifications for Company B after marking, got %', v_res_b->>'unread_count';
  END IF;

  -- Verify fail-closed behavior: Tech A is NOT in Company B and cannot read Company B notifications
  PERFORM set_config('request.jwt.claim.sub', v_user_a_tech::text, true);
  BEGIN
    PERFORM public.pooldocai_get_user_notifications(p_company_id := v_co_b);
    RAISE EXCEPTION 'Security violation: non-member was allowed to read company B notifications';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%NOT_A_MEMBER_OF_SPECIFIED_COMPANY%' THEN
      RAISE EXCEPTION 'Unexpected error on unauthorized company read: %', SQLERRM;
    END IF;
  END;

  -- Teardown Section 10 test fixtures
  PERFORM set_config('request.jwt.claim.sub', '', true);
  DELETE FROM public.service_requests WHERE company_id IN (v_co_a, v_co_b);
  DELETE FROM public.user_notification_preferences WHERE company_id IN (v_co_a, v_co_b);
  DELETE FROM public.notification_delivery_queue WHERE company_id IN (v_co_a, v_co_b);
  DELETE FROM public.user_notifications WHERE company_id IN (v_co_a, v_co_b);
  DELETE FROM public.company_notifications WHERE company_id IN (v_co_a, v_co_b);
  DELETE FROM public.company_members WHERE company_id IN (v_co_a, v_co_b);
  DELETE FROM public.companies WHERE id IN (v_co_a, v_co_b);
  DELETE FROM auth.users WHERE id IN (v_user_a_admin, v_user_a_tech, v_user_a_susp, v_user_b_admin);
END $$;

-- 11. TEST TASK-007 PART-2: Email Delivery Outbox, Lease Fencing, and Retry Mechanics
DO $$
DECLARE
  v_co_email uuid := gen_random_uuid();
  v_co_inactive uuid := gen_random_uuid();
  v_user_admin uuid := gen_random_uuid();
  v_user_tech uuid := gen_random_uuid();
  v_user_susp uuid := gen_random_uuid();
  v_notif_id uuid;
  v_notif_inactive uuid;
  v_batch_cnt integer := 0;
  v_claimed_q_id uuid;
  v_claimed_idem text;
  v_claimed_email text;
  v_claimed_role text;
  v_claimed_attempts integer;
  v_claimed_lease_token text;
  v_queue_row record;
  v_finish_ok boolean;
  v_stale_claim_cnt integer := 0;
BEGIN
  -- 1. Security Privilege Boundary Checks
  IF has_function_privilege('authenticated', 'public.pooldocai_claim_email_delivery_batch(text, integer, integer)', 'execute') THEN
    RAISE EXCEPTION 'authenticated role illegally has execute privilege on pooldocai_claim_email_delivery_batch';
  END IF;
  IF has_function_privilege('anon', 'public.pooldocai_claim_email_delivery_batch(text, integer, integer)', 'execute') THEN
    RAISE EXCEPTION 'anon role illegally has execute privilege on pooldocai_claim_email_delivery_batch';
  END IF;
  IF has_function_privilege('authenticated', 'public.pooldocai_finish_email_delivery(uuid, text, boolean, text, text, boolean)', 'execute') THEN
    RAISE EXCEPTION 'authenticated role illegally has execute privilege on pooldocai_finish_email_delivery';
  END IF;
  IF has_function_privilege('anon', 'public.pooldocai_finish_email_delivery(uuid, text, boolean, text, text, boolean)', 'execute') THEN
    RAISE EXCEPTION 'anon role illegally has execute privilege on pooldocai_finish_email_delivery';
  END IF;

  -- 2. Setup Test Fixtures: Companies & Users
  INSERT INTO auth.users (id, email, aud, role)
  VALUES
    (v_user_admin, 'ci-email-admin@example.com', 'authenticated', 'authenticated'),
    (v_user_tech, 'ci-email-tech@example.com', 'authenticated', 'authenticated'),
    (v_user_susp, 'ci-email-susp@example.com', 'authenticated', 'authenticated')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.companies (id, name, industry_key, status, seat_limit)
  VALUES
    (v_co_email, 'PoolDocAI Email Delivery Active Co', 'pool', 'active', 5),
    (v_co_inactive, 'PoolDocAI Email Inactive Co', 'pool', 'suspended', 5);

  INSERT INTO public.company_members (company_id, user_id, role, status, display_name)
  VALUES
    (v_co_email, v_user_admin, 'company_admin', 'active', 'Email Admin'),
    (v_co_email, v_user_tech, 'technician', 'active', 'Email Tech'),
    (v_co_email, v_user_susp, 'technician', 'suspended', 'Suspended Member'),
    (v_co_inactive, v_user_admin, 'company_admin', 'active', 'Inactive Co Admin');

  -- 3. Publish Notification for Active Company targeting 'all'
  v_notif_id := public.pooldocai_publish_company_notification(
    p_company_id := v_co_email,
    p_event_type := 'service_request_created',
    p_title := 'New Service Request',
    p_body := 'Customer requested pump troubleshooting',
    p_data := '{"sr_id": "sr-email-1"}'::jsonb,
    p_dedupe_key := 'email-batch-test-1',
    p_target_role := 'all',
    p_target_user_id := NULL
  );

  IF v_notif_id IS NULL THEN
    RAISE EXCEPTION 'Failed to publish notification in email delivery test';
  END IF;

  -- Verify delivery queue has 'pending' email items for active members (admin & tech), NOT suspended member
  SELECT count(*) INTO v_batch_cnt
  FROM public.notification_delivery_queue
  WHERE notification_id = v_notif_id AND channel = 'email' AND delivery_status = 'pending';

  IF v_batch_cnt <> 2 THEN
    RAISE EXCEPTION 'Expected 2 pending email queue items for active members, got %', v_batch_cnt;
  END IF;

  -- 4. Test Atomic Claiming (Worker 1) with Per-Claim Unguessable Lease Token
  -- Worker 1 claims batch of size 1
  SELECT queue_id, idempotency_key, recipient_email, recipient_role, attempts, lease_token
  INTO v_claimed_q_id, v_claimed_idem, v_claimed_email, v_claimed_role, v_claimed_attempts, v_claimed_lease_token
  FROM public.pooldocai_claim_email_delivery_batch('worker_ci_1', 1, 120)
  LIMIT 1;

  IF v_claimed_q_id IS NULL THEN
    RAISE EXCEPTION 'Worker 1 failed to claim email delivery batch item';
  END IF;

  IF v_claimed_attempts <> 1 THEN
    RAISE EXCEPTION 'Expected first claim attempt to be 1, got %', v_claimed_attempts;
  END IF;

  IF v_claimed_lease_token IS NULL OR v_claimed_lease_token NOT LIKE 'claim_%' THEN
    RAISE EXCEPTION 'Expected DB-generated per-claim lease token, got %', v_claimed_lease_token;
  END IF;

  IF v_claimed_idem NOT LIKE 'email-' || v_notif_id::text || '-%' THEN
    RAISE EXCEPTION 'Unexpected idempotency key: %', v_claimed_idem;
  END IF;

  -- Verify claimed row is in 'sending' state with the per-claim lease token
  SELECT * INTO v_queue_row FROM public.notification_delivery_queue WHERE id = v_claimed_q_id;
  IF v_queue_row.delivery_status <> 'sending' OR v_queue_row.lease_token <> v_claimed_lease_token OR v_queue_row.leased_at IS NULL THEN
    RAISE EXCEPTION 'Queue row not properly marked sending with per-claim lease token: status=%, token=%', v_queue_row.delivery_status, v_queue_row.lease_token;
  END IF;

  -- 5. Test Concurrency & SKIP LOCKED
  -- Worker 2 claims remaining batch of size 1 (should get the other recipient, with its own unique lease token)
  DECLARE
    v_claimed_q_id_2 uuid;
    v_claimed_lease_token_2 text;
  BEGIN
    SELECT queue_id, lease_token INTO v_claimed_q_id_2, v_claimed_lease_token_2
    FROM public.pooldocai_claim_email_delivery_batch('worker_ci_2', 1, 120)
    LIMIT 1;

    IF v_claimed_q_id_2 IS NULL OR v_claimed_q_id_2 = v_claimed_q_id THEN
      RAISE EXCEPTION 'Worker 2 did not claim distinct unleased item: got % (worker 1 had %)', v_claimed_q_id_2, v_claimed_q_id;
    END IF;

    IF v_claimed_lease_token_2 = v_claimed_lease_token THEN
      RAISE EXCEPTION 'Per-claim lease tokens must be distinct across workers: % vs %', v_claimed_lease_token_2, v_claimed_lease_token;
    END IF;

    -- Now all pending items are leased. Worker 3 should receive 0 rows
    SELECT count(*) INTO v_batch_cnt FROM public.pooldocai_claim_email_delivery_batch('worker_ci_3', 10, 120);
    IF v_batch_cnt <> 0 THEN
      RAISE EXCEPTION 'Expected 0 available rows for Worker 3, got %', v_batch_cnt;
    END IF;

    -- 6. Test Delivery Finalization Success (Worker 1 with exact per-claim lease token)
    v_finish_ok := public.pooldocai_finish_email_delivery(
      p_queue_id := v_claimed_q_id,
      p_lease_token := v_claimed_lease_token,
      p_success := true,
      p_provider_message_id := 'resend_msg_test_001',
      p_error := NULL,
      p_retryable := false
    );

    IF NOT v_finish_ok THEN
      RAISE EXCEPTION 'Expected finish_email_delivery to return true for Worker 1';
    END IF;

    SELECT * INTO v_queue_row FROM public.notification_delivery_queue WHERE id = v_claimed_q_id;
    IF v_queue_row.delivery_status <> 'delivered' OR v_queue_row.provider_message_id <> 'resend_msg_test_001' OR v_queue_row.lease_token IS NOT NULL THEN
      RAISE EXCEPTION 'Delivered row state incorrect: status=%, provider_id=%, lease_token=%', v_queue_row.delivery_status, v_queue_row.provider_message_id, v_queue_row.lease_token;
    END IF;

    -- 7. Test Strict Lease Fencing (Stale / Duplicate Worker Finish)
    -- Worker 1 attempts to re-finalize an already delivered item -> must return false
    v_finish_ok := public.pooldocai_finish_email_delivery(
      p_queue_id := v_claimed_q_id,
      p_lease_token := v_claimed_lease_token,
      p_success := true,
      p_provider_message_id := 'duplicate_send_attempt'
    );
    IF v_finish_ok THEN
      RAISE EXCEPTION 'Stale worker re-finalization unexpectedly succeeded';
    END IF;

    -- Rogue worker with incorrect lease token -> must return false
    v_finish_ok := public.pooldocai_finish_email_delivery(
      p_queue_id := v_claimed_q_id_2,
      p_lease_token := 'rogue_claim_token',
      p_success := true
    );
    IF v_finish_ok THEN
      RAISE EXCEPTION 'Worker with wrong lease token unexpectedly finalized item';
    END IF;

    -- 8. Test Lease Expiration, Stale Reclamation & ABA Prevention
    -- Simulate Worker 2 crashed and its lease timed out (leased 300 seconds ago)
    UPDATE public.notification_delivery_queue
    SET leased_at = now() - interval '300 seconds'
    WHERE id = v_claimed_q_id_2;

    -- Worker 4 claims batch with lease_seconds=60 -> should reclaim v_claimed_q_id_2 with a BRAND-NEW lease token
    DECLARE
      v_claimed_lease_token_4 text;
    BEGIN
      SELECT queue_id, attempts, lease_token INTO v_claimed_q_id, v_claimed_attempts, v_claimed_lease_token_4
      FROM public.pooldocai_claim_email_delivery_batch('worker_ci_4', 1, 60)
      WHERE queue_id = v_claimed_q_id_2;

      IF v_claimed_q_id IS NULL THEN
        RAISE EXCEPTION 'Worker 4 failed to reclaim expired lease item';
      END IF;
      IF v_claimed_attempts <> 2 THEN
        RAISE EXCEPTION 'Expected reclaimed item attempt to increment to 2, got %', v_claimed_attempts;
      END IF;
      IF v_claimed_lease_token_4 = v_claimed_lease_token_2 THEN
        RAISE EXCEPTION 'ABA vulnerability: reclaimed item must receive a fresh distinct lease token';
      END IF;

      -- Stale Worker 2 now tries to finish with its old token after reclamation -> must return false (fenced out)
      v_finish_ok := public.pooldocai_finish_email_delivery(
        p_queue_id := v_claimed_q_id_2,
        p_lease_token := v_claimed_lease_token_2,
        p_success := true
      );
      IF v_finish_ok THEN
        RAISE EXCEPTION 'Expired Worker 2 successfully finalized after another worker reclaimed lease';
      END IF;

      -- 9. Test Retryable Failure with Exponential Backoff (Worker 4 with v_claimed_lease_token_4)
      v_finish_ok := public.pooldocai_finish_email_delivery(
        p_queue_id := v_claimed_q_id_2,
        p_lease_token := v_claimed_lease_token_4,
        p_success := false,
        p_error := 'rate_limited: 429 Too Many Requests',
        p_retryable := true
      );

      IF NOT v_finish_ok THEN
        RAISE EXCEPTION 'Expected retryable finish to return true';
      END IF;

      SELECT * INTO v_queue_row FROM public.notification_delivery_queue WHERE id = v_claimed_q_id_2;
      IF v_queue_row.delivery_status <> 'retrying' OR v_queue_row.next_attempt_at <= now() OR v_queue_row.last_error NOT LIKE 'rate_limited%' THEN
        RAISE EXCEPTION 'Retry state incorrect: status=%, next_attempt_at=%, last_error=%', v_queue_row.delivery_status, v_queue_row.next_attempt_at, v_queue_row.last_error;
      END IF;
    END;

    -- 10. Test Dead-Letter Capping after 5 attempts
    -- Set attempts to 4, next_attempt_at in the past
    UPDATE public.notification_delivery_queue
    SET attempts = 4, next_attempt_at = now() - interval '5 seconds'
    WHERE id = v_claimed_q_id_2;

    DECLARE
      v_claimed_lease_token_5 text;
    BEGIN
      -- Worker 5 claims it (attempts becomes 5)
      SELECT queue_id, attempts, lease_token INTO v_claimed_q_id, v_claimed_attempts, v_claimed_lease_token_5
      FROM public.pooldocai_claim_email_delivery_batch('worker_ci_5', 1, 60)
      WHERE queue_id = v_claimed_q_id_2;

      IF v_claimed_attempts <> 5 THEN
        RAISE EXCEPTION 'Expected 5th attempt on claim, got %', v_claimed_attempts;
      END IF;

      -- Worker 5 reports failure -> must transition to dead_letter even if retryable is true
      v_finish_ok := public.pooldocai_finish_email_delivery(
        p_queue_id := v_claimed_q_id_2,
        p_lease_token := v_claimed_lease_token_5,
        p_success := false,
        p_error := 'persistent_500_upstream',
        p_retryable := true
      );

      SELECT * INTO v_queue_row FROM public.notification_delivery_queue WHERE id = v_claimed_q_id_2;
      IF v_queue_row.delivery_status <> 'dead_letter' THEN
        RAISE EXCEPTION 'Expected dead_letter status after 5 attempts, got %', v_queue_row.delivery_status;
      END IF;
    END;

    -- 11. Test Delivery-Time Opt-Out Suppression
    -- Publish another notification targeting admin
    v_notif_id := public.pooldocai_publish_company_notification(
      p_company_id := v_co_email,
      p_event_type := 'service_request_created',
      p_title := 'Opt-Out Test',
      p_body := 'Checking delivery-time preference check',
      p_dedupe_key := 'email-optout-test-1',
      p_target_role := 'admin'
    );

    -- Admin opts out of email
    INSERT INTO public.user_notification_preferences (user_id, company_id, channel, enabled)
    VALUES (v_user_admin, v_co_email, 'email', false)
    ON CONFLICT (user_id, company_id, channel) DO UPDATE SET enabled = false;

    -- Claim batch -> row should be automatically updated to opted_out by claim function and NOT returned
    SELECT count(*) INTO v_batch_cnt
    FROM public.pooldocai_claim_email_delivery_batch('worker_ci_opt', 10, 60)
    WHERE notification_id = v_notif_id;

    IF v_batch_cnt <> 0 THEN
      RAISE EXCEPTION 'Opted-out recipient was illegally claimed for email delivery';
    END IF;

    SELECT delivery_status INTO v_queue_row.delivery_status
    FROM public.notification_delivery_queue
    WHERE notification_id = v_notif_id AND user_id = v_user_admin AND channel = 'email';

    IF v_queue_row.delivery_status <> 'opted_out' THEN
      RAISE EXCEPTION 'Expected queue row to transition to opted_out at claim time, got %', v_queue_row.delivery_status;
    END IF;

    -- 12. Test Inactive Company & Suspended Member Queue Suppression
    -- Insert a queue item directly pointing to inactive company
    INSERT INTO public.company_notifications (id, company_id, event_type, title, body, dedupe_key)
    VALUES (gen_random_uuid(), v_co_inactive, 'test_event', 'Test', 'Body', 'dedupe-inactive-co')
    RETURNING id INTO v_notif_inactive;

    INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status, next_attempt_at)
    VALUES (v_notif_inactive, v_co_inactive, v_user_admin, 'email', 'pending', now());

    -- Claim -> inactive company row should be marked failed with 'company_inactive_or_suspended'
    PERFORM public.pooldocai_claim_email_delivery_batch('worker_ci_inactive', 10, 60);

    SELECT delivery_status, last_error INTO v_queue_row.delivery_status, v_queue_row.last_error
    FROM public.notification_delivery_queue
    WHERE notification_id = v_notif_inactive AND company_id = v_co_inactive;

    IF v_queue_row.delivery_status <> 'failed' OR v_queue_row.last_error <> 'company_inactive_or_suspended' THEN
      RAISE EXCEPTION 'Expected inactive company queue item to fail with company_inactive_or_suspended, got status=%, error=%', v_queue_row.delivery_status, v_queue_row.last_error;
    END IF;
  END;

  -- 13. Teardown Section 11 Test Fixtures
  DELETE FROM public.notification_delivery_queue WHERE company_id IN (v_co_email, v_co_inactive);
  DELETE FROM public.user_notifications WHERE company_id IN (v_co_email, v_co_inactive);
  DELETE FROM public.company_notifications WHERE company_id IN (v_co_email, v_co_inactive);
  DELETE FROM public.user_notification_preferences WHERE company_id IN (v_co_email, v_co_inactive);
  DELETE FROM public.company_members WHERE company_id IN (v_co_email, v_co_inactive);
  DELETE FROM public.companies WHERE id IN (v_co_email, v_co_inactive);
  DELETE FROM auth.users WHERE id IN (v_user_admin, v_user_tech, v_user_susp);
END $$;


-- ============================================================================
-- SECTION 12: Web Push Delivery Outbox, Device Subscriptions & Lease Fencing (TASK-007 Part-3)
-- ============================================================================
DO $$
DECLARE
  v_co_push uuid := gen_random_uuid();
  v_co_other uuid := gen_random_uuid();
  v_user_admin uuid := gen_random_uuid();
  v_user_tech uuid := gen_random_uuid();
  v_user_other uuid := gen_random_uuid();
  v_sub_id uuid;
  v_sub_id_2 uuid;
  v_unreg_ok boolean;
  v_notif_id uuid;
  v_queue_status text;
  v_queue_provider_id text;
  v_claimed_q_id uuid;
  v_claimed_attempts integer;
  v_claimed_lease_token text;
  v_claimed_subs jsonb;
  v_finish_ok boolean;
  v_sub_status text;
  v_batch_cnt integer;
BEGIN
  -- 1. Create Test Fixtures
  INSERT INTO auth.users (id, email) VALUES
    (v_user_admin, 'admin_push_ci@test.com'),
    (v_user_tech, 'tech_push_ci@test.com'),
    (v_user_other, 'other_push_ci@test.com');

  INSERT INTO public.companies (id, name, status, plan_name, seat_limit) VALUES
    (v_co_push, 'Push Delivery Test Co', 'active', 'Founders Tier', 5),
    (v_co_other, 'Other Push Co', 'active', 'Founders Tier', 5);

  INSERT INTO public.company_members (company_id, user_id, role, status, can_view_job_notes, can_edit_job_notes) VALUES
    (v_co_push, v_user_admin, 'company_admin', 'active', true, true),
    (v_co_push, v_user_tech, 'technician', 'active', true, true),
    (v_co_other, v_user_other, 'technician', 'active', true, true);

  -- 2. Test Device Push Registration RPC
  -- Impersonate tech user
  EXECUTE format('SET LOCAL "request.jwt.claim.sub" = %L', v_user_tech::text);
  EXECUTE 'SET LOCAL "request.jwt.claim.role" = ''authenticated''';

  -- Register tech device 1
  v_sub_id := public.pooldocai_register_push_subscription(
    p_company_id := v_co_push,
    p_endpoint := 'https://fcm.googleapis.com/fcm/send/tech_device_alpha_1',
    p_p256dh := 'p256dh_sample_key_11111111111111111111111111111111111111111111111111111111111111111',
    p_auth := 'auth_secret_sample_key_11111',
    p_user_agent := 'Mozilla/5.0 (Android Chrome PWA)'
  );

  IF v_sub_id IS NULL THEN
    RAISE EXCEPTION 'Failed to register push subscription for tech';
  END IF;

  -- Verify subscription row
  SELECT status INTO v_sub_status FROM public.user_push_subscriptions WHERE id = v_sub_id;
  IF v_sub_status <> 'active' THEN
    RAISE EXCEPTION 'Expected active push subscription status, got %', v_sub_status;
  END IF;

  -- Test Idempotent Key Update / Upsert
  v_sub_id_2 := public.pooldocai_register_push_subscription(
    p_company_id := v_co_push,
    p_endpoint := 'https://fcm.googleapis.com/fcm/send/tech_device_alpha_1',
    p_p256dh := 'p256dh_sample_key_updated_2222222222222222222222222222222222222222222222222222222',
    p_auth := 'auth_secret_sample_key_22222',
    p_user_agent := 'Mozilla/5.0 (Android Chrome PWA v2)'
  );

  IF v_sub_id <> v_sub_id_2 THEN
    RAISE EXCEPTION 'Expected upsert on duplicate endpoint to return same subscription ID';
  END IF;

  -- Register second device for tech (multiple device support)
  PERFORM public.pooldocai_register_push_subscription(
    p_company_id := v_co_push,
    p_endpoint := 'https://fcm.googleapis.com/fcm/send/tech_device_beta_2',
    p_p256dh := 'p256dh_sample_key_beta_22222222222222222222222222222222222222222222222222222222222',
    p_auth := 'auth_secret_sample_key_beta2'
  );

  -- 3. Test Device Unregistration RPC
  v_unreg_ok := public.pooldocai_unregister_push_subscription('https://fcm.googleapis.com/fcm/send/tech_device_beta_2');
  IF NOT v_unreg_ok THEN
    RAISE EXCEPTION 'Failed to unregister push subscription';
  END IF;

  SELECT status INTO v_sub_status FROM public.user_push_subscriptions WHERE endpoint = 'https://fcm.googleapis.com/fcm/send/tech_device_beta_2';
  IF v_sub_status <> 'revoked' THEN
    RAISE EXCEPTION 'Expected revoked status after unregister, got %', v_sub_status;
  END IF;

  -- Reset role to service_role for publishing and claiming
  RESET "request.jwt.claim.sub";
  RESET "request.jwt.claim.role";

  -- 4. Test Notification Publishing with Push Delivery Outbox
  v_notif_id := public.pooldocai_publish_company_notification(
    p_company_id := v_co_push,
    p_event_type := 'service_request_created',
    p_title := 'New Service Request',
    p_body := 'Pump motor replacement required',
    p_dedupe_key := 'push-test-notif-1',
    p_target_role := 'technician'
  );

  -- Tech has an active push subscription -> web_push must be enqueued as 'pending'
  SELECT delivery_status INTO v_queue_status
  FROM public.notification_delivery_queue
  WHERE notification_id = v_notif_id AND user_id = v_user_tech AND channel = 'web_push';

  IF v_queue_status <> 'pending' THEN
    RAISE EXCEPTION 'Expected web_push queue row to be pending for tech with active subscription, got %', v_queue_status;
  END IF;

  -- 5. Test Atomic Batch Claiming with Skip-Locked & Lease Token
  SELECT queue_id, attempts, lease_token, subscriptions
  INTO v_claimed_q_id, v_claimed_attempts, v_claimed_lease_token, v_claimed_subs
  FROM public.pooldocai_claim_push_delivery_batch('worker_ci_push_1', 5, 120)
  WHERE notification_id = v_notif_id;

  IF v_claimed_q_id IS NULL THEN
    RAISE EXCEPTION 'Failed to claim pending web_push queue item';
  END IF;
  IF v_claimed_attempts <> 1 THEN
    RAISE EXCEPTION 'Expected attempts to increment to 1, got %', v_claimed_attempts;
  END IF;
  IF v_claimed_lease_token NOT LIKE 'claim_%' THEN
    RAISE EXCEPTION 'Expected unguessable lease token claim_<uuid>, got %', v_claimed_lease_token;
  END IF;
  IF jsonb_array_length(v_claimed_subs) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly 1 active subscription for tech (since device 2 was revoked), got %', jsonb_array_length(v_claimed_subs);
  END IF;

  -- 6. Test Lease Fencing
  -- Rogue lease token must return false
  v_finish_ok := public.pooldocai_finish_push_delivery(
    p_queue_id := v_claimed_q_id,
    p_lease_token := 'rogue_lease_token',
    p_success := true
  );
  IF v_finish_ok THEN
    RAISE EXCEPTION 'Rogue worker lease token was illegally accepted';
  END IF;

  -- 7. Test 404/410 Auto-Revocation during Delivery Finalization
  -- Finish with success and pass dead endpoint for revocation
  v_finish_ok := public.pooldocai_finish_push_delivery(
    p_queue_id := v_claimed_q_id,
    p_lease_token := v_claimed_lease_token,
    p_success := true,
    p_provider_message_id := 'fcm_receipt_success_123',
    p_revoked_endpoints := ARRAY['https://fcm.googleapis.com/fcm/send/tech_device_alpha_1']
  );

  IF NOT v_finish_ok THEN
    RAISE EXCEPTION 'Valid finish_push_delivery unexpectedly returned false';
  END IF;

  -- Verify delivery status
  SELECT delivery_status, provider_message_id INTO v_queue_status, v_queue_provider_id
  FROM public.notification_delivery_queue WHERE id = v_claimed_q_id;

  IF v_queue_status <> 'delivered' OR v_queue_provider_id <> 'fcm_receipt_success_123' THEN
    RAISE EXCEPTION 'Delivered state incorrect: status=%, provider_id=%', v_queue_status, v_queue_provider_id;
  END IF;

  -- Verify dead endpoint was automatically revoked in user_push_subscriptions
  SELECT status INTO v_sub_status
  FROM public.user_push_subscriptions
  WHERE endpoint = 'https://fcm.googleapis.com/fcm/send/tech_device_alpha_1';

  IF v_sub_status <> 'revoked' THEN
    RAISE EXCEPTION 'Expected endpoint in p_revoked_endpoints to be automatically revoked, got status %', v_sub_status;
  END IF;

  -- 8. Teardown Section 12 Test Fixtures
  DELETE FROM public.user_push_subscriptions WHERE company_id IN (v_co_push, v_co_other);
  DELETE FROM public.notification_delivery_queue WHERE company_id IN (v_co_push, v_co_other);
  DELETE FROM public.user_notifications WHERE company_id IN (v_co_push, v_co_other);
  DELETE FROM public.company_notifications WHERE company_id IN (v_co_push, v_co_other);
  DELETE FROM public.user_notification_preferences WHERE company_id IN (v_co_push, v_co_other);
  DELETE FROM public.company_members WHERE company_id IN (v_co_push, v_co_other);
  DELETE FROM public.companies WHERE id IN (v_co_push, v_co_other);
  DELETE FROM auth.users WHERE id IN (v_user_admin, v_user_tech, v_user_other);
END $$;

-- 13. TEST TASK-012 PART-1: Learning Publication Safety Trust Boundary & Shared Retrieval Predicates
DO $$
DECLARE
  v_co_active uuid := gen_random_uuid();
  v_co_opted_out uuid := gen_random_uuid();
  v_co_other uuid := gen_random_uuid();
  v_admin_id uuid := gen_random_uuid();
  v_tech_user_id uuid := gen_random_uuid();
  v_case_ai_unverified uuid := gen_random_uuid();
  v_queue_ai_unverified uuid := gen_random_uuid();
  v_case_tech_verified uuid := gen_random_uuid();
  v_queue_tech_verified uuid := gen_random_uuid();
  v_case_unresolved uuid := gen_random_uuid();
  v_queue_unresolved uuid := gen_random_uuid();
  v_case_cross_tenant uuid := gen_random_uuid();
  v_queue_cross_tenant uuid := gen_random_uuid();
  v_case_no_consent uuid := gen_random_uuid();
  v_queue_no_consent uuid := gen_random_uuid();
  v_manual_id uuid := gen_random_uuid();
  v_queue_manual uuid := gen_random_uuid();
  v_shared_pub_id uuid;
  v_shared_manual_pub_id uuid;
  v_err_msg text;
  v_res_count integer;
  v_res_rec record;
BEGIN
  -- Setup test companies
  INSERT INTO public.companies (id, name, status, diagnostic_learning_opt_in)
  VALUES
    (v_co_active, 'Active Opted-In Pools', 'active', true),
    (v_co_opted_out, 'Opted-Out Pools', 'active', false),
    (v_co_other, 'Foreign Workspace Pools', 'active', true);

  -- Setup users
  INSERT INTO auth.users (id, email)
  VALUES
    (v_admin_id, 'security_reviewer_task012@pooldocai.test'),
    (v_tech_user_id, 'technician_task012@pooldocai.test');

  -- Setup company membership for admin operations
  INSERT INTO public.company_members (company_id, user_id, role, status)
  VALUES (v_co_active, v_admin_id, 'company_admin', 'active');

  -- 1. Negative Control: Model-generated authenticated_troubleshooter suggestion with technician_verified=false MUST be rejected
  INSERT INTO public.diagnostic_cases (
    id, tenant_id, case_status, technician_verified, case_learning_opt_in, learning_terms_version, contributor_user_id, contributor_accepted_at, equipment_category, resolution_summary_redacted
  ) VALUES (
    v_case_ai_unverified, v_co_active, 'open', false, true, '2026-10-v1', v_tech_user_id, now(), 'pump', 'Chatbot suggested replacing mechanical shaft seal'
  );

  INSERT INTO public.case_learning_consents (case_id, company_id, actor_user_id, purpose, terms_version, consent_status)
  VALUES (v_case_ai_unverified, v_co_active, v_tech_user_id, 'shared_diagnostic_learning', '2026-10-v1', 'granted');

  INSERT INTO public.learning_review_queue (
    id, case_id, tenant_id, source_kind, proposed_lesson_redacted, supporting_source_ids, status
  ) VALUES (
    v_queue_ai_unverified, v_case_ai_unverified, v_co_active, 'authenticated_troubleshooter',
    'Pentair IntelliFlo pump leak: Replace shaft seal based on chatbot suggestion.',
    ARRAY['authenticated-troubleshooter'], 'pending'
  );

  BEGIN
    PERFORM public.pooldocai_approve_learning_case(
      v_queue_ai_unverified,
      'Pentair IntelliFlo pump leak: Replace shaft seal based on chatbot suggestion.',
      v_admin_id,
      'Reviewer attempted approval without technician verification'
    );
    RAISE EXCEPTION 'Unverified AI troubleshooter suggestion approval unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    v_err_msg := SQLERRM;
    IF v_err_msg NOT LIKE '%Model-generated authenticated_troubleshooter suggestion without technician verification%'
       AND v_err_msg NOT LIKE '%Only a resolved%' THEN
      RAISE EXCEPTION 'Unexpected error on unverified troubleshooter approval: %', v_err_msg;
    END IF;
  END;

  -- 2. Negative Control: Cross-tenant queue-case mismatch MUST be rejected
  INSERT INTO public.diagnostic_cases (
    id, tenant_id, case_status, technician_verified, case_learning_opt_in, learning_terms_version, contributor_user_id, contributor_accepted_at, equipment_category, resolution_summary_redacted
  ) VALUES (
    v_case_cross_tenant, v_co_other, 'resolved', true, true, '2026-10-v1', v_tech_user_id, now(), 'Heater', 'Replaced thermal regulator.'
  );

  INSERT INTO public.case_learning_consents (case_id, company_id, actor_user_id, purpose, terms_version, consent_status)
  VALUES (v_case_cross_tenant, v_co_other, v_tech_user_id, 'shared_diagnostic_learning', '2026-10-v1', 'granted');

  INSERT INTO public.learning_review_queue (
    id, case_id, tenant_id, source_kind, proposed_lesson_redacted, supporting_source_ids, status
  ) VALUES (
    v_queue_cross_tenant, v_case_cross_tenant, v_co_active, 'technician_job',
    'Cross-tenant queue submission attempting to claim foreign case.',
    ARRAY['cross-tenant-1'], 'pending'
  );

  BEGIN
    PERFORM public.pooldocai_approve_learning_case(
      v_queue_cross_tenant,
      'Cross-tenant queue submission attempting to claim foreign case.',
      v_admin_id,
      'Attempted cross-tenant queue approval'
    );
    RAISE EXCEPTION 'Cross-tenant approval unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    v_err_msg := SQLERRM;
    IF v_err_msg NOT LIKE '%does not match review queue tenant%' THEN
      RAISE EXCEPTION 'Unexpected error on cross-tenant mismatch: %', v_err_msg;
    END IF;
  END;

  -- 3. Negative Control: Unresolved case (case_status <> resolved) cannot be approved as verified repair
  INSERT INTO public.diagnostic_cases (
    id, tenant_id, case_status, technician_verified, case_learning_opt_in, learning_terms_version, contributor_user_id, contributor_accepted_at, equipment_category, resolution_summary_redacted
  ) VALUES (
    v_case_unresolved, v_co_active, 'open', true, true, '2026-10-v1', v_tech_user_id, now(), 'Filter', 'Cleaned grids but pressure still 35 psi.'
  );

  INSERT INTO public.case_learning_consents (case_id, company_id, actor_user_id, purpose, terms_version, consent_status)
  VALUES (v_case_unresolved, v_co_active, v_tech_user_id, 'shared_diagnostic_learning', '2026-10-v1', 'granted');

  INSERT INTO public.learning_review_queue (
    id, case_id, tenant_id, source_kind, proposed_lesson_redacted, supporting_source_ids, status
  ) VALUES (
    v_queue_unresolved, v_case_unresolved, v_co_active, 'technician_job',
    'Unresolved filter repair attempt.',
    ARRAY['unresolved-1'], 'pending'
  );

  BEGIN
    PERFORM public.pooldocai_approve_learning_case(
      v_queue_unresolved,
      'Unresolved filter repair attempt.',
      v_admin_id,
      'Attempted approval of unresolved case'
    );
    RAISE EXCEPTION 'Unresolved case approval unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    v_err_msg := SQLERRM;
    IF v_err_msg NOT LIKE '%Only a resolved case with status resolved%' THEN
      RAISE EXCEPTION 'Unexpected error on unresolved case approval: %', v_err_msg;
    END IF;
  END;

  -- 4. Negative Control: Missing durable case consent record MUST fail approval
  INSERT INTO public.diagnostic_cases (
    id, tenant_id, case_status, technician_verified, case_learning_opt_in, learning_terms_version, contributor_user_id, contributor_accepted_at, equipment_category, resolution_summary_redacted
  ) VALUES (
    v_case_no_consent, v_co_active, 'resolved', true, true, '2026-10-v1', v_tech_user_id, now(), 'Salt System', 'Replaced flow switch.'
  );

  INSERT INTO public.learning_review_queue (
    id, case_id, tenant_id, source_kind, proposed_lesson_redacted, supporting_source_ids, status
  ) VALUES (
    v_queue_no_consent, v_case_no_consent, v_co_active, 'technician_job',
    'Salt system repair with missing case consent row.',
    ARRAY['no-consent-1'], 'pending'
  );

  BEGIN
    PERFORM public.pooldocai_approve_learning_case(
      v_queue_no_consent,
      'Salt system repair with missing case consent row.',
      v_admin_id,
      'Attempted approval without durable case consent'
    );
    RAISE EXCEPTION 'Approval without durable case consent unexpectedly succeeded';
  EXCEPTION WHEN OTHERS THEN
    v_err_msg := SQLERRM;
    IF v_err_msg NOT LIKE '%Durable case-specific learning consent record is missing or withdrawn%' THEN
      RAISE EXCEPTION 'Unexpected error on missing case consent: %', v_err_msg;
    END IF;
  END;

  -- 5. Positive Control: Verified Technician Case Approval (Same Tenant, Resolved Status, Provenance & Consent)
  INSERT INTO public.diagnostic_cases (
    id, tenant_id, case_status, technician_verified, case_learning_opt_in, learning_terms_version,
    contributor_user_id, contributor_accepted_at, equipment_category,
    manufacturer_normalized, model_normalized, resolution_summary_redacted
  ) VALUES (
    v_case_tech_verified, v_co_active, 'resolved', true, true, '2026-10-v1',
    v_tech_user_id, now(), 'Pump',
    'Pentair', 'IntelliFlo VSF', 'Replaced shaft seal and lubricated diffuser O-ring. Primed immediately.'
  );

  INSERT INTO public.case_learning_consents (case_id, company_id, actor_user_id, purpose, terms_version, consent_status)
  VALUES (v_case_tech_verified, v_co_active, v_tech_user_id, 'shared_diagnostic_learning', '2026-10-v1', 'granted');

  INSERT INTO public.learning_review_queue (
    id, case_id, tenant_id, source_kind, proposed_lesson_redacted, supporting_source_ids, status
  ) VALUES (
    v_queue_tech_verified, v_case_tech_verified, v_co_active, 'technician_job',
    'Pentair IntelliFlo VSF leak: Replaced shaft seal and lubricated diffuser O-ring. Confirmed resolved repair.',
    ARRAY['tech-job-evidence-1'], 'pending'
  );

  PERFORM public.pooldocai_approve_learning_case(
    v_queue_tech_verified,
    'Pentair IntelliFlo VSF leak: Replaced shaft seal and lubricated diffuser O-ring. Confirmed resolved repair.',
    v_admin_id,
    'Platform reviewer signoff on verified technician repair'
  );

  -- Confirm shared_learning_knowledge row created with verified_repair and technician_verified=true
  SELECT id INTO v_shared_pub_id
  FROM public.shared_learning_knowledge
  WHERE source_queue_id = v_queue_tech_verified;

  IF v_shared_pub_id IS NULL THEN
    RAISE EXCEPTION 'Expected shared_learning_knowledge row for approved verified repair was not created';
  END IF;

  SELECT knowledge_type, technician_verified, publication_status
  INTO v_res_rec
  FROM public.shared_learning_knowledge
  WHERE id = v_shared_pub_id;

  IF v_res_rec.knowledge_type <> 'verified_repair' OR v_res_rec.technician_verified <> true OR v_res_rec.publication_status <> 'active' THEN
    RAISE EXCEPTION 'Metadata mismatch on approved repair: type=%, verified=%, status=%',
      v_res_rec.knowledge_type, v_res_rec.technician_verified, v_res_rec.publication_status;
  END IF;

  -- 6. Search Retrieval Predicate Check: Active verified repair must be retrievable
  SELECT count(*) INTO v_res_count
  FROM public.search_shared_learning('Pentair IntelliFlo shaft seal', 4);

  IF v_res_count = 0 THEN
    RAISE EXCEPTION 'Active verified repair must be retrievable via search_shared_learning';
  END IF;

  -- 7. Company Manual Consent Control: Revoked manual with active company
  INSERT INTO public.company_manuals (
    id, company_id, title, storage_path, document_type, reference_enabled, extraction_status,
    manufacturer_normalized, model_normalized, equipment_category,
    rights_attested_at, rights_attested_by, knowledge_scope, general_learning_rights_attested, shared_learning_opt_in
  ) VALUES (
    v_manual_id, v_co_active, 'Hayward Super Pump Manual', 'manuals/hayward.pdf', 'manual', true, 'ready',
    'hayward', 'super_pump', 'pump',
    now(), v_admin_id, 'general_candidate', true, true
  );

  INSERT INTO public.learning_review_queue (
    id, case_id, tenant_id, source_kind, proposed_lesson_redacted, supporting_source_ids, status
  ) VALUES (
    v_queue_manual, v_case_tech_verified, v_co_active, 'company_manual',
    'Hayward Super Pump seal installation guide and impeller torque specifications.',
    ARRAY[v_manual_id::text], 'pending'
  );

  PERFORM public.pooldocai_approve_learning_case(
    v_queue_manual,
    'Hayward Super Pump seal installation guide and impeller torque specifications.',
    v_admin_id,
    'Platform reviewer signoff on company manual SOP'
  );

  SELECT id INTO v_shared_manual_pub_id
  FROM public.shared_learning_knowledge
  WHERE source_queue_id = v_queue_manual;

  IF v_shared_manual_pub_id IS NULL THEN
    RAISE EXCEPTION 'Expected shared_learning_knowledge row for approved company manual was not created';
  END IF;

  -- Verify manual is retrievable while opted in
  SELECT count(*) INTO v_res_count
  FROM public.search_shared_learning('Hayward Super Pump impeller torque', 4);

  IF v_res_count = 0 THEN
    RAISE EXCEPTION 'Active company manual must be retrievable via search_shared_learning';
  END IF;

  -- Now revoke ONLY the manual consent, keeping the company active and opted in
  PERFORM set_config('request.jwt.claim.sub', v_admin_id::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);

  UPDATE public.company_manuals
  SET shared_learning_opt_in = false
  WHERE id = v_manual_id;

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);

  SELECT count(*) INTO v_res_count
  FROM public.search_shared_learning('Hayward Super Pump impeller torque', 4);

  IF v_res_count <> 0 THEN
    RAISE EXCEPTION 'Revoked company manual must be IMMEDIATELY excluded from search_shared_learning (got % rows)', v_res_count;
  END IF;

  -- 8. Atomic Consent Withdrawal RPC Check
  PERFORM public.pooldocai_withdraw_case_learning_consent(
    v_case_tech_verified,
    v_co_active,
    v_admin_id,
    'Company withdrew learning consent via atomic RPC'
  );

  -- Assert soft-revocation, audit trail, and search exclusion
  SELECT publication_status INTO v_err_msg
  FROM public.shared_learning_knowledge
  WHERE id = v_shared_pub_id;

  IF v_err_msg <> 'revoked' THEN
    RAISE EXCEPTION 'shared_learning_knowledge publication_status must be soft-revoked (got: %)', v_err_msg;
  END IF;

  SELECT consent_status INTO v_err_msg
  FROM public.case_learning_consents
  WHERE case_id = v_case_tech_verified AND purpose = 'shared_diagnostic_learning';

  IF v_err_msg <> 'withdrawn' THEN
    RAISE EXCEPTION 'case_learning_consents consent_status must be withdrawn (got: %)', v_err_msg;
  END IF;

  SELECT count(*) INTO v_res_count
  FROM public.search_shared_learning('Pentair IntelliFlo shaft seal', 4);

  IF v_res_count <> 0 THEN
    RAISE EXCEPTION 'Atomic-withdrawn case must be excluded from search_shared_learning (got % rows)', v_res_count;
  END IF;

  -- 8b. Non-Destructive Rollback / Recovery Quarantine Simulation Check
  -- Execute the Section 4.1 non-destructive quarantine UPDATE and verify that the revoked manual row
  -- transitions to 'quarantined' (without deleting rows) while the revoked case row remains 'revoked',
  -- and neither is ever exposed by search_shared_learning.
  UPDATE public.shared_learning_knowledge k
  SET
    publication_status = 'quarantined',
    consent_snapshot = false
  WHERE k.id = v_shared_manual_pub_id
    AND k.publication_status <> 'revoked'
    AND (
      k.source_kind = 'company_manual'
      AND NOT EXISTS (
        SELECT 1
        FROM public.company_manuals m
        WHERE m.id = k.source_manual_id
          AND m.company_id = k.source_company_id
          AND COALESCE(m.shared_learning_opt_in, false) = true
          AND COALESCE(m.reference_enabled, false) = true
          AND m.extraction_status = 'ready'
      )
    );

  SELECT publication_status INTO v_err_msg
  FROM public.shared_learning_knowledge
  WHERE id = v_shared_manual_pub_id;

  IF v_err_msg <> 'quarantined' THEN
    RAISE EXCEPTION 'Non-destructive recovery quarantine must mark withdrawn-manual knowledge as quarantined (got: %)', v_err_msg;
  END IF;

  SELECT count(*) INTO v_res_count
  FROM public.search_shared_learning('Hayward Super Pump impeller torque', 4);

  IF v_res_count <> 0 THEN
    RAISE EXCEPTION 'Quarantined manual knowledge must remain excluded from search_shared_learning after recovery simulation (got % rows)', v_res_count;
  END IF;

  -- 9. Teardown Section 13 Test Fixtures
  DELETE FROM public.shared_learning_knowledge WHERE source_queue_id IN (v_queue_ai_unverified, v_queue_tech_verified, v_queue_unresolved, v_queue_cross_tenant, v_queue_no_consent, v_queue_manual);
  DELETE FROM public.learning_review_audit WHERE case_id IN (v_case_ai_unverified, v_case_tech_verified, v_case_unresolved, v_case_cross_tenant, v_case_no_consent);
  DELETE FROM public.learning_review_queue WHERE id IN (v_queue_ai_unverified, v_queue_tech_verified, v_queue_unresolved, v_queue_cross_tenant, v_queue_no_consent, v_queue_manual);
  DELETE FROM public.case_learning_consents WHERE case_id IN (v_case_ai_unverified, v_case_tech_verified, v_case_unresolved, v_case_cross_tenant, v_case_no_consent);
  DELETE FROM public.company_manuals WHERE id = v_manual_id;
  DELETE FROM public.diagnostic_cases WHERE id IN (v_case_ai_unverified, v_case_tech_verified, v_case_unresolved, v_case_cross_tenant, v_case_no_consent);
  DELETE FROM public.company_members WHERE company_id IN (v_co_active, v_co_opted_out, v_co_other);
  DELETE FROM public.companies WHERE id IN (v_co_active, v_co_opted_out, v_co_other);
  DELETE FROM auth.users WHERE id IN (v_admin_id, v_tech_user_id);
END $$;
