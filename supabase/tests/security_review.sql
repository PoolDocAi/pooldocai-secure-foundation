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
  INSERT INTO public.diagnostic_cases (id, tenant_id, technician_verified, case_learning_opt_in, learning_terms_version, equipment_category, resolution_summary_redacted)
  VALUES (v_case_unverified, v_co_a, false, true, '2026-10-v1', 'pump', '');

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

  SELECT count(*) INTO v_cnt FROM public.notification_delivery_queue WHERE notification_id = v_notif_1 AND channel = 'email' AND delivery_status = 'deferred';
  IF v_cnt <> 2 THEN
    RAISE EXCEPTION 'Expected 2 deferred email queue records, got %', v_cnt;
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
  SELECT count(*) INTO v_cnt FROM public.company_notifications WHERE id = v_notif_admin;
  IF v_cnt <> 1 THEN
    RAISE EXCEPTION 'Admin A should be able to view admin notification, got %', v_cnt;
  END IF;

  -- Tech A has NO user_notification and CANNOT see the event
  PERFORM set_config('request.jwt.claim.sub', v_user_a_tech::text, true);
  SELECT count(*) INTO v_cnt FROM public.company_notifications WHERE id = v_notif_admin;
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'Tech A illegally viewed admin-only company event via company_notifications';
  END IF;

  -- User B (Company B) CANNOT see the event
  PERFORM set_config('request.jwt.claim.sub', v_user_b_admin::text, true);
  SELECT count(*) INTO v_cnt FROM public.company_notifications WHERE id = v_notif_admin;
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

  -- Teardown Section 10 test fixtures
  PERFORM set_config('request.jwt.claim.sub', '', true);
  DELETE FROM public.user_notification_preferences WHERE company_id IN (v_co_a, v_co_b);
  DELETE FROM public.notification_delivery_queue WHERE company_id IN (v_co_a, v_co_b);
  DELETE FROM public.user_notifications WHERE company_id IN (v_co_a, v_co_b);
  DELETE FROM public.company_notifications WHERE company_id IN (v_co_a, v_co_b);
  DELETE FROM public.company_members WHERE company_id IN (v_co_a, v_co_b);
  DELETE FROM public.companies WHERE id IN (v_co_a, v_co_b);
  DELETE FROM auth.users WHERE id IN (v_user_a_admin, v_user_a_tech, v_user_a_susp, v_user_b_admin);
END $;
