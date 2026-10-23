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
