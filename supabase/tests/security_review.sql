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
    select * into r from public.pooldocai_consume_public_demo_turn(homeowner_hash, 'turn-' || i::text, 8, 24);
    if not r.allowed then raise exception 'Homeowner demo was blocked before turn % of 8', i; end if;
  end loop;
  select * into r from public.pooldocai_consume_public_demo_turn(homeowner_hash, 'turn-9', 8, 24);
  if r.allowed then raise exception 'Homeowner demo allowed a ninth turn'; end if;

  for i in 1..8 loop
    select * into r from public.pooldocai_consume_public_demo_turn(fieldtech_hash, 'turn-' || i::text, 8, 24);
    if not r.allowed then raise exception 'Field Tech demo was blocked before turn % of 8', i; end if;
  end loop;
  select * into r from public.pooldocai_consume_public_demo_turn(fieldtech_hash, 'turn-9', 8, 24);
  if r.allowed then raise exception 'Field Tech demo allowed a ninth turn'; end if;

  delete from public.public_demo_sessions where session_hash in (homeowner_hash, fieldtech_hash);
end $$;

-- Inspect tenant-aware policies for the main private tables.
select schemaname, tablename, policyname, roles, cmd, qual, with_check
from pg_policies
where schemaname='public' and tablename in ('companies','company_members','service_requests','service_customers','company_manuals','technician_job_records')
order by tablename, policyname;
