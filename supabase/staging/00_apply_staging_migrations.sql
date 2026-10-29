-- ============================================================================
-- POOLDOCAI ISOLATED STAGING ENVIRONMENT MIGRATION BUNDLE
-- Target: Project rzkgmvyyeclrpomrlyft (PoolDocAI Staging)
-- Total Migrations: 47 (001 through 047)
-- Generated: 2026-10-26
-- STRICT NOTICE: STAGING USE ONLY. DO NOT EXECUTE ON PRODUCTION owfeebydlyacssqpnmkq
--
-- COMPATIBILITY NOTE:
-- This bundle contains standard PostgreSQL statements and contains NO psql
-- meta-commands (such as psql ON_ERROR_STOP). It can be executed directly in:
-- 1. Supabase Dashboard Web SQL Editor (paste & Run)
-- 2. psql command line: psql "<connection-string>" --set ON_ERROR_STOP=1 -f 00_apply_staging_migrations.sql
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Migration 1/47: 202610210001_learning_loop_privacy.sql
-- ----------------------------------------------------------------------------

-- PoolDocAI privacy-minimized learning-loop schema.
-- No customer identity/contact fields exist in these tables. Raw prompts, photos,
-- names, addresses, phone numbers and emails must never be inserted here.
create extension if not exists pgcrypto;

create table if not exists public.diagnostic_cases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  case_status text not null default 'open' check (case_status in ('open','resolved','unresolved','technician_handoff')),
  equipment_category text,
  manufacturer_normalized text,
  model_normalized text,
  symptom_redacted text not null default '',
  source_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolution_code text,
  resolution_summary_redacted text,
  technician_verified boolean not null default false,
  approved_for_learning boolean not null default false,
  privacy_reviewed_at timestamptz,
  constraint diagnostic_cases_text_limits check (
    length(symptom_redacted) <= 1200 and
    (resolution_summary_redacted is null or length(resolution_summary_redacted) <= 1200)
  )
);

create table if not exists public.diagnostic_case_steps (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.diagnostic_cases(id) on delete cascade,
  step_number integer not null check (step_number > 0),
  step_type text not null check (step_type in ('question','observation','test','recommendation','handoff')),
  prompt_redacted text not null default '',
  result_code text,
  result_summary_redacted text,
  source_ids text[] not null default '{}',
  skipped boolean not null default false,
  created_at timestamptz not null default now(),
  unique(case_id, step_number),
  constraint diagnostic_steps_text_limits check (length(prompt_redacted) <= 1200 and (result_summary_redacted is null or length(result_summary_redacted) <= 1200))
);

create table if not exists public.learning_review_queue (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.diagnostic_cases(id) on delete cascade,
  proposed_lesson_redacted text not null,
  supporting_source_ids text[] not null default '{}',
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint learning_lesson_length check (length(proposed_lesson_redacted) <= 2000)
);

alter table public.diagnostic_cases enable row level security;
alter table public.diagnostic_case_steps enable row level security;
alter table public.learning_review_queue enable row level security;

-- Deny public/anon/authenticated access by default. Only the backend service role
-- (which bypasses RLS) or a separately designed, authenticated admin policy may access.
revoke all on public.diagnostic_cases from anon, authenticated;
revoke all on public.diagnostic_case_steps from anon, authenticated;
revoke all on public.learning_review_queue from anon, authenticated;
grant all on public.diagnostic_cases to service_role;
grant all on public.diagnostic_case_steps to service_role;
grant all on public.learning_review_queue to service_role;

comment on table public.diagnostic_cases is 'PII-minimized case metadata only. Do not add customer identity/contact fields or raw prompt/photo storage.';
comment on table public.diagnostic_case_steps is 'Redacted diagnostic step history; never store raw customer text or image bytes.';
comment on table public.learning_review_queue is 'Human review queue. Only verified, privacy-reviewed lessons should be approved for reuse.';


-- Cost controls: store only a one-way digest of the browser session token, never
-- the token itself, IP address, name, email, phone or address. Requests expire daily.
create table if not exists public.ai_session_usage (
  session_hash text primary key check (session_hash ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz not null default now(),
  window_requests integer not null default 0 check (window_requests >= 0),
  daily_date date not null default (now() at time zone 'utc')::date,
  daily_requests integer not null default 0 check (daily_requests >= 0),
  updated_at timestamptz not null default now()
);
alter table public.ai_session_usage enable row level security;
revoke all on public.ai_session_usage from anon, authenticated;
grant all on public.ai_session_usage to service_role;

create or replace function public.pooldocai_consume_session_budget(
  p_session_hash text, p_action text default 'troubleshoot',
  p_max_requests integer default 18, p_max_daily_requests integer default 60
) returns table(allowed boolean, retry_after_seconds integer, window_requests integer, daily_requests integer)
language plpgsql security definer set search_path = public as $$
declare r public.ai_session_usage%rowtype; now_utc timestamptz := now(); today_utc date := (now() at time zone 'utc')::date;
begin
  if p_session_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid session hash'; end if;
  insert into public.ai_session_usage(session_hash) values (p_session_hash) on conflict do nothing;
  select * into r from public.ai_session_usage where session_hash = p_session_hash for update;
  if r.window_started_at < now_utc - interval '1 hour' then r.window_started_at := now_utc; r.window_requests := 0; end if;
  if r.daily_date <> today_utc then r.daily_date := today_utc; r.daily_requests := 0; end if;
  if r.window_requests >= least(greatest(p_max_requests,1),30) or r.daily_requests >= least(greatest(p_max_daily_requests,1),100) then
    update public.ai_session_usage set window_started_at=r.window_started_at, window_requests=r.window_requests, daily_date=r.daily_date, daily_requests=r.daily_requests, updated_at=now_utc where session_hash=p_session_hash;
    return query select false, greatest(1, ceil(extract(epoch from (r.window_started_at + interval '1 hour' - now_utc))::numeric)::integer), r.window_requests, r.daily_requests; return;
  end if;
  r.window_requests := r.window_requests + 1; r.daily_requests := r.daily_requests + 1;
  update public.ai_session_usage set window_started_at=r.window_started_at, window_requests=r.window_requests, daily_date=r.daily_date, daily_requests=r.daily_requests, updated_at=now_utc where session_hash=p_session_hash;
  return query select true, 0, r.window_requests, r.daily_requests;
end; $$;
revoke all on function public.pooldocai_consume_session_budget(text,text,integer,integer) from public, anon, authenticated;
grant execute on function public.pooldocai_consume_session_budget(text,text,integer,integer) to service_role;

-- ----------------------------------------------------------------------------
-- Migration 2/47: 202610210002_technician_job_records.sql
-- ----------------------------------------------------------------------------

-- Technician-entered job records. Identity/contact fields are intentionally absent.
create table if not exists public.technician_job_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  case_status text not null default 'open' check (case_status in ('open','resolved','unresolved','technician_handoff')),
  job_reference_redacted text,
  equipment_category text,
  manufacturer_normalized text,
  model_normalized text,
  complaint_redacted text not null default '',
  diagnostic_notes_redacted text not null default '',
  repair_steps_redacted jsonb not null default '[]'::jsonb,
  resolution_summary_redacted text not null default '',
  outcome text not null default 'in_progress' check (outcome in ('in_progress','resolved','unresolved','follow_up_required','parts_required')),
  related_case_id uuid references public.diagnostic_cases(id) on delete set null,
  voice_transcribed boolean not null default false,
  source text not null default 'technician_manual' check (source in ('technician_manual','troubleshooter')),
  technician_verified boolean not null default true,
  approved_for_learning boolean not null default false,
  privacy_reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tech_job_text_limits check (
    (job_reference_redacted is null or length(job_reference_redacted) <= 120) and length(complaint_redacted) <= 1500 and length(diagnostic_notes_redacted) <= 4000 and
    length(resolution_summary_redacted) <= 3000 and jsonb_typeof(repair_steps_redacted) = 'array'
  )
);
create index if not exists technician_job_records_created_at_idx on public.technician_job_records (created_at desc);
create index if not exists technician_job_records_related_case_idx on public.technician_job_records (related_case_id) where related_case_id is not null;
alter table public.technician_job_records enable row level security;
revoke all on public.technician_job_records from anon, authenticated;
grant all on public.technician_job_records to service_role;
comment on table public.technician_job_records is 'PII-minimized technician-entered job notes, including jobs that did not use AI troubleshooting. Human review required before approved_for_learning is enabled.';

-- ----------------------------------------------------------------------------
-- Migration 3/47: 202610210003_company_admin_portal.sql
-- ----------------------------------------------------------------------------

-- PoolDocAI multi-tenant company portal and platform-owner dashboard.
-- Apply only after enabling Supabase Auth. Never insert a platform admin from browser code.
create extension if not exists pgcrypto;
create table if not exists public.companies (
 id uuid primary key default gen_random_uuid(), name text not null, status text not null default 'pilot' check(status in ('pilot','active','past_due','suspended','cancelled')),
 plan_name text not null default 'pilot', seat_limit integer not null default 1 check(seat_limit between 1 and 500), billing_email text,
 billing_status text not null default 'not_configured' check(billing_status in ('not_configured','trialing','active','past_due','cancelled','manual_review')),
 billing_customer_ref text, billing_subscription_ref text, current_period_end timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.platform_admins (user_id uuid primary key references auth.users(id) on delete cascade, created_at timestamptz not null default now());
create table if not exists public.company_members (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade, role text not null default 'technician' check(role in ('company_admin','technician','read_only')),
 status text not null default 'active' check(status in ('active','suspended')), display_name text, created_at timestamptz not null default now(),
 unique(company_id,user_id)
);
create table if not exists public.service_requests (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
 created_by uuid references auth.users(id) on delete set null, status text not null default 'open' check(status in ('open','assigned','in_progress','resolved','cancelled')),
 priority text not null default 'normal' check(priority in ('low','normal','high','urgent')), request_summary text not null default '',
 assigned_technician uuid references auth.users(id) on delete set null, related_job_id uuid, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.service_customers (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
 customer_name text, phone text, email text, service_address text, notes text, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.company_manuals (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
 uploaded_by uuid references auth.users(id) on delete set null, title text not null, storage_path text not null, content_type text, file_size bigint,
 document_type text not null default 'manual' check(document_type in ('manual','sop','policy','other')), created_at timestamptz not null default now()
);
create table if not exists public.technician_invitation_requests (
 id uuid primary key default gen_random_uuid(), company_id uuid not null references public.companies(id) on delete cascade,
 requested_by uuid references auth.users(id) on delete set null, invite_email text not null, display_name text, requested_role text not null default 'technician' check(requested_role in ('company_admin','technician','read_only')),
 status text not null default 'pending' check(status in ('pending','sent','cancelled')), created_at timestamptz not null default now()
);
create table if not exists public.platform_usage_events (
 id bigint generated always as identity primary key, company_id uuid references public.companies(id) on delete set null,
 user_id uuid references auth.users(id) on delete set null, event_type text not null, units integer not null default 1,
 metadata jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
alter table public.technician_job_records add column if not exists technician_id uuid references auth.users(id) on delete set null;
alter table public.technician_job_records add column if not exists tenant_id uuid references public.companies(id) on delete cascade;
create index if not exists company_members_user_idx on public.company_members(user_id);
create index if not exists service_requests_company_created_idx on public.service_requests(company_id,created_at desc);
create index if not exists service_customers_company_idx on public.service_customers(company_id);
create index if not exists technician_jobs_tenant_created_idx on public.technician_job_records(tenant_id,created_at desc);
do $$ begin
 if not exists (select 1 from pg_constraint where conname='technician_job_records_tenant_id_fkey') then
  alter table public.technician_job_records add constraint technician_job_records_tenant_id_fkey foreign key (tenant_id) references public.companies(id) on delete cascade;
 end if;
end $$;

create or replace function public.is_platform_admin() returns boolean language sql stable security definer set search_path=public,pg_temp as $$ select exists(select 1 from public.platform_admins p where p.user_id=auth.uid()) $$;
create or replace function public.is_company_member(p_company_id uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$ select exists(select 1 from public.company_members m where m.company_id=p_company_id and m.user_id=auth.uid() and m.status='active') $$;
create or replace function public.is_company_admin(p_company_id uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$ select public.is_platform_admin() or exists(select 1 from public.company_members m where m.company_id=p_company_id and m.user_id=auth.uid() and m.role='company_admin' and m.status='active') $$;
create or replace function public.is_company_operator(p_company_id uuid) returns boolean language sql stable security definer set search_path=public,pg_temp as $$ select public.is_platform_admin() or exists(select 1 from public.company_members m where m.company_id=p_company_id and m.user_id=auth.uid() and m.role in ('company_admin','technician') and m.status='active') $$;
revoke all on function public.is_platform_admin() from public; revoke all on function public.is_company_member(uuid) from public; revoke all on function public.is_company_admin(uuid) from public; revoke all on function public.is_company_operator(uuid) from public;
grant execute on function public.is_platform_admin() to authenticated; grant execute on function public.is_company_member(uuid) to authenticated; grant execute on function public.is_company_admin(uuid) to authenticated; grant execute on function public.is_company_operator(uuid) to authenticated;

alter table public.companies enable row level security; alter table public.platform_admins enable row level security; alter table public.company_members enable row level security;
alter table public.service_requests enable row level security; alter table public.service_customers enable row level security; alter table public.company_manuals enable row level security;
alter table public.technician_invitation_requests enable row level security; alter table public.platform_usage_events enable row level security; alter table public.technician_job_records enable row level security;
create policy companies_read on public.companies for select to authenticated using(public.is_platform_admin() or public.is_company_member(id));
create policy companies_update_admin on public.companies for update to authenticated using(public.is_platform_admin() or public.is_company_admin(id)) with check(public.is_platform_admin() or public.is_company_admin(id));
create policy platform_admin_self_read on public.platform_admins for select to authenticated using(user_id=auth.uid());
create policy members_read on public.company_members for select to authenticated using(public.is_platform_admin() or public.is_company_member(company_id));
create policy members_admin_manage on public.company_members for all to authenticated using(public.is_platform_admin() or public.is_company_admin(company_id)) with check(public.is_platform_admin() or public.is_company_admin(company_id));
create policy requests_read on public.service_requests for select to authenticated using(public.is_platform_admin() or public.is_company_member(company_id));
create policy requests_write on public.service_requests for insert to authenticated with check(public.is_platform_admin() or (public.is_company_operator(company_id) and created_by=auth.uid()));
create policy requests_admin_update on public.service_requests for update to authenticated using(public.is_platform_admin() or public.is_company_admin(company_id) or assigned_technician=auth.uid()) with check(public.is_platform_admin() or public.is_company_member(company_id));
create policy customers_company_access on public.service_customers for select to authenticated using(public.is_platform_admin() or public.is_company_member(company_id));
create policy customers_admin_write on public.service_customers for all to authenticated using(public.is_platform_admin() or public.is_company_admin(company_id)) with check(public.is_platform_admin() or public.is_company_admin(company_id));
create policy manuals_company_read on public.company_manuals for select to authenticated using(public.is_platform_admin() or public.is_company_member(company_id));
create policy manuals_admin_write on public.company_manuals for all to authenticated using(public.is_platform_admin() or public.is_company_admin(company_id)) with check(public.is_platform_admin() or public.is_company_admin(company_id));
create policy invites_admin_read_write on public.technician_invitation_requests for all to authenticated using(public.is_platform_admin() or public.is_company_admin(company_id)) with check(public.is_platform_admin() or (public.is_company_admin(company_id) and requested_by=auth.uid()));
create policy usage_admin_read on public.platform_usage_events for select to authenticated using(public.is_platform_admin() or public.is_company_member(company_id));
create policy jobs_company_read on public.technician_job_records for select to authenticated using(public.is_platform_admin() or (tenant_id is not null and public.is_company_member(tenant_id)));
create policy jobs_company_update on public.technician_job_records for update to authenticated using(public.is_platform_admin() or (tenant_id is not null and public.is_company_operator(tenant_id))) with check(public.is_platform_admin() or (tenant_id is not null and public.is_company_operator(tenant_id)));
-- No direct browser inserts to technician_job_records; use an authenticated server endpoint that verifies tenant membership.
revoke all on public.companies,public.platform_admins,public.company_members,public.service_requests,public.service_customers,public.company_manuals,public.technician_invitation_requests,public.platform_usage_events,public.technician_job_records from anon;
grant select,update on public.companies to authenticated; grant select on public.platform_admins to authenticated;
grant select,insert,update,delete on public.company_members to authenticated;
grant select,insert,update on public.service_requests to authenticated;
grant select,insert,update,delete on public.service_customers to authenticated;
grant select,insert,update,delete on public.company_manuals to authenticated;
grant select,insert,update,delete on public.technician_invitation_requests to authenticated;
grant select on public.platform_usage_events to authenticated;
grant select,update on public.technician_job_records to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values ('company-manuals','company-manuals',false,26214400,array['application/pdf','text/plain','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/msword']) on conflict(id) do nothing;
create policy company_manual_storage_read on storage.objects for select to authenticated using(bucket_id='company-manuals' and (public.is_platform_admin() or public.is_company_member(((storage.foldername(name))[1])::uuid)));
create policy company_manual_storage_upload on storage.objects for insert to authenticated with check(bucket_id='company-manuals' and public.is_company_admin(((storage.foldername(name))[1])::uuid));
create policy company_manual_storage_update on storage.objects for update to authenticated using(bucket_id='company-manuals' and public.is_company_admin(((storage.foldername(name))[1])::uuid)) with check(bucket_id='company-manuals' and public.is_company_admin(((storage.foldername(name))[1])::uuid));
create policy company_manual_storage_delete on storage.objects for delete to authenticated using(bucket_id='company-manuals' and public.is_company_admin(((storage.foldername(name))[1])::uuid));



-- Only platform owners can create company records or change plan/billing controls.
create policy companies_platform_insert on public.companies for insert to authenticated with check(public.is_platform_admin());
grant insert on public.companies to authenticated;
create or replace function public.protect_company_plan_fields() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if not public.is_platform_admin() and (new.status is distinct from old.status or new.plan_name is distinct from old.plan_name or new.seat_limit is distinct from old.seat_limit or new.billing_status is distinct from old.billing_status or new.billing_customer_ref is distinct from old.billing_customer_ref or new.billing_subscription_ref is distinct from old.billing_subscription_ref or new.current_period_end is distinct from old.current_period_end) then
   raise exception 'Only PoolDocAI platform administrators can change plan, status, seat limits, or billing state.';
 end if;
 new.updated_at=now(); return new;
end $$;
create trigger protect_company_plan_fields before update on public.companies for each row execute function public.protect_company_plan_fields();

-- Enforce seat limits at the database layer; company admins cannot bypass this by editing the UI.
create or replace function public.enforce_company_seat_limit() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare lim integer; used integer;
begin
 if new.status <> 'active' then return new; end if;
 select seat_limit into lim from public.companies where id=new.company_id;
 if lim is null then raise exception 'Company not found'; end if;
 if tg_op='UPDATE' and old.company_id=new.company_id and old.status='active' then return new; end if;
 if tg_op='UPDATE' then
   select count(*) into used from public.company_members where company_id=new.company_id and status='active' and id <> old.id;
 else
   select count(*) into used from public.company_members where company_id=new.company_id and status='active';
 end if;
 if used >= lim then raise exception 'This company has reached its plan seat limit (%).',lim; end if;
 return new;
end $$;
create trigger company_member_seat_limit before insert or update of company_id,status on public.company_members for each row execute function public.enforce_company_seat_limit();


-- Server-enforced public demo turn cap. Session/turn IDs are opaque and hashed session IDs only are stored.
create table if not exists public.public_demo_sessions (
 session_hash text primary key, turns_used integer not null default 0, window_started_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.public_demo_turns (
 session_hash text not null references public.public_demo_sessions(session_hash) on delete cascade, turn_id text not null, created_at timestamptz not null default now(), primary key(session_hash,turn_id)
);
alter table public.public_demo_sessions enable row level security; alter table public.public_demo_turns enable row level security;
revoke all on public.public_demo_sessions,public.public_demo_turns from anon,authenticated;
grant all on public.public_demo_sessions,public.public_demo_turns to service_role;
create or replace function public.pooldocai_consume_public_demo_turn(
  p_session_hash text,
  p_turn_id text,
  p_max_turns integer default 8,
  p_window_hours integer default 24
)
returns table(allowed boolean, turns_used integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.public_demo_sessions%rowtype;
  v_already_used boolean := false;
  v_effective_limit integer := least(greatest(coalesce(p_max_turns, 8), 1), 8);
  v_effective_window_hours integer := greatest(coalesce(p_window_hours, 24), 1);
begin
  if coalesce(trim(p_session_hash), '') = '' or coalesce(trim(p_turn_id), '') = '' then
    raise exception 'A demo session hash and unique turn ID are required.';
  end if;

  insert into public.public_demo_sessions as demo_session
    (session_hash, turns_used, window_started_at, updated_at)
  values (p_session_hash, 0, now(), now())
  on conflict (session_hash) do nothing;

  select demo_session.*
    into v_session
    from public.public_demo_sessions as demo_session
   where demo_session.session_hash = p_session_hash
   for update;

  if v_session.window_started_at < now() - make_interval(hours => v_effective_window_hours) then
    update public.public_demo_sessions as demo_session
       set turns_used = 0,
           window_started_at = now(),
           updated_at = now()
     where demo_session.session_hash = p_session_hash
     returning demo_session.* into v_session;
  end if;

  select exists (
    select 1
      from public.public_demo_turns as demo_turn
     where demo_turn.session_hash = p_session_hash
       and demo_turn.turn_id = p_turn_id
       and demo_turn.created_at >= v_session.window_started_at
  ) into v_already_used;

  -- Repeated requests for the same turn ID are idempotent and do not consume another turn.
  if v_already_used then
    return query select true, v_session.turns_used;
    return;
  end if;

  if v_session.turns_used >= v_effective_limit then
    return query select false, v_session.turns_used;
    return;
  end if;

  insert into public.public_demo_turns as demo_turn (session_hash, turn_id)
  values (p_session_hash, p_turn_id)
  on conflict (session_hash, turn_id) do nothing;

  update public.public_demo_sessions as demo_session
     set turns_used = demo_session.turns_used + 1,
         updated_at = now()
   where demo_session.session_hash = p_session_hash
   returning demo_session.* into v_session;

  return query select true, v_session.turns_used;
end;
$$;
revoke all on function public.pooldocai_consume_public_demo_turn(text,text,integer,integer) from public, anon, authenticated;
grant execute on function public.pooldocai_consume_public_demo_turn(text,text,integer,integer) to service_role;

create table if not exists public.platform_page_views (
 id bigint generated always as identity primary key, page_path text not null, referrer_host text, session_hash text, created_at timestamptz not null default now()
);
create index if not exists platform_page_views_created_idx on public.platform_page_views(created_at desc);
alter table public.platform_page_views enable row level security;
create policy page_views_platform_admin_read on public.platform_page_views for select to authenticated using(public.is_platform_admin());
revoke all on public.platform_page_views from anon,authenticated;
grant select on public.platform_page_views to authenticated;

comment on table public.service_customers is 'Customer PII is visible only to authenticated users with membership in the owning company, or platform admins; configure company policies and retention before production.';
comment on table public.technician_invitation_requests is 'Queue only. Actual Auth invitations must be sent through a trusted server using the Supabase service-role key; never expose that key in the dashboard.';

-- ----------------------------------------------------------------------------
-- Migration 4/47: 202610210004_company_manual_learning_consent.sql
-- ----------------------------------------------------------------------------

-- Separate company reference use from optional shared-learning consent.
-- Uploaded files remain company-private and reference-enabled by default.
alter table public.company_manuals
  add column if not exists reference_enabled boolean not null default true,
  add column if not exists shared_learning_opt_in boolean not null default false,
  add column if not exists learning_consent_updated_at timestamptz;

comment on column public.company_manuals.reference_enabled is 'When true, this file is eligible as a private, company-specific troubleshooting reference regardless of shared-learning consent.';
comment on column public.company_manuals.shared_learning_opt_in is 'Explicit company-admin consent for eligible extracted content from this file to contribute to the shared learning loop. Defaults off.';

-- Case records created from technician notes or authenticated troubleshooting are queued
-- for privacy review automatically; they are not automatically approved for shared reuse.
alter table public.learning_review_queue
  add column if not exists source_kind text not null default 'diagnostic_case',
  add column if not exists tenant_id uuid references public.companies(id) on delete set null;

alter table public.learning_review_queue
  drop constraint if exists learning_review_queue_source_kind_check;
alter table public.learning_review_queue
  add constraint learning_review_queue_source_kind_check
  check (source_kind in ('diagnostic_case','technician_job','authenticated_troubleshooter','company_manual'));

create index if not exists company_manuals_reference_enabled_idx
  on public.company_manuals(company_id, reference_enabled) where reference_enabled = true;
create index if not exists learning_review_queue_tenant_created_idx
  on public.learning_review_queue(tenant_id, created_at desc);

-- ----------------------------------------------------------------------------
-- Migration 5/47: 202610210005_document_extraction_retrieval.sql
-- ----------------------------------------------------------------------------

-- Company-private document extraction/indexing. Shared learning consent is separate from
-- reference access. Full extracted text remains tenant-scoped and is never exposed to anon.
create extension if not exists pgcrypto;

alter table public.company_manuals
  add column if not exists source_url text,
  add column if not exists original_filename text,
  add column if not exists extraction_status text not null default 'queued',
  add column if not exists extraction_error text,
  add column if not exists extracted_char_count integer not null default 0,
  add column if not exists chunk_count integer not null default 0,
  add column if not exists processed_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname='company_manuals_extraction_status_check') then
    alter table public.company_manuals add constraint company_manuals_extraction_status_check
      check (extraction_status in ('queued','processing','ready','failed'));
  end if;
end $$;

create table if not exists public.company_manual_chunks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  manual_id uuid not null references public.company_manuals(id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  title text not null default '',
  source_url text,
  page_number integer,
  content_text text not null,
  content_redacted text not null default '',
  search_vector tsvector generated always as (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content_text,''))) stored,
  created_at timestamptz not null default now(),
  unique(manual_id, chunk_index),
  constraint company_manual_chunk_size check (length(content_text) between 1 and 5000)
);
create index if not exists company_manual_chunks_company_idx on public.company_manual_chunks(company_id, manual_id);
create index if not exists company_manual_chunks_search_idx on public.company_manual_chunks using gin(search_vector);
create index if not exists company_manuals_status_idx on public.company_manuals(company_id, extraction_status);

alter table public.company_manual_chunks enable row level security;
revoke all on public.company_manual_chunks from anon, authenticated;
grant all on public.company_manual_chunks to service_role;

create or replace function public.search_company_manual_chunks(p_company_id uuid, p_query text, p_limit integer default 6)
returns table(id uuid, manual_id uuid, title text, source_url text, page_number integer, content_text text, rank real)
language sql stable security definer set search_path=public,pg_temp as $$
  select c.id, c.manual_id, c.title, c.source_url, c.page_number, c.content_text,
    ts_rank(c.search_vector, websearch_to_tsquery('english', coalesce(left(p_query,1800),''))) as rank
  from public.company_manual_chunks c
  join public.company_manuals m on m.id=c.manual_id and m.company_id=c.company_id
  where c.company_id=p_company_id and m.reference_enabled=true and m.extraction_status='ready'
    and (c.search_vector @@ websearch_to_tsquery('english', coalesce(left(p_query,1800),''))
      or exists (select 1 from regexp_split_to_table(lower(coalesce(p_query,'')), '\s+') as q(word) where length(q.word) > 2 and c.content_text ilike '%' || left(q.word,60) || '%'))
  order by rank desc, c.chunk_index asc
  limit least(greatest(coalesce(p_limit,6),1),10)
$$;
revoke all on function public.search_company_manual_chunks(uuid,text,integer) from public, anon, authenticated;
grant execute on function public.search_company_manual_chunks(uuid,text,integer) to service_role;

-- Extend private bucket MIME allow-list. Storage stays private and company-folder RLS still applies.
update storage.buckets set allowed_mime_types = array[
  'application/pdf','text/plain','text/markdown','text/csv','application/json','application/xml','text/xml',
  'text/html','application/xhtml+xml','application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-word.document.macroEnabled.12',
  'image/jpeg','image/png','image/heic','image/heif','image/webp','image/tiff','image/bmp','image/gif'
] where id='company-manuals';

comment on table public.company_manual_chunks is 'Private extracted document chunks, isolated by company_id. Search is performed only by trusted server code after verifying company membership.';
comment on column public.company_manuals.shared_learning_opt_in is 'Explicit consent for extracted content to enter pending shared-learning review. Does not control private company-reference use.';

-- ----------------------------------------------------------------------------
-- Migration 6/47: 202610210006_security_document_jobs_learning_approval.sql
-- ----------------------------------------------------------------------------

-- PoolDocAI security hardening, durable document jobs, consent audit, and human-approved shared knowledge.
-- Fresh install: apply migrations in filename order. Never expose service-role credentials to browsers.
create extension if not exists pgcrypto;

-- Private storage is mandatory; fail closed if the bucket is absent or public.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('company-manuals','company-manuals',false,26214400,array[
'application/pdf','text/plain','text/markdown','text/csv','application/json','application/xml','text/xml','text/html','application/xhtml+xml',
'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-word.document.macroEnabled.12',
'image/jpeg','image/png','image/heic','image/heif','image/webp','image/tiff','image/bmp','image/gif'
]) on conflict(id) do update set public=false,file_size_limit=26214400,allowed_mime_types=excluded.allowed_mime_types;

-- Default deny: service role is the only direct reader of extracted text and review records.
alter table public.company_manual_chunks enable row level security;
revoke all on public.company_manual_chunks from anon, authenticated;
grant all on public.company_manual_chunks to service_role;
alter table public.diagnostic_cases enable row level security;
alter table public.diagnostic_case_steps enable row level security;
alter table public.learning_review_queue enable row level security;
revoke all on public.diagnostic_cases,public.diagnostic_case_steps,public.learning_review_queue from anon,authenticated;
grant all on public.diagnostic_cases,public.diagnostic_case_steps,public.learning_review_queue to service_role;

-- Reassert tenant-aware RLS policies for core customer/job/manual data. Policies are restrictive by company.
drop policy if exists service_requests_read on public.service_requests;
drop policy if exists requests_read on public.service_requests;
create policy requests_read on public.service_requests for select to authenticated using (public.is_platform_admin() or public.is_company_member(company_id));
drop policy if exists service_customers_company_access on public.service_customers;
drop policy if exists customers_company_access on public.service_customers;
create policy customers_company_access on public.service_customers for select to authenticated using (public.is_platform_admin() or public.is_company_member(company_id));
drop policy if exists company_manuals_company_read on public.company_manuals;
drop policy if exists manuals_company_read on public.company_manuals;
create policy manuals_company_read on public.company_manuals for select to authenticated using (public.is_platform_admin() or public.is_company_member(company_id));
drop policy if exists jobs_company_read on public.technician_job_records;
create policy jobs_company_read on public.technician_job_records for select to authenticated using (public.is_platform_admin() or (tenant_id is not null and public.is_company_member(tenant_id)));
drop policy if exists jobs_company_update on public.technician_job_records;
create policy jobs_company_update on public.technician_job_records for update to authenticated using (public.is_platform_admin() or (tenant_id is not null and public.is_company_operator(tenant_id))) with check (public.is_platform_admin() or (tenant_id is not null and public.is_company_operator(tenant_id)));

-- company_manuals in earlier releases did not have updated_at; queue deduplication uses it.
alter table public.company_manuals add column if not exists updated_at timestamptz not null default now();
create or replace function public.pooldocai_touch_updated_at() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin new.updated_at=now(); return new; end; $$;
drop trigger if exists company_manuals_touch_updated_at on public.company_manuals;
create trigger company_manuals_touch_updated_at before update on public.company_manuals for each row execute function public.pooldocai_touch_updated_at();

-- A durable, idempotent queue; the worker claims one job atomically via RPC.
create table if not exists public.document_processing_jobs (
 id uuid primary key default gen_random_uuid(), manual_id uuid not null references public.company_manuals(id) on delete cascade,
 company_id uuid not null references public.companies(id) on delete cascade,
 status text not null default 'queued' check(status in ('queued','processing','ready','failed')),
 attempts integer not null default 0 check(attempts between 0 and 10), max_attempts integer not null default 4 check(max_attempts between 1 and 10),
 dedupe_key text not null, requested_by uuid references auth.users(id) on delete set null,
 last_error text, available_at timestamptz not null default now(), started_at timestamptz, finished_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(company_id,dedupe_key)
);
create index if not exists document_jobs_claim_idx on public.document_processing_jobs(status,available_at,created_at) where status='queued';
create index if not exists document_jobs_company_idx on public.document_processing_jobs(company_id,created_at desc);
alter table public.document_processing_jobs enable row level security;
revoke all on public.document_processing_jobs from public,anon,authenticated;
grant all on public.document_processing_jobs to service_role;

create or replace function public.pooldocai_enqueue_document_job(p_manual_id uuid,p_requested_by uuid default null,p_force boolean default false)
returns public.document_processing_jobs language plpgsql security definer set search_path=public,pg_temp as $$
declare m public.company_manuals%rowtype; j public.document_processing_jobs%rowtype; k text;
begin
 select * into m from public.company_manuals where id=p_manual_id for update;
 if not found then raise exception 'document not found'; end if;
 k := m.id::text || ':' || coalesce(m.storage_path,'') || ':' || coalesce(m.file_size::text,'0') || ':learn=' || m.shared_learning_opt_in::text;
 insert into public.document_processing_jobs(manual_id,company_id,status,dedupe_key,requested_by)
 values(m.id,m.company_id,'queued',k,p_requested_by)
 on conflict(company_id,dedupe_key) do update set
   status=case when public.document_processing_jobs.status='processing' then 'processing' when p_force or public.document_processing_jobs.status='failed' then 'queued' else public.document_processing_jobs.status end,
   attempts=case when public.document_processing_jobs.status<>'processing' and (p_force or public.document_processing_jobs.status='failed') then 0 else public.document_processing_jobs.attempts end,
   last_error=case when public.document_processing_jobs.status<>'processing' and (p_force or public.document_processing_jobs.status='failed') then null else public.document_processing_jobs.last_error end,
   available_at=case when public.document_processing_jobs.status<>'processing' and (p_force or public.document_processing_jobs.status='failed') then now() else public.document_processing_jobs.available_at end,
   finished_at=case when public.document_processing_jobs.status<>'processing' and (p_force or public.document_processing_jobs.status='failed') then null else public.document_processing_jobs.finished_at end,
   updated_at=now()
 returning * into j;
 update public.company_manuals set extraction_status=case when j.status='ready' then 'ready' when j.status='processing' then 'processing' else 'queued' end, extraction_error=null where id=m.id;
 return j;
end; $$;
revoke all on function public.pooldocai_enqueue_document_job(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.pooldocai_enqueue_document_job(uuid,uuid,boolean) to service_role;

create or replace function public.pooldocai_claim_document_job()
returns setof public.document_processing_jobs language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.document_processing_jobs%rowtype;
begin
 update public.document_processing_jobs set status=case when attempts>=max_attempts then 'failed' else 'queued' end, last_error='Worker lease expired; job recovered by queue.', available_at=now(), finished_at=case when attempts>=max_attempts then now() else null end, updated_at=now() where status='processing' and started_at < now()-interval '30 minutes';
 update public.company_manuals m set extraction_status='failed',extraction_error='Worker lease expired after maximum retries.' from public.document_processing_jobs j0 where j0.manual_id=m.id and j0.status='failed' and j0.last_error='Worker lease expired; job recovered by queue.';
 select * into j from public.document_processing_jobs where status='queued' and available_at<=now() and attempts<max_attempts order by created_at for update skip locked limit 1;
 if not found then return; end if;
 update public.document_processing_jobs set status='processing',attempts=attempts+1,started_at=now(),updated_at=now() where id=j.id returning * into j;
 update public.company_manuals set extraction_status='processing',extraction_error=null where id=j.manual_id;
 return next j;
end; $$;
revoke all on function public.pooldocai_claim_document_job() from public,anon,authenticated;
grant execute on function public.pooldocai_claim_document_job() to service_role;

create or replace function public.pooldocai_finish_document_job(p_job_id uuid,p_success boolean,p_error text default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.document_processing_jobs%rowtype; next_status text;
begin
 select * into j from public.document_processing_jobs where id=p_job_id for update;
 if not found then raise exception 'job not found'; end if;
 if p_success then next_status:='ready';
 elsif j.attempts < j.max_attempts then next_status:='queued';
 else next_status:='failed'; end if;
 update public.document_processing_jobs set status=next_status,last_error=case when p_success then null else left(coalesce(p_error,'Processing failed'),500) end,
   available_at=case when next_status='queued' then now() + make_interval(secs => least(300, 15 * power(2,greatest(j.attempts-1,0))::integer)) else available_at end,
   finished_at=case when next_status in ('ready','failed') then now() else null end,updated_at=now() where id=p_job_id;
 if next_status='failed' then update public.company_manuals set extraction_status='failed',extraction_error=left(coalesce(p_error,'Processing failed'),500) where id=j.manual_id;
 elsif p_success then update public.company_manuals set extraction_status='ready',extraction_error=null where id=j.manual_id;
 else update public.company_manuals set extraction_status='queued',extraction_error=left(coalesce(p_error,'Retry scheduled'),500) where id=j.manual_id; end if;
end; $$;
revoke all on function public.pooldocai_finish_document_job(uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.pooldocai_finish_document_job(uuid,boolean,text) to service_role;

-- Consent audit log: document stays private-reference eligible even if shared learning is off.
create table if not exists public.document_consent_audit (
 id uuid primary key default gen_random_uuid(), manual_id uuid not null references public.company_manuals(id) on delete cascade,
 company_id uuid not null references public.companies(id) on delete cascade, actor_user_id uuid references auth.users(id) on delete set null,
 old_opt_in boolean not null, new_opt_in boolean not null, reason text, created_at timestamptz not null default now()
);
alter table public.document_consent_audit enable row level security;
revoke all on public.document_consent_audit from public,anon,authenticated;
grant all on public.document_consent_audit to service_role;

-- Record the consent state that was chosen at initial upload/registration. Updates are
-- logged by the authenticated Edge Function so the actual acting user is preserved.
create or replace function public.pooldocai_audit_initial_document_consent()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into public.document_consent_audit(manual_id,company_id,actor_user_id,old_opt_in,new_opt_in,reason)
 values(new.id,new.company_id,coalesce(auth.uid(),new.uploaded_by),false,coalesce(new.shared_learning_opt_in,false),'Initial document consent state recorded at upload');
 return new;
end; $$;
drop trigger if exists company_manuals_initial_consent_audit on public.company_manuals;
create trigger company_manuals_initial_consent_audit after insert on public.company_manuals
for each row execute function public.pooldocai_audit_initial_document_consent();

-- Shared knowledge is a separate, minimized store. Only explicitly approved lessons enter it.
create table if not exists public.shared_learning_knowledge (
 id uuid primary key default gen_random_uuid(), source_case_id uuid references public.diagnostic_cases(id) on delete set null,
 source_queue_id uuid references public.learning_review_queue(id) on delete set null, source_company_id uuid references public.companies(id) on delete set null,
 source_kind text not null, equipment_category text, manufacturer_normalized text, model_normalized text,
 lesson_redacted text not null check(length(lesson_redacted) between 40 and 4000), approved_by uuid not null references auth.users(id),
 consent_snapshot boolean, review_history jsonb not null default '[]'::jsonb, created_at timestamptz not null default now(),
 unique(source_queue_id)
);
create index if not exists shared_learning_search_idx on public.shared_learning_knowledge using gin(to_tsvector('english',coalesce(equipment_category,'')||' '||coalesce(manufacturer_normalized,'')||' '||coalesce(model_normalized,'')||' '||lesson_redacted));
alter table public.shared_learning_knowledge enable row level security;
revoke all on public.shared_learning_knowledge from public,anon,authenticated;
grant all on public.shared_learning_knowledge to service_role;

create table if not exists public.learning_review_audit (
 id uuid primary key default gen_random_uuid(), queue_id uuid not null references public.learning_review_queue(id) on delete cascade,
 case_id uuid references public.diagnostic_cases(id) on delete set null, actor_user_id uuid references auth.users(id) on delete set null,
 action text not null check(action in ('approved','rejected','reopened')), note_redacted text, created_at timestamptz not null default now()
);
alter table public.learning_review_audit enable row level security;
revoke all on public.learning_review_audit from public,anon,authenticated;
grant all on public.learning_review_audit to service_role;

create or replace function public.search_shared_learning(p_query text,p_limit integer default 4)
returns table(id uuid,equipment_category text,manufacturer_normalized text,model_normalized text,lesson_redacted text,rank real)
language sql stable security definer set search_path=public,pg_temp as $$
 select k.id,k.equipment_category,k.manufacturer_normalized,k.model_normalized,k.lesson_redacted,
 ts_rank(to_tsvector('english',coalesce(k.equipment_category,'')||' '||coalesce(k.manufacturer_normalized,'')||' '||coalesce(k.model_normalized,'')||' '||k.lesson_redacted),websearch_to_tsquery('english',coalesce(left(p_query,1800),''))) rank
 from public.shared_learning_knowledge k
 where to_tsvector('english',coalesce(k.equipment_category,'')||' '||coalesce(k.manufacturer_normalized,'')||' '||coalesce(k.model_normalized,'')||' '||k.lesson_redacted) @@ websearch_to_tsquery('english',coalesce(left(p_query,1800),''))
 order by rank desc limit least(greatest(coalesce(p_limit,4),1),8)
$$;
revoke all on function public.search_shared_learning(text,integer) from public,anon,authenticated;
grant execute on function public.search_shared_learning(text,integer) to service_role;

comment on table public.document_processing_jobs is 'Durable, deduplicated queue. Private worker only; statuses queued/processing/ready/failed.';
comment on table public.shared_learning_knowledge is 'Approved privacy-minimized knowledge only; separate from private manuals and pending cases. This is retrieval, not model training.';

-- Make account revocation and company suspension effective at the database boundary too.
create or replace function public.is_company_member(p_company_id uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.company_members m join public.companies c on c.id=m.company_id
 where m.company_id=p_company_id and m.user_id=auth.uid() and m.status='active' and c.status in ('active','pilot'))
$$;
create or replace function public.is_company_admin(p_company_id uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select public.is_platform_admin() or exists(select 1 from public.company_members m join public.companies c on c.id=m.company_id
 where m.company_id=p_company_id and m.user_id=auth.uid() and m.role='company_admin' and m.status='active' and c.status in ('active','pilot'))
$$;
create or replace function public.is_company_operator(p_company_id uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select public.is_platform_admin() or exists(select 1 from public.company_members m join public.companies c on c.id=m.company_id
 where m.company_id=p_company_id and m.user_id=auth.uid() and m.role in ('company_admin','technician') and m.status='active' and c.status in ('active','pilot'))
$$;
revoke all on function public.is_company_member(uuid),public.is_company_admin(uuid),public.is_company_operator(uuid) from public,anon;
grant execute on function public.is_company_member(uuid),public.is_company_admin(uuid),public.is_company_operator(uuid) to authenticated;


-- Assigned-technician request updates must also require a live membership in a live company.
drop policy if exists requests_admin_update on public.service_requests;
create policy requests_admin_update on public.service_requests for update to authenticated
using (public.is_platform_admin() or public.is_company_admin(company_id) or (assigned_technician=auth.uid() and public.is_company_operator(company_id)))
with check (public.is_platform_admin() or public.is_company_admin(company_id) or (assigned_technician=auth.uid() and public.is_company_operator(company_id)));

-- ----------------------------------------------------------------------------
-- Migration 7/47: 202610210007_reliability_review_safety.sql
-- ----------------------------------------------------------------------------

-- Reliability, queue performance, and safety metadata. Safe additive migration.
create extension if not exists pgcrypto;

-- Enforce known states even if a prior schema was created without a CHECK constraint.
do $$ begin
 if not exists (select 1 from pg_constraint where conname='document_processing_jobs_status_allowed') then
  alter table public.document_processing_jobs add constraint document_processing_jobs_status_allowed check(status in ('queued','processing','ready','failed'));
 end if;
 if not exists (select 1 from pg_constraint where conname='learning_review_queue_status_allowed') then
  alter table public.learning_review_queue add constraint learning_review_queue_status_allowed check(status in ('pending','approved','rejected'));
 end if;
end $$;

create index if not exists learning_review_queue_tenant_status_created_idx on public.learning_review_queue(tenant_id,status,created_at desc);
create index if not exists learning_review_queue_status_created_idx on public.learning_review_queue(status,created_at desc);
create index if not exists diagnostic_cases_tenant_created_idx on public.diagnostic_cases(tenant_id,created_at desc);
create index if not exists technician_job_records_tenant_created_idx on public.technician_job_records(tenant_id,created_at desc);

-- Explicitly prevent browser roles from bypassing the reviewed shared-knowledge path.
alter table public.shared_learning_knowledge enable row level security;
revoke all on public.shared_learning_knowledge from public,anon,authenticated;
grant all on public.shared_learning_knowledge to service_role;

-- Record safety flags for proposed shared lessons; a flag is advisory metadata, never auto-approval.
alter table public.learning_review_queue add column if not exists safety_flags text[] not null default '{}';
alter table public.learning_review_queue add column if not exists updated_at timestamptz not null default now();
create or replace function public.pooldocai_review_queue_touch_updated_at() returns trigger language plpgsql set search_path=public,pg_temp as $$ begin new.updated_at=now(); return new; end $$;
drop trigger if exists learning_review_queue_touch_updated_at on public.learning_review_queue;
create trigger learning_review_queue_touch_updated_at before update on public.learning_review_queue for each row execute function public.pooldocai_review_queue_touch_updated_at();

-- Manufacturer/category tags support later service and warranty trend reporting.
alter table public.company_manuals add column if not exists manufacturer_normalized text;
alter table public.company_manuals add column if not exists equipment_category text;
create index if not exists company_manuals_company_manufacturer_idx on public.company_manuals(company_id,manufacturer_normalized,equipment_category);

-- ----------------------------------------------------------------------------
-- Migration 8/47: 202610210008_public_demo_eight_turns.sql
-- ----------------------------------------------------------------------------

-- Increase the server-enforced public demo allowance to eight turns per opaque session.
-- Frontend mode-specific session IDs keep Homeowner Triage and Field Tech Mobile App allowances separate.
-- Existing session counters are preserved; no company, user, or learning data is deleted.

-- Eight-turn public demo quota with explicit record aliases.
-- The aliases deliberately avoid ambiguity between the RETURNS TABLE output column
-- named turns_used and the table column also named turns_used in UPDATE expressions.
-- Existing session counters are preserved unless their rolling window expires.
create or replace function public.pooldocai_consume_public_demo_turn(
  p_session_hash text,
  p_turn_id text,
  p_max_turns integer default 8,
  p_window_hours integer default 24
)
returns table(allowed boolean, turns_used integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.public_demo_sessions%rowtype;
  v_already_used boolean := false;
  v_effective_limit integer := least(greatest(coalesce(p_max_turns, 8), 1), 8);
  v_effective_window_hours integer := greatest(coalesce(p_window_hours, 24), 1);
begin
  if coalesce(trim(p_session_hash), '') = '' or coalesce(trim(p_turn_id), '') = '' then
    raise exception 'A demo session hash and unique turn ID are required.';
  end if;

  insert into public.public_demo_sessions as demo_session
    (session_hash, turns_used, window_started_at, updated_at)
  values (p_session_hash, 0, now(), now())
  on conflict (session_hash) do nothing;

  select demo_session.*
    into v_session
    from public.public_demo_sessions as demo_session
   where demo_session.session_hash = p_session_hash
   for update;

  if v_session.window_started_at < now() - make_interval(hours => v_effective_window_hours) then
    update public.public_demo_sessions as demo_session
       set turns_used = 0,
           window_started_at = now(),
           updated_at = now()
     where demo_session.session_hash = p_session_hash
     returning demo_session.* into v_session;
  end if;

  select exists (
    select 1
      from public.public_demo_turns as demo_turn
     where demo_turn.session_hash = p_session_hash
       and demo_turn.turn_id = p_turn_id
       and demo_turn.created_at >= v_session.window_started_at
  ) into v_already_used;

  -- Repeated requests for the same turn ID are idempotent and do not consume another turn.
  if v_already_used then
    return query select true, v_session.turns_used;
    return;
  end if;

  if v_session.turns_used >= v_effective_limit then
    return query select false, v_session.turns_used;
    return;
  end if;

  insert into public.public_demo_turns as demo_turn (session_hash, turn_id)
  values (p_session_hash, p_turn_id)
  on conflict (session_hash, turn_id) do nothing;

  update public.public_demo_sessions as demo_session
     set turns_used = demo_session.turns_used + 1,
         updated_at = now()
   where demo_session.session_hash = p_session_hash
   returning demo_session.* into v_session;

  return query select true, v_session.turns_used;
end;
$$;

revoke all on function public.pooldocai_consume_public_demo_turn(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.pooldocai_consume_public_demo_turn(text, text, integer, integer) to service_role;
comment on function public.pooldocai_consume_public_demo_turn(text, text, integer, integer)
is 'Atomically consumes a unique public demo turn; maximum eight turns per mode-specific session per window.';

-- ----------------------------------------------------------------------------
-- Migration 9/47: 202610210009_company_member_permissions_management.sql
-- ----------------------------------------------------------------------------

-- Company-level seat management, delegated permissions, and platform visibility.
-- Existing company, user, job, manual, and learning records are preserved.

-- Company admins manage member seats, not subscription entitlements. Only platform owners
-- can change company status, plan, billing metadata, or seat_limit through the browser API.
drop policy if exists companies_update_admin on public.companies;
create policy companies_update_admin on public.companies
for update to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());

-- Nullable first so existing memberships can receive safe, role-specific defaults.
alter table public.company_members
  add column if not exists can_view_job_notes boolean,
  add column if not exists can_edit_job_notes boolean,
  add column if not exists can_upload_documents boolean,
  add column if not exists can_review_documents boolean;

update public.company_members
set can_view_job_notes = coalesce(can_view_job_notes, true),
    can_edit_job_notes = coalesce(can_edit_job_notes, role in ('company_admin','technician')),
    can_upload_documents = coalesce(can_upload_documents, role = 'company_admin'),
    can_review_documents = coalesce(can_review_documents, role = 'company_admin');

alter table public.company_members alter column can_view_job_notes set not null;
alter table public.company_members alter column can_edit_job_notes set not null;
alter table public.company_members alter column can_upload_documents set not null;
alter table public.company_members alter column can_review_documents set not null;

-- Company admins retain the permissions necessary to administer their own tenant.
-- On role changes, reset only permissions not explicitly changed in the same update.
create or replace function public.pooldocai_default_member_permissions()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    new.can_view_job_notes := coalesce(new.can_view_job_notes, true);
    new.can_edit_job_notes := coalesce(new.can_edit_job_notes, new.role in ('company_admin','technician'));
    new.can_upload_documents := coalesce(new.can_upload_documents, new.role = 'company_admin');
    new.can_review_documents := coalesce(new.can_review_documents, new.role = 'company_admin');
  elsif new.role is distinct from old.role then
    if new.can_view_job_notes is not distinct from old.can_view_job_notes then new.can_view_job_notes := true; end if;
    if new.can_edit_job_notes is not distinct from old.can_edit_job_notes then new.can_edit_job_notes := new.role in ('company_admin','technician'); end if;
    if new.can_upload_documents is not distinct from old.can_upload_documents then new.can_upload_documents := new.role = 'company_admin'; end if;
    if new.can_review_documents is not distinct from old.can_review_documents then new.can_review_documents := new.role = 'company_admin'; end if;
  end if;
  if new.role = 'company_admin' then
    new.can_view_job_notes := true;
    new.can_edit_job_notes := true;
    new.can_upload_documents := true;
    new.can_review_documents := true;
  end if;
  return new;
end;
$$;
revoke all on function public.pooldocai_default_member_permissions() from public, anon, authenticated;
drop trigger if exists company_member_default_permissions on public.company_members;
drop trigger if exists company_member_default_permissions_insert on public.company_members;
drop trigger if exists company_member_default_permissions_update on public.company_members;
create trigger company_member_default_permissions_insert
before insert on public.company_members
for each row execute function public.pooldocai_default_member_permissions();
create trigger company_member_default_permissions_update
before update of role, can_view_job_notes, can_edit_job_notes, can_upload_documents, can_review_documents
on public.company_members
for each row execute function public.pooldocai_default_member_permissions();

-- Capability helpers use the caller's JWT identity, an active membership, and a live company.
create or replace function public.can_view_company_job_notes(p_company_id uuid)
returns boolean language sql stable security definer set search_path=public, pg_temp as $$
  select public.is_platform_admin() or exists (
    select 1 from public.company_members m join public.companies c on c.id=m.company_id
    where m.company_id=p_company_id and m.user_id=auth.uid() and m.status='active'
      and c.status in ('active','pilot')
      and (m.role='company_admin' or m.can_view_job_notes)
  )
$$;
create or replace function public.can_edit_company_job_notes(p_company_id uuid)
returns boolean language sql stable security definer set search_path=public, pg_temp as $$
  select public.is_platform_admin() or exists (
    select 1 from public.company_members m join public.companies c on c.id=m.company_id
    where m.company_id=p_company_id and m.user_id=auth.uid() and m.status='active'
      and c.status in ('active','pilot')
      and (m.role='company_admin' or m.can_edit_job_notes)
  )
$$;
create or replace function public.can_upload_company_documents(p_company_id uuid)
returns boolean language sql stable security definer set search_path=public, pg_temp as $$
  select public.is_platform_admin() or exists (
    select 1 from public.company_members m join public.companies c on c.id=m.company_id
    where m.company_id=p_company_id and m.user_id=auth.uid() and m.status='active'
      and c.status in ('active','pilot')
      and (m.role='company_admin' or m.can_upload_documents)
  )
$$;
create or replace function public.can_review_company_documents(p_company_id uuid)
returns boolean language sql stable security definer set search_path=public, pg_temp as $$
  select public.is_platform_admin() or exists (
    select 1 from public.company_members m join public.companies c on c.id=m.company_id
    where m.company_id=p_company_id and m.user_id=auth.uid() and m.status='active'
      and c.status in ('active','pilot')
      and (m.role='company_admin' or m.can_review_documents)
  )
$$;
revoke all on function public.can_view_company_job_notes(uuid) from public, anon;
revoke all on function public.can_edit_company_job_notes(uuid) from public, anon;
revoke all on function public.can_upload_company_documents(uuid) from public, anon;
revoke all on function public.can_review_company_documents(uuid) from public, anon;
grant execute on function public.can_view_company_job_notes(uuid) to authenticated, service_role;
grant execute on function public.can_edit_company_job_notes(uuid) to authenticated, service_role;
grant execute on function public.can_upload_company_documents(uuid) to authenticated, service_role;
grant execute on function public.can_review_company_documents(uuid) to authenticated, service_role;

-- Job-note RLS now applies individual permissions, not just company membership.
drop policy if exists jobs_company_read on public.technician_job_records;
create policy jobs_company_read on public.technician_job_records
for select to authenticated
using (tenant_id is not null and public.can_view_company_job_notes(tenant_id));
drop policy if exists jobs_company_update on public.technician_job_records;
create policy jobs_company_update on public.technician_job_records
for update to authenticated
using (tenant_id is not null and public.can_edit_company_job_notes(tenant_id))
with check (tenant_id is not null and public.can_edit_company_job_notes(tenant_id));

-- Document metadata/text review is visible only to company seats assigned upload or review access.
-- Company reference retrieval remains server-side and does not expose chunk rows to clients.
drop policy if exists manuals_company_read on public.company_manuals;
create policy manuals_company_read on public.company_manuals
for select to authenticated
using (
  public.is_platform_admin()
  or (public.is_company_member(company_id)
      and (public.can_upload_company_documents(company_id) or public.can_review_company_documents(company_id)))
);

-- Object upload/download and edits need delegated permissions.
-- Shared-learning consent may only be enabled/changed by a company admin through the trusted consent action.
drop policy if exists manuals_admin_write on public.company_manuals;
drop policy if exists manuals_company_insert_permission on public.company_manuals;
drop policy if exists manuals_company_update_permission on public.company_manuals;
drop policy if exists manuals_company_delete_permission on public.company_manuals;
create policy manuals_company_insert_permission on public.company_manuals
for insert to authenticated
with check (
  public.can_upload_company_documents(company_id)
  and (shared_learning_opt_in = false or public.is_company_admin(company_id))
);
create policy manuals_company_update_permission on public.company_manuals
for update to authenticated
using (public.can_upload_company_documents(company_id))
with check (public.can_upload_company_documents(company_id));
create policy manuals_company_delete_permission on public.company_manuals
for delete to authenticated
using (public.can_upload_company_documents(company_id));

-- Guard the consent column even when an uploader has general document-management permission.
create or replace function public.pooldocai_protect_manual_learning_consent()
returns trigger language plpgsql security definer set search_path=public, pg_temp as $$
begin
  if new.shared_learning_opt_in is distinct from old.shared_learning_opt_in
     and coalesce(auth.role(), '') <> 'service_role'
     and not public.is_company_admin(new.company_id) then
    raise exception 'Only a company administrator can change shared-learning consent.';
  end if;
  return new;
end;
$$;
revoke all on function public.pooldocai_protect_manual_learning_consent() from public, anon, authenticated;
drop trigger if exists company_manual_learning_consent_guard on public.company_manuals;
create trigger company_manual_learning_consent_guard
before update of shared_learning_opt_in on public.company_manuals
for each row execute function public.pooldocai_protect_manual_learning_consent();

-- Storage bucket policies enforce the same capabilities. Company folders must start with company UUID.
drop policy if exists company_manual_storage_read on storage.objects;
drop policy if exists company_manual_storage_upload on storage.objects;
drop policy if exists company_manual_storage_update on storage.objects;
drop policy if exists company_manual_storage_delete on storage.objects;
create policy company_manual_storage_read on storage.objects
for select to authenticated
using (
  bucket_id='company-manuals'
  and public.is_company_member(((storage.foldername(name))[1])::uuid)
  and (public.can_upload_company_documents(((storage.foldername(name))[1])::uuid)
       or public.can_review_company_documents(((storage.foldername(name))[1])::uuid))
);
create policy company_manual_storage_upload on storage.objects
for insert to authenticated
with check (
  bucket_id='company-manuals'
  and public.can_upload_company_documents(((storage.foldername(name))[1])::uuid)
);
create policy company_manual_storage_update on storage.objects
for update to authenticated
using (bucket_id='company-manuals' and public.can_upload_company_documents(((storage.foldername(name))[1])::uuid))
with check (bucket_id='company-manuals' and public.can_upload_company_documents(((storage.foldername(name))[1])::uuid));
create policy company_manual_storage_delete on storage.objects
for delete to authenticated
using (bucket_id='company-manuals' and public.can_upload_company_documents(((storage.foldername(name))[1])::uuid));

-- Prevent platform admins from reducing a company's subscription seat limit below active seats.
create or replace function public.pooldocai_check_company_seat_limit_update()
returns trigger language plpgsql security definer set search_path=public, pg_temp as $$
declare active_seats integer;
begin
  if new.seat_limit is distinct from old.seat_limit then
    select count(*) into active_seats from public.company_members where company_id=new.id and status='active';
    if new.seat_limit < active_seats then
      raise exception 'Seat limit (%) cannot be lower than the % currently active seats. Suspend/remove seats first.', new.seat_limit, active_seats;
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.pooldocai_check_company_seat_limit_update() from public, anon, authenticated;
drop trigger if exists company_seat_limit_update_guard on public.companies;
create trigger company_seat_limit_update_guard before update of seat_limit on public.companies
for each row execute function public.pooldocai_check_company_seat_limit_update();

-- Keep a signed-in member from changing their own role, status, identity, or permission bits.
-- Trusted service-role provisioning and SQL administrator operations remain possible.
create or replace function public.pooldocai_guard_member_self_changes()
returns trigger language plpgsql security definer set search_path=public, pg_temp as $$
begin
  if coalesce(auth.role(), '') = 'service_role' or auth.uid() is null then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;
  if tg_op = 'DELETE' then
    if old.user_id = auth.uid() then raise exception 'You cannot remove your own company seat.'; end if;
    return old;
  end if;
  if new.user_id is distinct from old.user_id or new.company_id is distinct from old.company_id then
    raise exception 'A company membership cannot be moved to a different user or company.';
  end if;
  if old.user_id = auth.uid() and (
    new.role is distinct from old.role or new.status is distinct from old.status or
    new.can_view_job_notes is distinct from old.can_view_job_notes or
    new.can_edit_job_notes is distinct from old.can_edit_job_notes or
    new.can_upload_documents is distinct from old.can_upload_documents or
    new.can_review_documents is distinct from old.can_review_documents
  ) then raise exception 'You cannot change your own role, seat status, or permissions.'; end if;
  return new;
end;
$$;
revoke all on function public.pooldocai_guard_member_self_changes() from public, anon, authenticated;
drop trigger if exists company_member_self_change_guard on public.company_members;
create trigger company_member_self_change_guard
before update or delete on public.company_members
for each row execute function public.pooldocai_guard_member_self_changes();

-- Audit member additions, suspensions, role changes, and fine-grained permission changes.
create table if not exists public.company_member_access_audit (
  id bigint generated always as identity primary key,
  company_id uuid not null,
  member_id uuid not null,
  subject_user_id uuid,
  actor_user_id uuid,
  event_type text not null check (event_type in ('member_added','member_updated','member_suspended','member_reactivated','permissions_changed','member_removed')),
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz not null default now()
);
create index if not exists company_member_access_audit_company_created_idx
  on public.company_member_access_audit(company_id, created_at desc);
alter table public.company_member_access_audit enable row level security;
revoke all on public.company_member_access_audit from public, anon;
grant select on public.company_member_access_audit to authenticated;
drop policy if exists company_member_access_audit_admin_read on public.company_member_access_audit;
create policy company_member_access_audit_admin_read on public.company_member_access_audit
for select to authenticated using (public.is_platform_admin() or public.is_company_admin(company_id));
revoke insert, update, delete on public.company_member_access_audit from authenticated;
grant all on public.company_member_access_audit to service_role;
grant usage, select on sequence public.company_member_access_audit_id_seq to service_role;

create or replace function public.pooldocai_audit_member_access_change()
returns trigger language plpgsql security definer set search_path=public, pg_temp as $$
declare old_state jsonb; new_state jsonb; e text; c uuid; mid uuid; uid uuid;
begin
  -- Service-role actions write their own actor-attributed audit row after successful provisioning.
  if coalesce(auth.role(), '') = 'service_role' then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='DELETE' then
    old_state := to_jsonb(old); c := old.company_id; mid := old.id; uid := old.user_id; e := 'member_removed';
    insert into public.company_member_access_audit(company_id,member_id,subject_user_id,actor_user_id,event_type,before_state,after_state)
    values(c,mid,uid,auth.uid(),e,old_state,null);
    return old;
  end if;
  new_state := jsonb_build_object('role',new.role,'status',new.status,'can_view_job_notes',new.can_view_job_notes,'can_edit_job_notes',new.can_edit_job_notes,'can_upload_documents',new.can_upload_documents,'can_review_documents',new.can_review_documents,'display_name',new.display_name);
  c := new.company_id; mid := new.id; uid := new.user_id;
  if tg_op='INSERT' then
    e := 'member_added'; old_state := null;
  else
    old_state := jsonb_build_object('role',old.role,'status',old.status,'can_view_job_notes',old.can_view_job_notes,'can_edit_job_notes',old.can_edit_job_notes,'can_upload_documents',old.can_upload_documents,'can_review_documents',old.can_review_documents,'display_name',old.display_name);
    if old.status='active' and new.status='suspended' then e:='member_suspended';
    elsif old.status='suspended' and new.status='active' then e:='member_reactivated';
    elsif old.role is distinct from new.role then e:='member_updated';
    elsif old.can_view_job_notes is distinct from new.can_view_job_notes or old.can_edit_job_notes is distinct from new.can_edit_job_notes or old.can_upload_documents is distinct from new.can_upload_documents or old.can_review_documents is distinct from new.can_review_documents then e:='permissions_changed';
    else e:='member_updated'; end if;
  end if;
  if tg_op='INSERT' or old_state is distinct from new_state then
    insert into public.company_member_access_audit(company_id,member_id,subject_user_id,actor_user_id,event_type,before_state,after_state)
    values(c,mid,uid,auth.uid(),e,old_state,new_state);
  end if;
  return new;
end;
$$;
revoke all on function public.pooldocai_audit_member_access_change() from public, anon, authenticated;
drop trigger if exists company_member_access_audit_trigger on public.company_members;
create trigger company_member_access_audit_trigger
after insert or update or delete on public.company_members
for each row execute function public.pooldocai_audit_member_access_change();

comment on column public.company_members.can_view_job_notes is 'Member-specific permission to read this company’s technician job notes. Company admins retain full company administration access.';
comment on column public.company_members.can_edit_job_notes is 'Member-specific permission to create or update job notes through trusted APIs.';
comment on column public.company_members.can_upload_documents is 'Member-specific permission to upload, reprocess, and remove company-private document sources.';
comment on column public.company_members.can_review_documents is 'Member-specific permission to inspect extracted text/chunks. Does not grant approval to publish shared learning.';
comment on table public.company_member_access_audit is 'Audit trail for seat assignments, membership state, roles, and company member permission changes; retained even if a membership row is deleted.';

-- ----------------------------------------------------------------------------
-- Migration 10/47: 202610210010_company_admin_safety_fixups.sql
-- ----------------------------------------------------------------------------

-- Follow-up guards for seat permission triggers, subscription controls, and audit sequence access.
-- Safe to run after 001-009; does not delete users, companies, jobs, or manuals.

drop policy if exists companies_update_admin on public.companies;
create policy companies_update_admin on public.companies
for update to authenticated
using (public.is_platform_admin())
with check (public.is_platform_admin());

drop policy if exists manuals_company_read on public.company_manuals;
create policy manuals_company_read on public.company_manuals
for select to authenticated
using (
  public.is_platform_admin()
  or (public.is_company_member(company_id)
      and (public.can_upload_company_documents(company_id) or public.can_review_company_documents(company_id)))
);

-- Recreate the default-permission triggers as separate events for predictable PostgreSQL parsing.
drop trigger if exists company_member_default_permissions on public.company_members;
drop trigger if exists company_member_default_permissions_insert on public.company_members;
drop trigger if exists company_member_default_permissions_update on public.company_members;
create trigger company_member_default_permissions_insert
before insert on public.company_members
for each row execute function public.pooldocai_default_member_permissions();
create trigger company_member_default_permissions_update
before update of role, can_view_job_notes, can_edit_job_notes, can_upload_documents, can_review_documents
on public.company_members
for each row execute function public.pooldocai_default_member_permissions();

-- service_role writes actor-attributed access audit rows from the trusted Edge Function.
grant usage, select on sequence public.company_member_access_audit_id_seq to service_role;

comment on function public.pooldocai_default_member_permissions()
is 'Applies role-aware default permissions and guarantees company_admin seats retain full company permissions.';

-- ----------------------------------------------------------------------------
-- Migration 11/47: 202610210011_demo_quota_and_company_creation_fix.sql
-- ----------------------------------------------------------------------------

-- Forward repair for the public demo SQL ambiguity exposed by the eight-turn regression test.
-- Also grants company creation only to a registered PoolDocAI platform owner from the portal.
-- Does not delete users, memberships, companies, documents, jobs, or learning records.

-- Eight-turn public demo quota with explicit record aliases.
-- The aliases deliberately avoid ambiguity between the RETURNS TABLE output column
-- named turns_used and the table column also named turns_used in UPDATE expressions.
-- Existing session counters are preserved unless their rolling window expires.
create or replace function public.pooldocai_consume_public_demo_turn(
  p_session_hash text,
  p_turn_id text,
  p_max_turns integer default 8,
  p_window_hours integer default 24
)
returns table(allowed boolean, turns_used integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_session public.public_demo_sessions%rowtype;
  v_already_used boolean := false;
  v_effective_limit integer := least(greatest(coalesce(p_max_turns, 8), 1), 8);
  v_effective_window_hours integer := greatest(coalesce(p_window_hours, 24), 1);
begin
  if coalesce(trim(p_session_hash), '') = '' or coalesce(trim(p_turn_id), '') = '' then
    raise exception 'A demo session hash and unique turn ID are required.';
  end if;

  insert into public.public_demo_sessions as demo_session
    (session_hash, turns_used, window_started_at, updated_at)
  values (p_session_hash, 0, now(), now())
  on conflict (session_hash) do nothing;

  select demo_session.*
    into v_session
    from public.public_demo_sessions as demo_session
   where demo_session.session_hash = p_session_hash
   for update;

  if v_session.window_started_at < now() - make_interval(hours => v_effective_window_hours) then
    update public.public_demo_sessions as demo_session
       set turns_used = 0,
           window_started_at = now(),
           updated_at = now()
     where demo_session.session_hash = p_session_hash
     returning demo_session.* into v_session;
  end if;

  select exists (
    select 1
      from public.public_demo_turns as demo_turn
     where demo_turn.session_hash = p_session_hash
       and demo_turn.turn_id = p_turn_id
       and demo_turn.created_at >= v_session.window_started_at
  ) into v_already_used;

  -- Repeated requests for the same turn ID are idempotent and do not consume another turn.
  if v_already_used then
    return query select true, v_session.turns_used;
    return;
  end if;

  if v_session.turns_used >= v_effective_limit then
    return query select false, v_session.turns_used;
    return;
  end if;

  insert into public.public_demo_turns as demo_turn (session_hash, turn_id)
  values (p_session_hash, p_turn_id)
  on conflict (session_hash, turn_id) do nothing;

  update public.public_demo_sessions as demo_session
     set turns_used = demo_session.turns_used + 1,
         updated_at = now()
   where demo_session.session_hash = p_session_hash
   returning demo_session.* into v_session;

  return query select true, v_session.turns_used;
end;
$$;

revoke all on function public.pooldocai_consume_public_demo_turn(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.pooldocai_consume_public_demo_turn(text, text, integer, integer) to service_role;
comment on function public.pooldocai_consume_public_demo_turn(text, text, integer, integer)
is 'Atomically consumes a unique public demo turn; maximum eight turns per mode-specific session per window.';

-- The platform owner portal creates companies through the authenticated Data API.
-- Tenant administrators must never be able to create or alter subscription records.
drop policy if exists companies_platform_insert on public.companies;
drop policy if exists companies_insert_platform_owner on public.companies;
revoke insert on public.companies from public, anon;
grant insert on public.companies to authenticated;
create policy companies_insert_platform_owner on public.companies
for insert to authenticated
with check (public.is_platform_admin());

comment on policy companies_insert_platform_owner on public.companies
is 'Only a registered PoolDocAI platform owner may create a company through the authenticated portal.';

-- ----------------------------------------------------------------------------
-- Migration 12/47: 202610210012_invites_billing_usage_vector_industry.sql
-- ----------------------------------------------------------------------------

-- PoolDocAI feature expansion: invitation lifecycle, Stripe preparation, usage metering,
-- semantic retrieval, page citations, offline idempotency, and modular industry profiles.
-- Forward-only and additive. Existing companies, Auth users, seats, jobs, manuals and cases remain.

create extension if not exists pgcrypto;
create schema if not exists extensions;
create extension if not exists vector with schema extensions;

-- Industry modules are a reusable configuration layer. Pool is enabled; HVAC/plumbing
-- records are intentionally planned until their catalogs, workflows, and safety rules are reviewed.
create table if not exists public.industry_modules (
  industry_key text primary key,
  display_name text not null,
  status text not null default 'planned' check (status in ('active','planned','disabled')),
  module_version integer not null default 1 check (module_version > 0),
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.industry_modules(industry_key,display_name,status,module_version,configuration) values
 ('pool','Swimming Pools','active',1,'{"default_source_order":["company_manual","approved_shared_knowledge","official_manufacturer_web","general_web"],"categories":["pump","heater","filter","salt system","automation","cleaner","water chemistry"],"safety_profile":"pool"}'::jsonb),
 ('hvac','HVAC','planned',1,'{"requires_review_before_activation":true,"safety_profile":"hvac"}'::jsonb),
 ('plumbing','Plumbing','planned',1,'{"requires_review_before_activation":true,"safety_profile":"plumbing"}'::jsonb)
on conflict (industry_key) do nothing;

create table if not exists public.industry_equipment_catalog (
  id uuid primary key default gen_random_uuid(),
  industry_key text not null references public.industry_modules(industry_key) on delete cascade,
  equipment_code text not null,
  display_name text not null,
  manufacturer text,
  model_family text,
  attributes jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(industry_key,equipment_code,manufacturer,model_family)
);
create table if not exists public.industry_diagnostic_workflows (
  id uuid primary key default gen_random_uuid(),
  industry_key text not null references public.industry_modules(industry_key) on delete cascade,
  workflow_key text not null,
  display_name text not null,
  rules jsonb not null default '{}'::jsonb,
  safety_class text not null default 'normal' check (safety_class in ('normal','caution','qualified_technician','emergency_stop')),
  active boolean not null default false,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(industry_key,workflow_key,version)
);
create table if not exists public.industry_safety_rules (
  id uuid primary key default gen_random_uuid(),
  industry_key text not null references public.industry_modules(industry_key) on delete cascade,
  rule_key text not null,
  rule_text text not null,
  severity text not null default 'warning' check (severity in ('info','warning','qualified_technician','emergency_stop')),
  non_bypassable boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(industry_key,rule_key)
);
create table if not exists public.industry_source_ranking_rules (
  id uuid primary key default gen_random_uuid(),
  industry_key text not null references public.industry_modules(industry_key) on delete cascade,
  source_type text not null,
  priority integer not null check (priority between 1 and 1000),
  require_authoritative boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(industry_key,source_type)
);
insert into public.industry_source_ranking_rules(industry_key,source_type,priority,require_authoritative) values
 ('pool','company_manual',10,false),('pool','approved_shared_knowledge',20,false),('pool','official_manufacturer_web',30,true),('pool','general_web',50,true)
on conflict (industry_key,source_type) do nothing;
insert into public.industry_safety_rules(industry_key,rule_key,rule_text,severity,non_bypassable) values
 ('pool','chemical_mixing','Never mix pool chemicals. Keep acid products separate from chlorine products and follow each product label.', 'emergency_stop', true),
 ('pool','energized_equipment','Do not direct homeowners to work on energized equipment, internal electrical parts, gas trains, or bypassed safety switches.', 'qualified_technician', true),
 ('pool','pressurized_filter','Never open a filter or pressure vessel until the equipment is isolated and manufacturer safe-depressurization steps are confirmed.', 'qualified_technician', true)
on conflict (industry_key,rule_key) do nothing;

alter table public.companies add column if not exists industry_key text not null default 'pool';
do $$ begin
  if not exists (select 1 from pg_constraint where conname='companies_industry_key_fkey') then
    alter table public.companies add constraint companies_industry_key_fkey foreign key (industry_key) references public.industry_modules(industry_key);
  end if;
end $$;

alter table public.company_manuals add column if not exists industry_key text not null default 'pool';
update public.company_manuals m set industry_key=c.industry_key from public.companies c where c.id=m.company_id and m.industry_key is distinct from c.industry_key;
alter table public.company_manual_chunks add column if not exists industry_key text not null default 'pool';
update public.company_manual_chunks ch set industry_key=m.industry_key from public.company_manuals m where m.id=ch.manual_id and ch.industry_key is distinct from m.industry_key;
alter table public.company_manual_chunks add column if not exists page_start integer;
alter table public.company_manual_chunks add column if not exists page_end integer;
alter table public.company_manual_chunks add column if not exists embedding extensions.vector(768);
alter table public.company_manual_chunks add column if not exists embedding_model text;
alter table public.company_manual_chunks add column if not exists embedded_at timestamptz;
create index if not exists company_manual_chunks_industry_company_idx on public.company_manual_chunks(industry_key,company_id,manual_id);
create index if not exists company_manual_chunks_embedding_hnsw_idx on public.company_manual_chunks using hnsw (embedding extensions.vector_cosine_ops) where embedding is not null;

-- Replace the keyword-only private-source function with an optional hybrid variant. The
-- original RPC remains intact for compatibility. Company-id and reference-enabled filters
-- are mandatory in both lexical and vector retrieval paths.
create or replace function public.search_company_manual_chunks_hybrid(
  p_company_id uuid,
  p_query text,
  p_embedding extensions.vector(768) default null,
  p_limit integer default 6
)
returns table(id uuid, manual_id uuid, title text, source_url text, page_number integer, page_start integer, page_end integer, content_text text, rank real, retrieval_method text, industry_key text)
language sql stable security definer set search_path=public,extensions,pg_temp as $$
  with candidates as (
    select c.id,c.manual_id,c.title,c.source_url,c.page_number,c.page_start,c.page_end,c.content_text,c.industry_key,
      ts_rank(c.search_vector, websearch_to_tsquery('english', coalesce(left(p_query,1800),'')))::real as lexical_score,
      case when p_embedding is not null and c.embedding is not null then (1 - (c.embedding <=> p_embedding))::real else 0::real end as semantic_score,
      (c.search_vector @@ websearch_to_tsquery('english', coalesce(left(p_query,1800),''))
       or exists (select 1 from regexp_split_to_table(lower(coalesce(p_query,'')), '\s+') as q(word) where length(q.word)>2 and c.content_text ilike '%'||left(q.word,60)||'%')) as lexical_match
    from public.company_manual_chunks c
    join public.company_manuals m on m.id=c.manual_id and m.company_id=c.company_id
    join public.companies co on co.id=c.company_id and co.industry_key=c.industry_key
    join public.industry_modules im on im.industry_key=co.industry_key and im.status='active'
    where c.company_id=p_company_id and m.reference_enabled=true and m.extraction_status='ready'
  ), ranked as (
    select *, greatest(lexical_score, semantic_score * 0.85)::real as combined_score,
      case when lexical_match and semantic_score > 0 then 'hybrid' when lexical_match then 'keyword' else 'semantic' end as method
    from candidates
    where lexical_match or (p_embedding is not null and semantic_score > 0.25)
  )
  select r.id,r.manual_id,r.title,r.source_url,r.page_number,r.page_start,r.page_end,r.content_text,r.combined_score,r.method,r.industry_key
  from ranked r order by r.combined_score desc, r.page_number nulls last limit least(greatest(coalesce(p_limit,6),1),12)
$$;
revoke all on function public.search_company_manual_chunks_hybrid(uuid,text,extensions.vector,integer) from public,anon,authenticated;
grant execute on function public.search_company_manual_chunks_hybrid(uuid,text,extensions.vector,integer) to service_role;

-- Invitation lifecycle columns. A pending/invited member has a suspended membership until acceptance.
alter table public.technician_invitation_requests add column if not exists auth_user_id uuid references auth.users(id) on delete set null;
alter table public.technician_invitation_requests add column if not exists expires_at timestamptz;
alter table public.technician_invitation_requests add column if not exists accepted_at timestamptz;
alter table public.technician_invitation_requests add column if not exists revoked_at timestamptz;
alter table public.technician_invitation_requests add column if not exists last_sent_at timestamptz;
alter table public.technician_invitation_requests add column if not exists existing_auth_user boolean not null default false;
alter table public.technician_invitation_requests add column if not exists invite_permissions jsonb not null default '{}'::jsonb;
update public.technician_invitation_requests set expires_at=coalesce(expires_at,created_at + interval '7 days') where expires_at is null;
do $$ begin
  alter table public.technician_invitation_requests drop constraint if exists technician_invitation_requests_status_check;
  alter table public.technician_invitation_requests add constraint technician_invitation_requests_status_check check(status in ('pending','sent','cancelled','accepted','expired','revoked'));
exception when duplicate_object then null; end $$;
create index if not exists technician_invitations_company_status_idx on public.technician_invitation_requests(company_id,status,created_at desc);
create index if not exists technician_invitations_email_status_idx on public.technician_invitation_requests(lower(invite_email),status,expires_at desc);

-- Durable PWA idempotency key. Replaying a queued job after reconnect cannot create duplicates.
alter table public.technician_job_records add column if not exists client_job_id uuid;
create unique index if not exists technician_jobs_client_idempotency_idx on public.technician_job_records(tenant_id,technician_id,client_job_id) where client_job_id is not null;

-- Meter both quantities and provider-reported token/cost values where available. NULL estimated
-- cost means no model rate card is configured; do not fabricate a cost.
alter table public.platform_usage_events add column if not exists metric_type text not null default 'event';
alter table public.platform_usage_events add column if not exists quantity numeric(20,4) not null default 1;
alter table public.platform_usage_events add column if not exists quantity_unit text not null default 'event';
alter table public.platform_usage_events add column if not exists provider text;
alter table public.platform_usage_events add column if not exists model text;
alter table public.platform_usage_events add column if not exists input_tokens bigint;
alter table public.platform_usage_events add column if not exists output_tokens bigint;
alter table public.platform_usage_events add column if not exists estimated_cost_usd numeric(14,6);
alter table public.platform_usage_events add column if not exists cost_source text not null default 'not_priced' check (cost_source in ('not_priced','rate_card_estimate','provider_reported'));
alter table public.platform_usage_events add column if not exists storage_bytes bigint;
alter table public.platform_usage_events add column if not exists extracted_characters bigint;
alter table public.platform_usage_events add column if not exists duration_ms integer;
alter table public.platform_usage_events add column if not exists source_event_key text;
alter table public.platform_usage_events add column if not exists period_start date not null default date_trunc('month',now())::date;
create unique index if not exists platform_usage_source_event_key_idx on public.platform_usage_events(source_event_key) where source_event_key is not null;
create index if not exists platform_usage_company_period_idx on public.platform_usage_events(company_id,period_start,event_type,created_at desc);

create table if not exists public.pooldocai_model_rate_cards (
  id uuid primary key default gen_random_uuid(), provider text not null, model text not null,
  input_usd_per_million_tokens numeric(14,8), output_usd_per_million_tokens numeric(14,8),
  active boolean not null default true, valid_from timestamptz not null default now(), valid_to timestamptz,
  created_at timestamptz not null default now(), unique(provider,model,valid_from)
);
create table if not exists public.pooldocai_usage_alerts (
  id uuid primary key default gen_random_uuid(), company_id uuid references public.companies(id) on delete cascade,
  period_start date not null, metric_type text not null check(metric_type in ('ai_requests','document_characters','storage_bytes')),
  threshold_percent integer not null check(threshold_percent in (80,100)), observed_value numeric(20,4) not null,
  limit_value numeric(20,4) not null, status text not null default 'open' check(status in ('open','acknowledged','resolved')),
  created_at timestamptz not null default now(), acknowledged_at timestamptz,
  unique(company_id,period_start,metric_type,threshold_percent)
);
create table if not exists public.pooldocai_stripe_webhook_events (
  stripe_event_id text primary key, event_type text not null, processed boolean not null default false,
  processing_error text, received_at timestamptz not null default now(), processed_at timestamptz
);
alter table public.companies add column if not exists stripe_customer_id text;
alter table public.companies add column if not exists stripe_subscription_id text;
alter table public.companies add column if not exists stripe_price_id text;
alter table public.companies add column if not exists billing_period_start timestamptz;
alter table public.companies add column if not exists trial_ends_at timestamptz;
alter table public.companies add column if not exists monthly_ai_request_limit bigint;
alter table public.companies add column if not exists monthly_document_character_limit bigint;
alter table public.companies add column if not exists storage_limit_bytes bigint;

alter table public.pooldocai_model_rate_cards enable row level security;
alter table public.pooldocai_usage_alerts enable row level security;
alter table public.pooldocai_stripe_webhook_events enable row level security;
alter table public.industry_modules enable row level security;
alter table public.industry_equipment_catalog enable row level security;
alter table public.industry_diagnostic_workflows enable row level security;
alter table public.industry_safety_rules enable row level security;
alter table public.industry_source_ranking_rules enable row level security;
revoke all on public.pooldocai_model_rate_cards,public.pooldocai_usage_alerts,public.pooldocai_stripe_webhook_events,public.industry_modules,public.industry_equipment_catalog,public.industry_diagnostic_workflows,public.industry_safety_rules,public.industry_source_ranking_rules from anon,authenticated;
grant all on public.pooldocai_model_rate_cards,public.pooldocai_usage_alerts,public.pooldocai_stripe_webhook_events to service_role;
grant all on public.industry_modules,public.industry_equipment_catalog,public.industry_diagnostic_workflows,public.industry_safety_rules,public.industry_source_ranking_rules to service_role;
create policy industry_modules_active_read on public.industry_modules for select to authenticated using(status='active');
create policy industry_catalog_active_read on public.industry_equipment_catalog for select to authenticated using(active and exists(select 1 from public.industry_modules im where im.industry_key=industry_equipment_catalog.industry_key and im.status='active'));
create policy industry_workflows_active_read on public.industry_diagnostic_workflows for select to authenticated using(active and exists(select 1 from public.industry_modules im where im.industry_key=industry_diagnostic_workflows.industry_key and im.status='active'));
create policy industry_safety_active_read on public.industry_safety_rules for select to authenticated using(active and exists(select 1 from public.industry_modules im where im.industry_key=industry_safety_rules.industry_key and im.status='active'));
create policy industry_sources_active_read on public.industry_source_ranking_rules for select to authenticated using(active and exists(select 1 from public.industry_modules im where im.industry_key=industry_source_ranking_rules.industry_key and im.status='active'));
create policy usage_alerts_company_or_platform_read on public.pooldocai_usage_alerts for select to authenticated using(public.is_platform_admin() or public.is_company_admin(company_id));
create policy model_rates_platform_read on public.pooldocai_model_rate_cards for select to authenticated using(public.is_platform_admin());

comment on table public.industry_modules is 'Reusable industry layer for catalogs, diagnostic workflows, safety policy, and source ranking; activation requires reviewed configuration.';
comment on table public.pooldocai_model_rate_cards is 'Versioned token prices used for estimated—not guaranteed invoice—provider cost accounting. Configure current rates from the provider before relying on costs.';
comment on table public.pooldocai_stripe_webhook_events is 'Idempotency/audit ledger for verified Stripe webhook events; no payment data or card details are stored.';
comment on column public.company_manual_chunks.page_number is 'PDF page number when extracted with page-preserving parsing; NULL when the source does not provide a reliable page number.';

-- ----------------------------------------------------------------------------
-- Migration 13/47: 202610210013_offline_sync_invitation_hardening.sql
-- ----------------------------------------------------------------------------

-- PoolDocAI feature hardening (migration 013).
-- Additive, forward-only changes: do not delete user, company, job, manual, or audit history.

-- Stable client-generated IDs let the technician PWA safely retry the same queued insert.
alter table public.technician_job_records
  add column if not exists client_job_id uuid,
  add column if not exists sync_version integer not null default 1,
  add column if not exists last_synced_at timestamptz;
create unique index if not exists technician_jobs_client_idempotency_idx
  on public.technician_job_records(tenant_id, technician_id, client_job_id)
  where client_job_id is not null;
create index if not exists technician_jobs_company_sync_idx
  on public.technician_job_records(tenant_id, updated_at desc, sync_version desc);

create or replace function public.pooldocai_touch_job_sync_version()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  new.updated_at := now();
  new.sync_version := coalesce(old.sync_version, 0) + 1;
  new.last_synced_at := now();
  return new;
end;
$$;
revoke all on function public.pooldocai_touch_job_sync_version() from public,anon,authenticated;
drop trigger if exists technician_job_sync_version_trigger on public.technician_job_records;
create trigger technician_job_sync_version_trigger
before update on public.technician_job_records
for each row execute function public.pooldocai_touch_job_sync_version();

-- Expire invitation rows consistently without deleting history. Only trusted server tooling
-- may execute this maintenance function; the application also checks expires_at on acceptance.
create or replace function public.pooldocai_expire_company_invitations()
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare affected integer;
begin
  update public.technician_invitation_requests
     set status='expired'
   where status in ('pending','sent') and expires_at is not null and expires_at < now();
  get diagnostics affected = row_count;
  return affected;
end;
$$;
revoke all on function public.pooldocai_expire_company_invitations() from public,anon,authenticated;
grant execute on function public.pooldocai_expire_company_invitations() to service_role;

create index if not exists pooldocai_usage_events_company_metric_created_idx
  on public.platform_usage_events(company_id, metric_type, created_at desc);
create index if not exists pooldocai_usage_events_cost_idx
  on public.platform_usage_events(company_id, created_at desc)
  where estimated_cost_usd is not null;

-- Restrict webhook ledger to server role only. Client users must never write payment events.
alter table public.pooldocai_stripe_webhook_events enable row level security;
revoke all on public.pooldocai_stripe_webhook_events from anon,authenticated;
grant all on public.pooldocai_stripe_webhook_events to service_role;

-- Invite acceptance is authenticated through Supabase Auth. A client must not activate its
-- own membership directly without passing through the Edge Function invitation checks.
comment on column public.technician_invitation_requests.expires_at is 'Invitation expires at this time. Acceptance checks this timestamp server-side; history is retained.';
comment on column public.technician_job_records.client_job_id is 'Client-generated idempotency key used by the technician offline outbox; repeated uploads resolve to the existing job.';
comment on column public.technician_job_records.sync_version is 'Monotonic version incremented by the database when an existing job record is updated.';

-- ----------------------------------------------------------------------------
-- Migration 14/47: 202610210014_industry_activation_guard.sql
-- ----------------------------------------------------------------------------

-- PoolDocAI migration 014: prevent unreviewed industries from using a different module's rules.
-- Additive: existing PoolDocAI companies remain on the active pool module and no records are deleted.
create or replace function public.pooldocai_validate_company_industry_active()
returns trigger
language plpgsql
security definer
set search_path=public,pg_temp
as $$
declare module_status text;
begin
  select im.status into module_status
  from public.industry_modules im
  where im.industry_key = new.industry_key;
  if module_status is distinct from 'active' then
    raise exception 'Industry module % is not active. Review its catalogs, workflows, source ranking and safety rules before assigning a company.', coalesce(new.industry_key,'(null)')
      using errcode='23514';
  end if;
  return new;
end;
$$;
revoke all on function public.pooldocai_validate_company_industry_active() from public,anon,authenticated;
drop trigger if exists companies_industry_active_guard on public.companies;
create trigger companies_industry_active_guard
before insert or update of industry_key on public.companies
for each row execute function public.pooldocai_validate_company_industry_active();

comment on function public.pooldocai_validate_company_industry_active()
is 'Blocks company assignment to planned/disabled industry modules until module safety and diagnostic content are reviewed and explicitly activated.';

-- ----------------------------------------------------------------------------
-- Migration 15/47: 202610210015_temporary_platform_trial_credentials.sql
-- ----------------------------------------------------------------------------

-- Migration 015: platform-owner-issued temporary full-experience credentials.
-- Additive: existing accounts and companies are preserved.
create table if not exists public.temporary_access_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  note text,
  check (expires_at > created_at and expires_at <= created_at + interval '24 hours')
);
create index if not exists temporary_access_grants_expiry_idx on public.temporary_access_grants(expires_at) where revoked_at is null;
alter table public.temporary_access_grants enable row level security;
revoke all on public.temporary_access_grants from anon, authenticated;
grant select, insert, update on public.temporary_access_grants to service_role;

create or replace function public.temporary_access_is_valid(p_user_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select not exists (select 1 from public.temporary_access_grants g where g.user_id=p_user_id)
    or exists (select 1 from public.temporary_access_grants g where g.user_id=p_user_id and g.revoked_at is null and g.expires_at > now());
$$;
revoke all on function public.temporary_access_is_valid(uuid) from public, anon;
grant execute on function public.temporary_access_is_valid(uuid) to authenticated, service_role;

-- Restrictive policy is an additional gate: it cannot widen existing table policies.
-- Expired/revoked temporary accounts lose direct Data API access even if their JWT remains unexpired.
do $$ declare t record; begin
  for t in select schemaname, tablename from pg_tables where schemaname='public' and rowsecurity loop
    execute format('drop policy if exists temporary_access_expiry_guard on %I.%I', t.schemaname, t.tablename);
    execute format('create policy temporary_access_expiry_guard on %I.%I as restrictive for all to authenticated using (public.temporary_access_is_valid(auth.uid())) with check (public.temporary_access_is_valid(auth.uid()))', t.schemaname, t.tablename);
  end loop;
end $$;

comment on table public.temporary_access_grants is 'Platform-owner-created full-experience trial credentials with a hard expiry between 30 minutes and 24 hours. No model training or shared-learning privilege is granted.';

-- ----------------------------------------------------------------------------
-- Migration 16/47: 20261021001630_diagnostic_learning_sessions_consent_workflow_feedback.sql
-- ----------------------------------------------------------------------------

-- Migration 016: durable diagnostic learning sessions, explicit company consent, and workflow-evaluation outcomes.
-- Additive and forward-only. Existing cases, memberships, companies, and approved knowledge remain intact.
create extension if not exists pgcrypto;

alter table public.diagnostic_cases
  add column if not exists client_session_id text,
  add column if not exists outcome_status text not null default 'in_progress',
  add column if not exists outcome_evidence_redacted text,
  add column if not exists last_activity_at timestamptz not null default now();

do $$ begin
  if not exists (select 1 from pg_constraint where conname='diagnostic_cases_outcome_status_allowed') then
    alter table public.diagnostic_cases add constraint diagnostic_cases_outcome_status_allowed
      check (outcome_status in ('in_progress','customer_reported_resolved','technician_confirmed_diagnosis','verified_repair','unresolved','technician_handoff'));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname='diagnostic_cases_client_session_id_format') then
    alter table public.diagnostic_cases add constraint diagnostic_cases_client_session_id_format
      check (client_session_id is null or client_session_id ~ '^[A-Za-z0-9_-]{8,80}$');
  end if;
end $$;
create unique index if not exists diagnostic_cases_tenant_client_session_uidx
  on public.diagnostic_cases(tenant_id, client_session_id) where client_session_id is not null and tenant_id is not null;
create index if not exists diagnostic_cases_outcome_recent_idx on public.diagnostic_cases(tenant_id,outcome_status,last_activity_at desc);

alter table public.diagnostic_case_steps add column if not exists turn_metadata jsonb not null default '{}'::jsonb;
alter table public.learning_review_queue add column if not exists outcome_status text;
alter table public.learning_review_queue add column if not exists workflow_version text;
alter table public.learning_review_queue add column if not exists evidence_summary_redacted text;

alter table public.companies
  add column if not exists diagnostic_learning_opt_in boolean not null default false,
  add column if not exists diagnostic_learning_consent_updated_at timestamptz,
  add column if not exists diagnostic_learning_consent_updated_by uuid references auth.users(id) on delete set null;

create table if not exists public.diagnostic_learning_consent_audit (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  old_opt_in boolean not null,
  new_opt_in boolean not null,
  created_at timestamptz not null default now()
);
alter table public.diagnostic_learning_consent_audit enable row level security;
revoke all on public.diagnostic_learning_consent_audit from public, anon, authenticated;
grant all on public.diagnostic_learning_consent_audit to service_role;

alter table public.learning_review_audit drop constraint if exists learning_review_audit_action_check;
alter table public.learning_review_audit add constraint learning_review_audit_action_check
  check (action in ('approved','rejected','reopened','consent_withdrawn'));

create or replace function public.pooldocai_audit_diagnostic_learning_consent()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.diagnostic_learning_opt_in is distinct from old.diagnostic_learning_opt_in then
    new.diagnostic_learning_consent_updated_at := now();
    new.diagnostic_learning_consent_updated_by := auth.uid();
    insert into public.diagnostic_learning_consent_audit(company_id,actor_user_id,old_opt_in,new_opt_in)
    values(new.id,auth.uid(),old.diagnostic_learning_opt_in,new.diagnostic_learning_opt_in);
    if old.diagnostic_learning_opt_in and not new.diagnostic_learning_opt_in then
      -- Withdrawal immediately removes this company's case-derived lessons from shared RAG.
      insert into public.learning_review_audit(queue_id,case_id,actor_user_id,action,note_redacted)
      select q.id,q.case_id,auth.uid(),'consent_withdrawn','Company withdrew diagnostic shared-learning consent; shared publication revoked.'
      from public.learning_review_queue q
      where q.tenant_id=new.id and q.source_kind <> 'company_manual' and q.status in ('pending','approved');
      update public.learning_review_queue q set status='rejected',reviewed_by=auth.uid(),reviewed_at=now()
      where q.tenant_id=new.id and q.source_kind <> 'company_manual' and q.status='pending';
      update public.diagnostic_cases c set approved_for_learning=false,privacy_reviewed_at=null
      where c.tenant_id=new.id and c.approved_for_learning=true;
      delete from public.shared_learning_knowledge k where k.source_company_id=new.id and k.source_kind <> 'company_manual';
    end if;
  end if;
  return new;
end; $$;
revoke all on function public.pooldocai_audit_diagnostic_learning_consent() from public,anon,authenticated;
drop trigger if exists companies_diagnostic_learning_consent_audit on public.companies;
create trigger companies_diagnostic_learning_consent_audit before update of diagnostic_learning_opt_in on public.companies
for each row execute function public.pooldocai_audit_diagnostic_learning_consent();

-- Store workflow feedback separately from reusable knowledge. Feedback is evidence for future
-- workflow evaluation only; it is never published to retrieval or model training automatically.
create table if not exists public.diagnostic_workflow_feedback (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.diagnostic_cases(id) on delete cascade,
  tenant_id uuid references public.companies(id) on delete set null,
  workflow_key text,
  workflow_version text,
  feedback_type text not null check (feedback_type in ('helpful','not_helpful','wrong_branch','missing_question','unsafe','resolved','unresolved','handoff_needed')),
  note_redacted text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (note_redacted is null or length(note_redacted) <= 1200)
);
create index if not exists diagnostic_workflow_feedback_tenant_recent_idx on public.diagnostic_workflow_feedback(tenant_id,created_at desc);
alter table public.diagnostic_workflow_feedback enable row level security;
revoke all on public.diagnostic_workflow_feedback from public,anon,authenticated;
grant all on public.diagnostic_workflow_feedback to service_role;

comment on column public.companies.diagnostic_learning_opt_in is 'Explicit company-wide consent for redacted diagnostic case outcomes to be considered for shared learning. Defaults off; distinct from private company retrieval and per-document consent.';
comment on table public.diagnostic_workflow_feedback is 'Evaluation signals for improving diagnostic workflows. Never automatically published as knowledge or used for fine-tuning.';

-- ----------------------------------------------------------------------------
-- Migration 17/47: 202610210016_restrict_trigger_function_execution.sql
-- ----------------------------------------------------------------------------

-- Migration 016: prevent direct API invocation of trigger-only SECURITY DEFINER functions.
-- PostgreSQL executes trigger functions as part of their attached triggers; callers do
-- not need direct EXECUTE privilege to fire those triggers.
-- This removes unnecessary RPC entry points without changing trigger behavior.

REVOKE ALL ON FUNCTION public.enforce_company_seat_limit()
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.protect_company_plan_fields()
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.pooldocai_audit_initial_document_consent()
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.enforce_company_seat_limit() IS
  'Trigger-only function. Direct API execution is intentionally revoked.';
COMMENT ON FUNCTION public.protect_company_plan_fields() IS
  'Trigger-only function. Direct API execution is intentionally revoked.';
COMMENT ON FUNCTION public.pooldocai_audit_initial_document_consent() IS
  'Trigger-only function. Direct API execution is intentionally revoked.';

-- ----------------------------------------------------------------------------
-- Migration 18/47: 202610210017_legal_document_rights_and_private_sop_guard.sql
-- ----------------------------------------------------------------------------

-- Migration 017: document upload rights attestation and private-only company SOP/policy guard.
-- Additive. Existing company documents default to private and are not newly shared.
create extension if not exists pgcrypto;

alter table public.company_manuals
  add column if not exists rights_attested_at timestamptz,
  add column if not exists rights_attested_by uuid references auth.users(id) on delete set null,
  add column if not exists knowledge_scope text not null default 'company_private',
  add column if not exists general_learning_rights_attested boolean not null default false;

-- Normalize older company-specific manuals/SOP/policy documents before adding a validated check constraint.
update public.company_manuals set shared_learning_opt_in=false, knowledge_scope='company_private'
where (lower(coalesce(document_type,'')) in ('company_manual','sop','policy') and (shared_learning_opt_in=true or knowledge_scope <> 'company_private'))
   or (shared_learning_opt_in=true and (general_learning_rights_attested=false or knowledge_scope <> 'general_candidate'));

do $$ begin
  if not exists (select 1 from pg_constraint where conname='company_manuals_knowledge_scope_allowed') then
    alter table public.company_manuals add constraint company_manuals_knowledge_scope_allowed
      check (knowledge_scope in ('company_private','general_candidate'));
  end if;
  if not exists (select 1 from pg_constraint where conname='company_sop_policy_never_general') then
    alter table public.company_manuals add constraint company_sop_policy_never_general
      check (not (lower(coalesce(document_type,'')) in ('company_manual','sop','policy') and (knowledge_scope <> 'company_private' or shared_learning_opt_in = true)));
  end if;
  if not exists (select 1 from pg_constraint where conname='company_manual_general_rights_attestation_required') then
    alter table public.company_manuals add constraint company_manual_general_rights_attestation_required
      check (shared_learning_opt_in = false or (knowledge_scope = 'general_candidate' and general_learning_rights_attested = true));
  end if;
end $$;

-- Remove any related shared-learning queue/publication records before release.
update public.learning_review_queue q set status='rejected', reviewed_at=now(),
  evidence_summary_redacted=left(concat_ws(' ', evidence_summary_redacted, 'Uploader did not record explicit general-knowledge redistribution rights; private reference retained.'),1200)
where q.source_kind='company_manual' and exists (
  select 1 from public.company_manuals m where q.tenant_id=m.company_id and q.supporting_source_ids @> array[m.id::text]
    and m.shared_learning_opt_in=false
) and q.status in ('pending','approved');

delete from public.shared_learning_knowledge k
where k.source_kind='company_manual' and exists (
  select 1 from public.learning_review_queue q join public.company_manuals m
    on q.tenant_id=m.company_id and q.supporting_source_ids @> array[m.id::text]
  where q.id=k.source_queue_id and m.shared_learning_opt_in=false
);

update public.learning_review_queue q set status='rejected', reviewed_at=now(),
  evidence_summary_redacted=left(concat_ws(' ', evidence_summary_redacted, 'Private-only company-specific manual/SOP/policy; removed from shared-learning eligibility by migration 017.'),1200)
where q.source_kind='company_manual' and exists (
  select 1 from public.company_manuals m
  where lower(coalesce(m.document_type,'')) in ('sop','policy')
    and q.tenant_id=m.company_id and q.supporting_source_ids @> array[m.id::text]
) and q.status in ('pending','approved');

delete from public.shared_learning_knowledge k
where k.source_kind='company_manual' and exists (
  select 1 from public.learning_review_queue q join public.company_manuals m
    on q.tenant_id=m.company_id and q.supporting_source_ids @> array[m.id::text]
  where q.id=k.source_queue_id and lower(coalesce(m.document_type,'')) in ('sop','policy')
);

comment on column public.company_manuals.rights_attested_at is 'Timestamp when uploader affirmed they have rights to upload and authorize the selected processing.';
comment on column public.company_manuals.rights_attested_by is 'Authenticated uploader who made the rights attestation.';
comment on column public.company_manuals.knowledge_scope is 'Company documents default to company_private. General candidate is reserved for eligible non-confidential material and still requires platform-owner approval.';
comment on column public.company_manuals.general_learning_rights_attested is 'Uploader explicitly attested to sufficient rights for eligible non-confidential content to be proposed for the general knowledge base.';

-- Bind each diagnostic case to the accepted terms version before it can be considered for shared learning.
alter table public.diagnostic_cases
  add column if not exists learning_permission_granted boolean not null default false,
  add column if not exists legal_terms_version text,
  add column if not exists created_by uuid references auth.users(id) on delete set null;

-- Versioned agreement acceptance for authenticated company workspace access.
create table if not exists public.pooldocai_legal_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  terms_version text not null,
  privacy_version text not null,
  accepted_at timestamptz not null default now(),
  acceptance_source text not null default 'authenticated_workspace',
  unique(user_id, company_id, terms_version, privacy_version)
);
alter table public.pooldocai_legal_acceptances enable row level security;
revoke all on public.pooldocai_legal_acceptances from public, anon, authenticated;
grant all on public.pooldocai_legal_acceptances to service_role;
create index if not exists pooldocai_legal_acceptances_company_idx on public.pooldocai_legal_acceptances(company_id, accepted_at desc);
comment on table public.pooldocai_legal_acceptances is 'Versioned terms/privacy acceptance records. Access only through the authenticated server-side handler.';

-- The current policy is governed by each user's versioned agreement acceptance and case-level permission snapshot.
-- Retire the former company opt-in trigger so an obsolete flag cannot silently erase approved diagnostic lessons.
drop trigger if exists companies_diagnostic_learning_consent_audit on public.companies;
comment on column public.companies.diagnostic_learning_opt_in is 'Legacy field retained for compatibility only. Current diagnostic learning eligibility is tied to versioned user agreement acceptance recorded on each case and platform-owner review.';

-- Enforce the uploader attestation at the database boundary, not only in the website.
create or replace function public.pooldocai_enforce_manual_rights_scope()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null and not exists (
      select 1 from public.pooldocai_legal_acceptances a
      where a.user_id=auth.uid() and a.company_id=new.company_id
        and a.terms_version='2026-10-21-v1' and a.privacy_version='2026-10-21-v1'
    ) then
      raise exception 'Accept current PoolDocAI Terms and Privacy Policy before uploading company documents';
    end if;
    if new.rights_attested_at is null or new.rights_attested_by is null then
      raise exception 'Document upload requires a recorded uploader-rights attestation';
    end if;
    if auth.uid() is not null and new.rights_attested_by is distinct from auth.uid() then
      raise exception 'Document rights attestation must be made by the authenticated uploader';
    end if;
  end if;
  if new.shared_learning_opt_in = true then
    if new.rights_attested_at is null or new.rights_attested_by is null then
      raise exception 'Shared-learning candidate requires an uploader-rights attestation';
    end if;
    if new.general_learning_rights_attested is distinct from true or new.knowledge_scope <> 'general_candidate' then
      raise exception 'General knowledge requires separate redistribution-rights attestation and general_candidate scope';
    end if;
    if lower(coalesce(new.document_type,'')) in ('company_manual','sop','policy') then
      raise exception 'Company-specific manuals, SOPs, and policies must remain private';
    end if;
  end if;
  return new;
end; $$;
revoke all on function public.pooldocai_enforce_manual_rights_scope() from public,anon,authenticated;
drop trigger if exists company_manuals_enforce_rights_scope on public.company_manuals;
create trigger company_manuals_enforce_rights_scope
before insert or update on public.company_manuals
for each row execute function public.pooldocai_enforce_manual_rights_scope();
comment on function public.pooldocai_enforce_manual_rights_scope() is 'Database-level guard for uploader rights attestation and private-only company documents.';

-- ----------------------------------------------------------------------------
-- Migration 19/47: 202610210018_public_demo_learning_consent_capture.sql
-- ----------------------------------------------------------------------------

-- Migration 018: explicit public-demo/widget learning notice and privacy-minimized case capture.
-- Additive: does not change existing accounts, company cases, or published knowledge.
create extension if not exists pgcrypto;

create table if not exists public.pooldocai_public_demo_learning_acceptances (
  session_hash text primary key check (session_hash ~ '^[a-f0-9]{64}$'),
  terms_version text not null,
  privacy_version text not null,
  notice_version text not null,
  acceptance_source text not null check (acceptance_source in ('public_demo','customer_widget')),
  demo_mode text not null check (demo_mode in ('homeowner','field-tech')),
  accepted_terms boolean not null check (accepted_terms = true),
  acknowledged_privacy boolean not null check (acknowledged_privacy = true),
  acknowledged_diagnostic_learning boolean not null check (acknowledged_diagnostic_learning = true),
  accepted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.pooldocai_public_demo_learning_acceptances enable row level security;
revoke all on public.pooldocai_public_demo_learning_acceptances from public, anon, authenticated;
grant all on public.pooldocai_public_demo_learning_acceptances to service_role;

create table if not exists public.public_demo_learning_events (
  id uuid primary key default gen_random_uuid(),
  session_hash text not null references public.pooldocai_public_demo_learning_acceptances(session_hash) on delete cascade,
  turn_id text not null check (length(turn_id) between 8 and 160),
  demo_mode text not null check (demo_mode in ('homeowner','field-tech')),
  user_message_redacted text not null default '',
  assistant_response_redacted text not null default '',
  outcome_status text not null default 'in_progress' check (outcome_status in ('in_progress','customer_reported_resolved','unresolved','technician_handoff')),
  created_at timestamptz not null default now(),
  unique(session_hash, turn_id),
  check (length(user_message_redacted) <= 1800),
  check (length(assistant_response_redacted) <= 3600)
);
create index if not exists public_demo_learning_events_session_idx on public.public_demo_learning_events(session_hash, created_at);
alter table public.public_demo_learning_events enable row level security;
revoke all on public.public_demo_learning_events from public, anon, authenticated;
grant all on public.public_demo_learning_events to service_role;
comment on table public.pooldocai_public_demo_learning_acceptances is 'Versioned acceptance of Terms, Privacy notice, and general-knowledge learning disclosure for public demo/customer-widget sessions. Only opaque session digests are stored.';
comment on table public.public_demo_learning_events is 'Privacy-minimized public demo/widget troubleshooting turn evidence. Raw session IDs, direct identifiers, and image bytes must never be stored.';

-- Allow the public-demo case source in the review queue while retaining the same human approval gate.
alter table public.learning_review_queue drop constraint if exists learning_review_queue_source_kind_check;
alter table public.learning_review_queue add constraint learning_review_queue_source_kind_check
  check (source_kind in ('diagnostic_case','technician_job','authenticated_troubleshooter','company_manual','public_demo'));

-- Public demo cases can be indexed by a one-way session digest; no company tenant is assigned.
create unique index if not exists diagnostic_cases_public_session_uidx
  on public.diagnostic_cases(client_session_id)
  where tenant_id is null and client_session_id is not null;

-- ----------------------------------------------------------------------------
-- Migration 20/47: 202610220001_tenant_widget_service_routing.sql
-- ----------------------------------------------------------------------------

-- PoolDocAI reviewed migration 019. Policy hardening applied during preflight review:
-- preserves is_company_operator(company_id) for assigned-technician UPDATEs, rather than
-- widening the previous policy to every company member.
-- Run as one transaction so an SQL error does not leave a partial migration behind.

BEGIN;
-- Migration 019: tenant-specific public widget configuration and customer service handoff.
-- Public widget actions are routed by an opaque widget key plus the actual HTTP Origin.
-- Customer contact details are stored only on the owning company's service request; never in the shared learning tables.
create extension if not exists pgcrypto;

create table if not exists public.company_widget_configs (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null unique references public.companies(id) on delete cascade,
  widget_key text not null unique default encode(gen_random_bytes(24),'hex'),
  enabled boolean not null default false,
  display_name text not null default 'Pool Service',
  welcome_message text not null default 'Describe the pool or equipment problem and we will help you work through safe next checks.',
  accent_color text not null default '#075985' check (accent_color ~ '^#[0-9A-Fa-f]{6}$'),
  allowed_origins text[] not null default '{}',
  service_request_enabled boolean not null default true,
  email_notifications_enabled boolean not null default false,
  notification_email text,
  email_recipient_confirmed boolean not null default false,
  sms_notifications_enabled boolean not null default false,
  notification_phone text,
  sms_recipient_opt_in boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint widget_name_len check (length(display_name) between 1 and 100),
  constraint widget_welcome_len check (length(welcome_message) between 1 and 450),
  constraint widget_origin_count check (cardinality(allowed_origins) <= 30),
  constraint widget_email_confirm_guard check (email_notifications_enabled = false or (notification_email is not null and email_recipient_confirmed = true)),
  constraint widget_sms_confirm_guard check (sms_notifications_enabled = false or (notification_phone is not null and sms_recipient_opt_in = true))
);
create index if not exists company_widget_configs_enabled_idx on public.company_widget_configs(enabled,company_id);
alter table public.company_widget_configs enable row level security;
revoke all on public.company_widget_configs from public, anon;
revoke insert, update, delete on public.company_widget_configs from authenticated;
grant select on public.company_widget_configs to authenticated;
drop policy if exists company_widget_config_admin_read on public.company_widget_configs;
create policy company_widget_config_admin_read on public.company_widget_configs
  for select to authenticated using (public.is_platform_admin() or public.is_company_admin(company_id));

-- Bind a widget acceptance to both the subscriber company and the specific widget key.
alter table public.pooldocai_public_demo_learning_acceptances
  add column if not exists company_id uuid references public.companies(id) on delete cascade,
  add column if not exists widget_key text;
create index if not exists public_acceptances_company_widget_idx
  on public.pooldocai_public_demo_learning_acceptances(company_id,widget_key,accepted_at desc);

-- Tenant-private service requests from the customer widget. Contact data never goes in diagnostic_cases,
-- diagnostic_case_steps, public_demo_learning_events, or shared-learning candidates.
alter table public.service_requests
  add column if not exists source_type text not null default 'admin',
  add column if not exists requester_name text,
  add column if not exists requester_email text,
  add column if not exists requester_phone text,
  add column if not exists service_address text,
  add column if not exists equipment_summary text,
  add column if not exists troubleshooting_summary text,
  add column if not exists conversation_redacted jsonb not null default '[]'::jsonb,
  add column if not exists diagnostic_case_id uuid references public.diagnostic_cases(id) on delete set null,
  add column if not exists widget_config_id uuid references public.company_widget_configs(id) on delete set null,
  add column if not exists public_idempotency_key text;
do $$ begin
  if not exists(select 1 from pg_constraint where conname='service_requests_source_type_check') then
    alter table public.service_requests add constraint service_requests_source_type_check check(source_type in ('admin','customer_widget'));
  end if;
  if not exists(select 1 from pg_constraint where conname='service_requests_customer_text_lengths') then
    alter table public.service_requests add constraint service_requests_customer_text_lengths check(
      (requester_name is null or length(requester_name)<=120) and
      (requester_email is null or length(requester_email)<=254) and
      (requester_phone is null or length(requester_phone)<=40) and
      (service_address is null or length(service_address)<=300) and
      (equipment_summary is null or length(equipment_summary)<=700) and
      (troubleshooting_summary is null or length(troubleshooting_summary)<=5000) and
      length(request_summary)<=2000
    );
  end if;
end $$;
create unique index if not exists service_requests_company_idempotency_uidx
  on public.service_requests(company_id,public_idempotency_key) where public_idempotency_key is not null;
create index if not exists service_requests_company_source_created_idx
  on public.service_requests(company_id,source_type,created_at desc);

-- Company-admin-visible provider delivery status; service role alone may write delivery records.
create table if not exists public.service_request_notifications (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  service_request_id uuid not null references public.service_requests(id) on delete cascade,
  channel text not null check(channel in ('email','sms')),
  recipient text not null,
  status text not null default 'pending',
  attempt_count integer not null default 0 check(attempt_count>=0),
  provider_message_id text,
  last_error_code text,
  last_attempt_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint service_request_notifications_status_check
    check (status in ('pending','sent','failed','not_configured','disabled')),
  unique(service_request_id,channel)
);
create index if not exists service_request_notifications_company_recent_idx
  on public.service_request_notifications(company_id,created_at desc);
alter table public.service_request_notifications enable row level security;
revoke all on public.service_request_notifications from public, anon;
revoke insert, update, delete on public.service_request_notifications from authenticated;
grant select on public.service_request_notifications to authenticated;
drop policy if exists service_request_notifications_admin_read on public.service_request_notifications;
create policy service_request_notifications_admin_read on public.service_request_notifications for select to authenticated
  using (public.is_platform_admin() or public.is_company_admin(company_id));

-- Prevent read-only seats from seeing homeowner contact details; admins and technicians in the owning tenant can view.
drop policy if exists requests_read on public.service_requests;
create policy requests_read on public.service_requests for select to authenticated using (
  public.is_platform_admin() or exists (
    select 1 from public.company_members m
    where m.company_id=service_requests.company_id and m.user_id=auth.uid() and m.status='active'
      and (m.role in ('company_admin','technician') or service_requests.assigned_technician=auth.uid())
  )
);

-- Keep row ownership stable when an assigned technician updates a request. Company admins
-- can assign/reassign within their tenant; a technician must remain the assigned technician.
drop policy if exists requests_admin_update on public.service_requests;
create policy requests_admin_update on public.service_requests for update to authenticated
  using (public.is_platform_admin() or public.is_company_admin(company_id) or (assigned_technician=auth.uid() and public.is_company_operator(company_id)))
  with check (public.is_platform_admin() or public.is_company_admin(company_id) or (assigned_technician=auth.uid() and public.is_company_operator(company_id)));

comment on table public.company_widget_configs is 'Tenant-specific public widget configuration; widget key identifies a company, and the server validates HTTP Origin against allowed_origins on public actions.';
comment on table public.service_request_notifications is 'Per-company email/SMS delivery attempts; provider credentials are server-side secrets only.';
comment on column public.service_requests.conversation_redacted is 'Privacy-minimized transcript snapshot for the owning company service team. Do not place contact details here.';

-- Separate anti-abuse counter for anonymous service-request creation. Idempotent retries
-- are checked before this function is called, so a network retry does not spend another slot.
create table if not exists public.widget_service_request_usage (
  session_hash text primary key check (session_hash ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz not null default now(),
  window_requests integer not null default 0 check (window_requests >= 0),
  daily_date date not null default (now() at time zone 'utc')::date,
  daily_requests integer not null default 0 check (daily_requests >= 0),
  updated_at timestamptz not null default now()
);
create index if not exists widget_service_request_usage_updated_idx on public.widget_service_request_usage(updated_at);
alter table public.widget_service_request_usage enable row level security;
revoke all on public.widget_service_request_usage from public, anon, authenticated;
grant all on public.widget_service_request_usage to service_role;
create or replace function public.pooldocai_consume_widget_service_request(
  p_session_hash text, p_max_requests integer default 2, p_max_daily_requests integer default 5
) returns table(allowed boolean, retry_after_seconds integer, window_requests integer, daily_requests integer)
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.widget_service_request_usage%rowtype; now_utc timestamptz := now(); today_utc date := (now() at time zone 'utc')::date;
begin
  if p_session_hash !~ '^[a-f0-9]{64}$' then raise exception 'Invalid session hash'; end if;
  delete from public.widget_service_request_usage where updated_at < now_utc - interval '7 days';
  insert into public.widget_service_request_usage(session_hash) values (p_session_hash) on conflict do nothing;
  select * into r from public.widget_service_request_usage where session_hash=p_session_hash for update;
  if r.window_started_at < now_utc - interval '1 hour' then r.window_started_at:=now_utc; r.window_requests:=0; end if;
  if r.daily_date <> today_utc then r.daily_date:=today_utc; r.daily_requests:=0; end if;
  if r.window_requests >= least(greatest(p_max_requests,1),5) or r.daily_requests >= least(greatest(p_max_daily_requests,1),10) then
    update public.widget_service_request_usage set window_started_at=r.window_started_at,window_requests=r.window_requests,daily_date=r.daily_date,daily_requests=r.daily_requests,updated_at=now_utc where session_hash=p_session_hash;
    return query select false,greatest(1,ceil(extract(epoch from (r.window_started_at+interval '1 hour'-now_utc))::numeric)::integer),r.window_requests,r.daily_requests; return;
  end if;
  r.window_requests:=r.window_requests+1; r.daily_requests:=r.daily_requests+1;
  update public.widget_service_request_usage set window_started_at=r.window_started_at,window_requests=r.window_requests,daily_date=r.daily_date,daily_requests=r.daily_requests,updated_at=now_utc where session_hash=p_session_hash;
  return query select true,0,r.window_requests,r.daily_requests;
end; $$;
revoke all on function public.pooldocai_consume_widget_service_request(text,integer,integer) from public, anon, authenticated;
grant execute on function public.pooldocai_consume_widget_service_request(text,integer,integer) to service_role;
COMMIT;

-- ----------------------------------------------------------------------------
-- Migration 21/47: 202610220002_authenticated_service_handoff_source.sql
-- ----------------------------------------------------------------------------

-- Migration 020: allow authenticated troubleshooter escalations to be recorded in the tenant service queue.
-- Idempotent and limited to the source-type constraint; existing service requests are preserved.
BEGIN;
ALTER TABLE public.service_requests DROP CONSTRAINT IF EXISTS service_requests_source_type_check;
ALTER TABLE public.service_requests ADD CONSTRAINT service_requests_source_type_check
  CHECK (source_type IN ('admin','customer_widget','authenticated_troubleshooter'));
COMMIT;

-- ----------------------------------------------------------------------------
-- Migration 22/47: 202610220003_plan_entitlements_pooled_sessions_branding.sql
-- ----------------------------------------------------------------------------

-- Migration 021: canonical three-plan entitlement model, pooled monthly troubleshooting sessions, and onboarding brand data.
-- Run on the active PoolDocAI Secure Foundation Supabase project. The Edge Function uses service_role only for RPC access.
BEGIN;

ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS monthly_session_allowance integer NOT NULL DEFAULT 200;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS widget_access_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_monthly_session_allowance_check;
ALTER TABLE public.companies ADD CONSTRAINT companies_monthly_session_allowance_check CHECK (monthly_session_allowance BETWEEN 0 AND 1000000);

-- Preserve the original platform-admin guard for browser sessions, while allowing the verified
-- Supabase service-role Stripe webhook to update subscription-derived plan/status fields.
CREATE OR REPLACE FUNCTION public.protect_company_plan_fields()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  request_role text := coalesce(auth.role(), current_setting('request.jwt.claim.role', true), '');
BEGIN
  IF request_role NOT IN ('service_role','supabase_admin') AND NOT public.is_platform_admin()
     AND (NEW.status IS DISTINCT FROM OLD.status
       OR NEW.plan_name IS DISTINCT FROM OLD.plan_name
       OR NEW.seat_limit IS DISTINCT FROM OLD.seat_limit
       OR NEW.billing_status IS DISTINCT FROM OLD.billing_status
       OR NEW.billing_customer_ref IS DISTINCT FROM OLD.billing_customer_ref
       OR NEW.billing_subscription_ref IS DISTINCT FROM OLD.billing_subscription_ref
       OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
       OR NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id
       OR NEW.stripe_price_id IS DISTINCT FROM OLD.stripe_price_id
       OR NEW.billing_period_start IS DISTINCT FROM OLD.billing_period_start
       OR NEW.current_period_end IS DISTINCT FROM OLD.current_period_end
       OR NEW.trial_ends_at IS DISTINCT FROM OLD.trial_ends_at
       OR NEW.monthly_session_allowance IS DISTINCT FROM OLD.monthly_session_allowance
       OR NEW.widget_access_enabled IS DISTINCT FROM OLD.widget_access_enabled) THEN
    RAISE EXCEPTION 'Only PoolDocAI platform administrators or trusted billing services can change plan, status, seat limits, or billing state.';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.protect_company_plan_fields() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.protect_company_plan_fields() TO service_role;

ALTER TABLE public.company_widget_configs ADD COLUMN IF NOT EXISTS logo_url text;
ALTER TABLE public.company_widget_configs ADD COLUMN IF NOT EXISTS brand_source_url text;
ALTER TABLE public.company_widget_configs ADD COLUMN IF NOT EXISTS brand_fetched_at timestamptz;
ALTER TABLE public.company_widget_configs ADD COLUMN IF NOT EXISTS brand_provider text;
ALTER TABLE public.company_widget_configs ADD COLUMN IF NOT EXISTS brand_setup_state text NOT NULL DEFAULT 'manual' CHECK (brand_setup_state IN ('manual','suggested','applied','unavailable'));
ALTER TABLE public.company_widget_configs DROP CONSTRAINT IF EXISTS company_widget_logo_url_https_check;
ALTER TABLE public.company_widget_configs ADD CONSTRAINT company_widget_logo_url_https_check CHECK (logo_url IS NULL OR (length(logo_url) <= 1200 AND logo_url ~ '^https://'));
ALTER TABLE public.company_widget_configs DROP CONSTRAINT IF EXISTS company_widget_brand_source_url_https_check;
ALTER TABLE public.company_widget_configs ADD CONSTRAINT company_widget_brand_source_url_https_check CHECK (brand_source_url IS NULL OR (length(brand_source_url) <= 400 AND brand_source_url ~ '^https://'));

-- One row per distinct company case per billing period. The session ID itself is never stored; only its SHA-256 digest is.
CREATE TABLE IF NOT EXISTS public.pooldocai_company_monthly_sessions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  session_hash text NOT NULL CHECK (session_hash ~ '^[a-f0-9]{64}$'),
  session_mode text NOT NULL DEFAULT 'unknown' CHECK (session_mode IN ('homeowner','technician','unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pooldocai_company_monthly_sessions_uidx UNIQUE(company_id,period_start,session_hash)
);
CREATE INDEX IF NOT EXISTS pooldocai_company_monthly_sessions_period_idx ON public.pooldocai_company_monthly_sessions(company_id,period_start,created_at DESC);
ALTER TABLE public.pooldocai_company_monthly_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pooldocai_company_monthly_sessions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.pooldocai_company_monthly_sessions TO service_role;
DO $$
DECLARE sequence_name text;
BEGIN
  sequence_name := pg_get_serial_sequence('public.pooldocai_company_monthly_sessions', 'id');
  IF sequence_name IS NOT NULL THEN
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO service_role', sequence_name);
  END IF;
END $$;

ALTER TABLE public.companies DISABLE TRIGGER protect_company_plan_fields;

UPDATE public.companies SET plan_name = CASE lower(coalesce(plan_name,''))
  WHEN 'starter' THEN 'tech_only'
  WHEN 'tech_solo_route' THEN 'tech_only'
  WHEN 'tech_pro_team' THEN 'tech_only'
  WHEN 'tech_fleet' THEN 'tech_only'
  WHEN 'professional' THEN 'complete_team'
  WHEN 'complete_solo' THEN 'complete_team'
  WHEN 'complete_pro_team' THEN 'complete_team'
  WHEN 'enterprise' THEN 'complete_fleet'
  WHEN 'complete_fleet' THEN 'complete_fleet'
  WHEN 'pilot' THEN 'pilot'
  WHEN 'tech_only' THEN 'tech_only'
  WHEN 'complete_team' THEN 'complete_team'
  ELSE 'tech_only'
END
WHERE lower(coalesce(plan_name,'')) NOT IN ('tech_only','complete_team','complete_fleet','pilot');

CREATE OR REPLACE FUNCTION public.pooldocai_set_plan_entitlements()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  CASE lower(coalesce(NEW.plan_name,''))
    WHEN 'tech_only' THEN NEW.plan_name := 'tech_only'; NEW.seat_limit := 1; NEW.monthly_session_allowance := 200; NEW.widget_access_enabled := false;
    WHEN 'complete_team' THEN NEW.plan_name := 'complete_team'; NEW.seat_limit := 6; NEW.monthly_session_allowance := 1300; NEW.widget_access_enabled := true;
    WHEN 'complete_fleet' THEN NEW.plan_name := 'complete_fleet'; NEW.seat_limit := 15; NEW.monthly_session_allowance := 2800; NEW.widget_access_enabled := true;
    WHEN 'pilot' THEN NEW.plan_name := 'pilot'; NEW.seat_limit := greatest(coalesce(NEW.seat_limit,1),1); NEW.monthly_session_allowance := 5000; NEW.widget_access_enabled := true;
    ELSE NEW.monthly_session_allowance := 0; NEW.widget_access_enabled := false;
  END CASE;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pooldocai_set_plan_entitlements_trigger ON public.companies;
CREATE TRIGGER pooldocai_set_plan_entitlements_trigger BEFORE INSERT OR UPDATE OF plan_name ON public.companies
FOR EACH ROW EXECUTE FUNCTION public.pooldocai_set_plan_entitlements();

UPDATE public.companies SET plan_name = lower(coalesce(plan_name,'tech_only'));
ALTER TABLE public.companies ENABLE TRIGGER protect_company_plan_fields;

CREATE OR REPLACE FUNCTION public.pooldocai_consume_company_monthly_session(
  p_company_id uuid, p_session_hash text, p_session_mode text DEFAULT 'unknown'
)
RETURNS TABLE(allowed boolean, used integer, allowance integer, remaining integer, period_start date, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  c public.companies%ROWTYPE;
  v_period_start date;
  v_used integer;
  v_allowance integer;
  v_mode text;
BEGIN
  IF p_company_id IS NULL OR p_session_hash IS NULL OR p_session_hash !~ '^[a-f0-9]{64}$' THEN
    RETURN QUERY SELECT false,0,0,0,date_trunc('month',now())::date,'invalid_request'::text; RETURN;
  END IF;
  SELECT * INTO c FROM public.companies WHERE id=p_company_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false,0,0,0,date_trunc('month',now())::date,'company_not_found'::text; RETURN; END IF;
  IF coalesce(c.status,'') NOT IN ('active','pilot') THEN
    RETURN QUERY SELECT false,0,coalesce(c.monthly_session_allowance,0),0,date_trunc('month',now())::date,'company_inactive'::text; RETURN;
  END IF;
  v_allowance := greatest(coalesce(c.monthly_session_allowance,0),0);
  IF v_allowance <= 0 THEN
    RETURN QUERY SELECT false,0,v_allowance,0,date_trunc('month',now())::date,'plan_not_entitled'::text; RETURN;
  END IF;
  IF c.billing_period_start IS NOT NULL AND c.current_period_end IS NOT NULL AND now() >= c.billing_period_start AND now() < c.current_period_end THEN
    v_period_start := c.billing_period_start::date;
  ELSE
    v_period_start := date_trunc('month',now())::date;
  END IF;
  v_mode := CASE WHEN p_session_mode IN ('homeowner','technician') THEN p_session_mode ELSE 'unknown' END;
  IF EXISTS (SELECT 1 FROM public.pooldocai_company_monthly_sessions s WHERE s.company_id=p_company_id AND s.period_start=v_period_start AND s.session_hash=p_session_hash) THEN
    SELECT count(*)::integer INTO v_used FROM public.pooldocai_company_monthly_sessions s WHERE s.company_id=p_company_id AND s.period_start=v_period_start;
    RETURN QUERY SELECT true,v_used,v_allowance,greatest(v_allowance-v_used,0),v_period_start,'already_counted'::text; RETURN;
  END IF;
  SELECT count(*)::integer INTO v_used FROM public.pooldocai_company_monthly_sessions s WHERE s.company_id=p_company_id AND s.period_start=v_period_start;
  IF v_used >= v_allowance THEN
    RETURN QUERY SELECT false,v_used,v_allowance,0,v_period_start,'monthly_session_limit_reached'::text; RETURN;
  END IF;
  INSERT INTO public.pooldocai_company_monthly_sessions(company_id,period_start,session_hash,session_mode)
  VALUES(p_company_id,v_period_start,p_session_hash,v_mode)
  ON CONFLICT(company_id,period_start,session_hash) DO NOTHING;
  SELECT count(*)::integer INTO v_used FROM public.pooldocai_company_monthly_sessions s WHERE s.company_id=p_company_id AND s.period_start=v_period_start;
  RETURN QUERY SELECT (v_used<=v_allowance),v_used,v_allowance,greatest(v_allowance-v_used,0),v_period_start,
    CASE WHEN v_used<=v_allowance THEN 'counted' ELSE 'monthly_session_limit_reached' END::text;
END $$;

CREATE OR REPLACE FUNCTION public.pooldocai_get_company_session_usage(p_company_ids uuid[])
RETURNS TABLE(company_id uuid, period_start date, sessions_used integer, sessions_allowance integer, sessions_remaining integer, widget_access_enabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH selected AS (
    SELECT c.id,c.monthly_session_allowance,c.widget_access_enabled,
      CASE WHEN c.billing_period_start IS NOT NULL AND c.current_period_end IS NOT NULL AND now() >= c.billing_period_start AND now() < c.current_period_end
        THEN c.billing_period_start::date ELSE date_trunc('month',now())::date END AS pstart
    FROM public.companies c WHERE c.id=ANY(coalesce(p_company_ids,'{}'::uuid[]))
  ), counts AS (
    SELECT s.company_id,s.period_start,count(*)::integer AS used FROM public.pooldocai_company_monthly_sessions s
    JOIN selected c ON c.id=s.company_id AND c.pstart=s.period_start GROUP BY s.company_id,s.period_start
  )
  SELECT c.id,c.pstart,coalesce(n.used,0),coalesce(c.monthly_session_allowance,0),greatest(coalesce(c.monthly_session_allowance,0)-coalesce(n.used,0),0),c.widget_access_enabled
  FROM selected c LEFT JOIN counts n ON n.company_id=c.id AND n.period_start=c.pstart
$$;
REVOKE ALL ON FUNCTION public.pooldocai_set_plan_entitlements() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pooldocai_consume_company_monthly_session(uuid,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pooldocai_get_company_session_usage(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_consume_company_monthly_session(uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.pooldocai_get_company_session_usage(uuid[]) TO service_role;

COMMENT ON COLUMN public.companies.monthly_session_allowance IS 'Server-enforced total distinct diagnostic sessions per billing period, pooled across technician and customer-widget access.';
COMMENT ON COLUMN public.companies.widget_access_enabled IS 'Derived from canonical plan entitlement; tech_only is false and Complete plans/pilot are true.';
COMMENT ON TABLE public.pooldocai_company_monthly_sessions IS 'Privacy-preserving pooled monthly session ledger; only SHA-256 session digests are retained.';
COMMIT;

-- ----------------------------------------------------------------------------
-- Migration 23/47: 202610220004_three_size_tiers_founders_pricing.sql
-- ----------------------------------------------------------------------------

-- Migration 022: three company-size tiers, Tech-Only/Complete access modes,
-- distinct pooled-session allowances, and explicit single-use Founders offer eligibility.
BEGIN;

ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS company_size_tier text NOT NULL DEFAULT 'solo_route';
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS subscription_access_mode text NOT NULL DEFAULT 'tech_only';
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS founders_eligible boolean NOT NULL DEFAULT false;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS founders_offer_expires_at timestamptz;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS founders_rate_active boolean NOT NULL DEFAULT false;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS founders_used_at timestamptz;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS founders_checkout_reserved_until timestamptz;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS founders_checkout_session_id text;

ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_company_size_tier_check;
ALTER TABLE public.companies ADD CONSTRAINT companies_company_size_tier_check
  CHECK (company_size_tier IN ('solo_route','pro_team','fleet'));
ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_subscription_access_mode_check;
ALTER TABLE public.companies ADD CONSTRAINT companies_subscription_access_mode_check
  CHECK (subscription_access_mode IN ('tech_only','complete'));
ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_founders_eligibility_expiry_check;
ALTER TABLE public.companies ADD CONSTRAINT companies_founders_eligibility_expiry_check
  CHECK (NOT founders_eligible OR founders_offer_expires_at IS NOT NULL);
ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_founders_redemption_check;
ALTER TABLE public.companies ADD CONSTRAINT companies_founders_redemption_check
  CHECK (NOT founders_rate_active OR founders_used_at IS NOT NULL);

-- Extend the existing plan-field guard. Only trusted billing services (service_role)
-- or an explicitly registered platform administrator can change plan or Founders fields.
CREATE OR REPLACE FUNCTION public.protect_company_plan_fields()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  request_role text := coalesce(auth.role(), current_setting('request.jwt.claim.role', true), '');
BEGIN
  IF request_role NOT IN ('service_role','supabase_admin') AND NOT public.is_platform_admin()
     AND (NEW.status IS DISTINCT FROM OLD.status
       OR NEW.plan_name IS DISTINCT FROM OLD.plan_name
       OR NEW.seat_limit IS DISTINCT FROM OLD.seat_limit
       OR NEW.billing_status IS DISTINCT FROM OLD.billing_status
       OR NEW.billing_customer_ref IS DISTINCT FROM OLD.billing_customer_ref
       OR NEW.billing_subscription_ref IS DISTINCT FROM OLD.billing_subscription_ref
       OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
       OR NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id
       OR NEW.stripe_price_id IS DISTINCT FROM OLD.stripe_price_id
       OR NEW.billing_period_start IS DISTINCT FROM OLD.billing_period_start
       OR NEW.current_period_end IS DISTINCT FROM OLD.current_period_end
       OR NEW.trial_ends_at IS DISTINCT FROM OLD.trial_ends_at
       OR NEW.monthly_session_allowance IS DISTINCT FROM OLD.monthly_session_allowance
       OR NEW.widget_access_enabled IS DISTINCT FROM OLD.widget_access_enabled
       OR NEW.company_size_tier IS DISTINCT FROM OLD.company_size_tier
       OR NEW.subscription_access_mode IS DISTINCT FROM OLD.subscription_access_mode
       OR NEW.founders_eligible IS DISTINCT FROM OLD.founders_eligible
       OR NEW.founders_offer_expires_at IS DISTINCT FROM OLD.founders_offer_expires_at
       OR NEW.founders_rate_active IS DISTINCT FROM OLD.founders_rate_active
       OR NEW.founders_used_at IS DISTINCT FROM OLD.founders_used_at
       OR NEW.founders_checkout_reserved_until IS DISTINCT FROM OLD.founders_checkout_reserved_until
       OR NEW.founders_checkout_session_id IS DISTINCT FROM OLD.founders_checkout_session_id) THEN
    RAISE EXCEPTION 'Only PoolDocAI platform administrators or trusted billing services can change subscription entitlements or Founders offer fields.';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.protect_company_plan_fields() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.protect_company_plan_fields() TO service_role;

CREATE OR REPLACE FUNCTION public.pooldocai_set_plan_entitlements()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  CASE lower(coalesce(NEW.plan_name,''))
    WHEN 'solo_tech_only' THEN NEW.plan_name := 'solo_tech_only'; NEW.company_size_tier := 'solo_route'; NEW.subscription_access_mode := 'tech_only'; NEW.seat_limit := 2; NEW.monthly_session_allowance := 250; NEW.widget_access_enabled := false;
    WHEN 'solo_complete' THEN NEW.plan_name := 'solo_complete'; NEW.company_size_tier := 'solo_route'; NEW.subscription_access_mode := 'complete'; NEW.seat_limit := 2; NEW.monthly_session_allowance := 350; NEW.widget_access_enabled := true;
    WHEN 'pro_team_tech_only' THEN NEW.plan_name := 'pro_team_tech_only'; NEW.company_size_tier := 'pro_team'; NEW.subscription_access_mode := 'tech_only'; NEW.seat_limit := 6; NEW.monthly_session_allowance := 750; NEW.widget_access_enabled := false;
    WHEN 'pro_team_complete' THEN NEW.plan_name := 'pro_team_complete'; NEW.company_size_tier := 'pro_team'; NEW.subscription_access_mode := 'complete'; NEW.seat_limit := 6; NEW.monthly_session_allowance := 1000; NEW.widget_access_enabled := true;
    WHEN 'fleet_tech_only' THEN NEW.plan_name := 'fleet_tech_only'; NEW.company_size_tier := 'fleet'; NEW.subscription_access_mode := 'tech_only'; NEW.seat_limit := 15; NEW.monthly_session_allowance := 2000; NEW.widget_access_enabled := false;
    WHEN 'fleet_complete' THEN NEW.plan_name := 'fleet_complete'; NEW.company_size_tier := 'fleet'; NEW.subscription_access_mode := 'complete'; NEW.seat_limit := 15; NEW.monthly_session_allowance := 2500; NEW.widget_access_enabled := true;
    WHEN 'legacy_tech_only' THEN NEW.plan_name := 'legacy_tech_only'; NEW.company_size_tier := 'solo_route'; NEW.subscription_access_mode := 'tech_only'; NEW.seat_limit := 1; NEW.monthly_session_allowance := 200; NEW.widget_access_enabled := false;
    WHEN 'legacy_complete_team' THEN NEW.plan_name := 'legacy_complete_team'; NEW.company_size_tier := 'pro_team'; NEW.subscription_access_mode := 'complete'; NEW.seat_limit := 6; NEW.monthly_session_allowance := 1300; NEW.widget_access_enabled := true;
    WHEN 'legacy_complete_fleet' THEN NEW.plan_name := 'legacy_complete_fleet'; NEW.company_size_tier := 'fleet'; NEW.subscription_access_mode := 'complete'; NEW.seat_limit := 15; NEW.monthly_session_allowance := 2800; NEW.widget_access_enabled := true;
    WHEN 'pilot' THEN NEW.plan_name := 'pilot'; NEW.company_size_tier := coalesce(NEW.company_size_tier,'solo_route'); NEW.subscription_access_mode := 'complete'; NEW.seat_limit := greatest(coalesce(NEW.seat_limit,1),1); NEW.monthly_session_allowance := 5000; NEW.widget_access_enabled := true;
    ELSE NEW.monthly_session_allowance := 0; NEW.widget_access_enabled := false;
  END CASE;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pooldocai_set_plan_entitlements_trigger ON public.companies;
CREATE TRIGGER pooldocai_set_plan_entitlements_trigger BEFORE INSERT OR UPDATE OF plan_name ON public.companies
FOR EACH ROW EXECUTE FUNCTION public.pooldocai_set_plan_entitlements();

ALTER TABLE public.companies DISABLE TRIGGER protect_company_plan_fields;
UPDATE public.companies
SET plan_name = CASE lower(coalesce(plan_name,''))
  WHEN 'pilot' THEN 'pilot'
  WHEN 'tech_only' THEN CASE WHEN stripe_subscription_id IS NOT NULL OR billing_subscription_ref IS NOT NULL THEN 'legacy_tech_only' ELSE 'solo_tech_only' END
  WHEN 'starter' THEN 'solo_tech_only'
  WHEN 'tech_solo_route' THEN 'solo_tech_only'
  WHEN 'tech_pro_team' THEN 'pro_team_tech_only'
  WHEN 'tech_fleet' THEN 'fleet_tech_only'
  WHEN 'complete_solo' THEN 'solo_complete'
  WHEN 'complete_team' THEN CASE WHEN stripe_subscription_id IS NOT NULL OR billing_subscription_ref IS NOT NULL THEN 'legacy_complete_team' ELSE 'pro_team_complete' END
  WHEN 'professional' THEN 'pro_team_complete'
  WHEN 'complete_pro_team' THEN 'pro_team_complete'
  WHEN 'complete_fleet' THEN CASE WHEN stripe_subscription_id IS NOT NULL OR billing_subscription_ref IS NOT NULL THEN 'legacy_complete_fleet' ELSE 'fleet_complete' END
  WHEN 'enterprise' THEN 'fleet_complete'
  WHEN 'solo_tech_only' THEN 'solo_tech_only'
  WHEN 'solo_complete' THEN 'solo_complete'
  WHEN 'pro_team_tech_only' THEN 'pro_team_tech_only'
  WHEN 'pro_team_complete' THEN 'pro_team_complete'
  WHEN 'fleet_tech_only' THEN 'fleet_tech_only'
  WHEN 'fleet_complete' THEN 'fleet_complete'
  WHEN 'legacy_tech_only' THEN 'legacy_tech_only'
  WHEN 'legacy_complete_team' THEN 'legacy_complete_team'
  WHEN 'legacy_complete_fleet' THEN 'legacy_complete_fleet'
  ELSE 'solo_tech_only'
END;
ALTER TABLE public.companies ENABLE TRIGGER protect_company_plan_fields;

COMMENT ON COLUMN public.companies.plan_name IS 'Canonical billable SKU: one of six company-size/access-mode combinations, or platform-granted pilot.';
COMMENT ON COLUMN public.companies.company_size_tier IS 'Subscription size tier: solo_route, pro_team, or fleet; derived from plan_name.';
COMMENT ON COLUMN public.companies.subscription_access_mode IS 'Subscription access mode: tech_only or complete; derived from plan_name.';
COMMENT ON COLUMN public.companies.monthly_session_allowance IS 'Plan-derived distinct diagnostic cases per monthly billing period, pooled across company users and access channels.';
COMMENT ON COLUMN public.companies.founders_eligible IS 'Platform-admin-controlled eligibility for a single Founders-price checkout before founders_offer_expires_at.';
COMMENT ON COLUMN public.companies.founders_offer_expires_at IS 'Required timestamp deadline for initiating the first Founders-price checkout. Founders checkout must remain disabled until the stated 24-month introductory term and Stripe subscription-price transition are implemented and verified.';
COMMENT ON COLUMN public.companies.founders_rate_active IS 'Set by verified Stripe subscription webhook while a mapped Founders recurring Price is active.';
COMMENT ON COLUMN public.companies.founders_used_at IS 'Permanent first redemption timestamp; a canceled Founders subscription cannot redeem the offer again.';
COMMENT ON COLUMN public.companies.founders_checkout_reserved_until IS 'Short-lived atomic reservation preventing concurrent double redemption; Stripe checkout expires before this reservation.';
COMMENT ON COLUMN public.companies.founders_checkout_session_id IS 'Stripe Checkout Session ID currently reserving the Founders offer, cleared after verified subscription activation or checkout expiration.';

CREATE OR REPLACE FUNCTION public.pooldocai_reserve_founders_checkout(
  p_company_id uuid, p_reservation_until timestamptz
)
RETURNS TABLE(reserved boolean, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.companies%ROWTYPE;
BEGIN
  IF p_company_id IS NULL OR p_reservation_until IS NULL OR p_reservation_until <= now() OR p_reservation_until > now() + interval '40 minutes' THEN
    RETURN QUERY SELECT false, 'invalid_reservation_window'::text; RETURN;
  END IF;
  SELECT * INTO c FROM public.companies WHERE id=p_company_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'company_not_found'::text; RETURN; END IF;
  IF c.founders_eligible IS DISTINCT FROM true OR c.founders_offer_expires_at IS NULL OR c.founders_offer_expires_at <= now() THEN
    RETURN QUERY SELECT false, 'founders_offer_not_eligible'::text; RETURN;
  END IF;
  IF c.founders_used_at IS NOT NULL THEN
    RETURN QUERY SELECT false, 'founders_offer_already_redeemed'::text; RETURN;
  END IF;
  IF c.stripe_subscription_id IS NOT NULL AND c.billing_status IN ('active','trialing','past_due') THEN
    RETURN QUERY SELECT false, 'existing_subscription'::text; RETURN;
  END IF;
  IF c.founders_checkout_reserved_until IS NOT NULL AND c.founders_checkout_reserved_until > now() THEN
    RETURN QUERY SELECT false, 'founders_checkout_in_progress'::text; RETURN;
  END IF;
  UPDATE public.companies SET founders_checkout_reserved_until=p_reservation_until, founders_checkout_session_id=NULL
    WHERE id=p_company_id;
  RETURN QUERY SELECT true, 'reserved'::text;
END $$;
REVOKE ALL ON FUNCTION public.pooldocai_reserve_founders_checkout(uuid,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_reserve_founders_checkout(uuid,timestamptz) TO service_role;
COMMIT;

-- ----------------------------------------------------------------------------
-- Migration 24/47: 202610220005_model_rate_card_effective_dates.sql
-- ----------------------------------------------------------------------------

-- Migration 023: effective-dated model rates for the models currently used by PoolDocAI.
BEGIN;

-- Source: Google Gemini Developer API official pricing page, standard paid tier:
-- https://ai.google.dev/gemini-api/docs/pricing
-- Gemini 3.8 Flash: $0.75/$3.75 per million input/output tokens through 2026-12-31;
-- $1.50/$7.50 starting 2027-01-01. Gemini 2.5 Flash: $0.30/$2.50;
-- Gemini 2.5 Flash-Lite: $0.10/$0.40; Gemini Embedding 001: $0.15/input token million.
-- Rates are estimates only; provider invoices remain authoritative.
-- Idempotent, audit preserving, and does not grant runtime/API access.
DO $$
BEGIN
  IF to_regclass('public.pooldocai_model_rate_cards') IS NULL THEN
    RAISE EXCEPTION 'Apply migration 012 before migration 023: pooldocai_model_rate_cards is missing';
  END IF;
  IF EXISTS (
    SELECT required.column_name
    FROM (VALUES ('provider'),('model'),('input_usd_per_million_tokens'),('output_usd_per_million_tokens'),('active'),('valid_from'),('valid_to')) AS required(column_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.table_name='pooldocai_model_rate_cards' AND c.column_name=required.column_name
    )
  ) THEN
    RAISE EXCEPTION 'Rate-card schema is incomplete; migration 012 must be repaired before migration 023';
  END IF;
END $$;

UPDATE public.pooldocai_model_rate_cards
SET active=false, valid_to='2026-10-22 00:00:00+00'::timestamptz
WHERE provider='google_gemini'
  AND model='gemini-3.8-flash'
  AND active=true
  AND valid_from < '2026-10-22 00:00:00+00'::timestamptz
  AND (valid_to IS NULL OR valid_to > '2026-10-22 00:00:00+00'::timestamptz);

UPDATE public.pooldocai_model_rate_cards
SET active=false, valid_to='2026-10-22 00:00:00+00'::timestamptz
WHERE provider='google_gemini'
  AND model IN ('gemini-2.5-flash','gemini-2.5-flash-lite','gemini-embedding-001')
  AND active=true
  AND valid_from < '2026-10-22 00:00:00+00'::timestamptz
  AND (valid_to IS NULL OR valid_to > '2026-10-22 00:00:00+00'::timestamptz);

WITH defaults(provider,model,input_rate,output_rate,valid_from,preferred_valid_to) AS (
  VALUES
    ('google_gemini'::text,'gemini-2.5-flash'::text,0.30::numeric,2.50::numeric,'2026-10-22 00:00:00+00'::timestamptz,NULL::timestamptz),
    ('google_gemini'::text,'gemini-2.5-flash-lite'::text,0.10::numeric,0.40::numeric,'2026-10-22 00:00:00+00'::timestamptz,NULL::timestamptz),
    ('google_gemini'::text,'gemini-embedding-001'::text,0.15::numeric,NULL::numeric,'2026-10-22 00:00:00+00'::timestamptz,NULL::timestamptz),
    ('google_gemini'::text,'gemini-3.8-flash'::text,0.75::numeric,3.75::numeric,'2026-10-22 00:00:00+00'::timestamptz,'2027-01-01 00:00:00+00'::timestamptz)
)
INSERT INTO public.pooldocai_model_rate_cards
  (provider,model,input_usd_per_million_tokens,output_usd_per_million_tokens,active,valid_from,valid_to)
SELECT d.provider,d.model,d.input_rate,d.output_rate,true,d.valid_from,
       CASE WHEN d.preferred_valid_to IS NOT NULL THEN LEAST(d.preferred_valid_to,future_rates.next_start)
            ELSE future_rates.next_start END
FROM defaults d
LEFT JOIN LATERAL (
  SELECT min(f.valid_from) AS next_start FROM public.pooldocai_model_rate_cards f
  WHERE f.provider=d.provider AND f.model=d.model AND f.active=true AND f.valid_from>d.valid_from
) future_rates ON true
ON CONFLICT (provider,model,valid_from) DO NOTHING;

INSERT INTO public.pooldocai_model_rate_cards
  (provider,model,input_usd_per_million_tokens,output_usd_per_million_tokens,active,valid_from,valid_to)
VALUES ('google_gemini','gemini-3.8-flash',1.50,7.50,true,'2027-01-01 00:00:00+00'::timestamptz,NULL)
ON CONFLICT (provider,model,valid_from) DO NOTHING;

WITH ordered_active_rates AS (
  SELECT id, LEAD(valid_from) OVER (PARTITION BY provider,model ORDER BY valid_from) AS next_start
  FROM public.pooldocai_model_rate_cards
  WHERE provider='google_gemini'
    AND model IN ('gemini-2.5-flash','gemini-2.5-flash-lite','gemini-embedding-001','gemini-3.8-flash')
    AND active=true
)
UPDATE public.pooldocai_model_rate_cards AS rate
SET valid_to=ordered_active_rates.next_start
FROM ordered_active_rates
WHERE rate.id=ordered_active_rates.id
  AND ordered_active_rates.next_start IS NOT NULL
  AND (rate.valid_to IS NULL OR rate.valid_to > ordered_active_rates.next_start);

COMMENT ON TABLE public.pooldocai_model_rate_cards IS
  'Versioned estimate-only provider prices with effective intervals. Do not use estimates as a substitute for the provider billing console.';

COMMIT;

-- ----------------------------------------------------------------------------
-- Migration 25/47: 202610220006_secure_service_request_webhooks.sql
-- ----------------------------------------------------------------------------

-- Migration 024: tenant-scoped, plan-gated outbound service-request webhooks.
-- Delivery runs in the document worker so DNS can be pinned at the socket layer.
BEGIN;

CREATE TABLE IF NOT EXISTS public.company_service_webhook_configs (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  target_url text,
  signing_secret text NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_service_webhook_url_https CHECK (target_url IS NULL OR (target_url ~ '^https://[^[:space:]]+$' AND length(target_url) <= 2000)),
  CONSTRAINT company_service_webhook_secret_len CHECK (length(signing_secret) >= 32)
);

CREATE TABLE IF NOT EXISTS public.service_request_webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  service_request_id uuid NOT NULL REFERENCES public.service_requests(id) ON DELETE CASCADE,
  event_type text NOT NULL DEFAULT 'service_request.created',
  payload jsonb NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','delivered','retrying','failed','skipped')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  response_status integer,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS service_request_webhook_due_idx ON public.service_request_webhook_deliveries(status,next_attempt_at,created_at);
CREATE INDEX IF NOT EXISTS service_request_webhook_tenant_idx ON public.service_request_webhook_deliveries(company_id,created_at DESC);

ALTER TABLE public.company_service_webhook_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_request_webhook_deliveries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_service_webhook_configs_no_client_access ON public.company_service_webhook_configs;
CREATE POLICY company_service_webhook_configs_no_client_access ON public.company_service_webhook_configs FOR ALL TO anon,authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS service_request_webhook_deliveries_no_client_access ON public.service_request_webhook_deliveries;
CREATE POLICY service_request_webhook_deliveries_no_client_access ON public.service_request_webhook_deliveries FOR ALL TO anon,authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON public.company_service_webhook_configs, public.service_request_webhook_deliveries FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.company_service_webhook_configs, public.service_request_webhook_deliveries TO service_role;

CREATE OR REPLACE FUNCTION public.pooldocai_enqueue_service_request_webhook()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  company_tier text;
  company_plan text;
  config_enabled boolean;
BEGIN
  SELECT coalesce(c.company_size_tier,''), coalesce(c.plan_name,'')
    INTO company_tier, company_plan FROM public.companies c WHERE c.id=NEW.company_id;
  IF NOT (company_tier IN ('pro_team','fleet') OR company_plan LIKE 'pro_team_%' OR company_plan LIKE 'fleet_%') THEN
    RETURN NEW;
  END IF;
  SELECT w.enabled INTO config_enabled FROM public.company_service_webhook_configs w WHERE w.company_id=NEW.company_id;
  IF coalesce(config_enabled,false) IS NOT TRUE THEN RETURN NEW; END IF;
  INSERT INTO public.service_request_webhook_deliveries(company_id,service_request_id,event_type,payload,idempotency_key)
  VALUES (
    NEW.company_id, NEW.id, 'service_request.created',
    jsonb_build_object(
      'id', NEW.id,
      'event', 'service_request.created',
      'created_at', NEW.created_at,
      'status', NEW.status,
      'priority', NEW.priority,
      'source_type', NEW.source_type,
      'diagnostic_case_id', NEW.diagnostic_case_id
    ),
    NEW.company_id::text || ':' || NEW.id::text || ':service_request.created'
  ) ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS service_request_webhook_enqueue ON public.service_requests;
CREATE TRIGGER service_request_webhook_enqueue AFTER INSERT ON public.service_requests
FOR EACH ROW EXECUTE FUNCTION public.pooldocai_enqueue_service_request_webhook();
REVOKE ALL ON FUNCTION public.pooldocai_enqueue_service_request_webhook() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_enqueue_service_request_webhook() TO service_role;

CREATE OR REPLACE FUNCTION public.pooldocai_claim_service_request_webhook()
RETURNS SETOF public.service_request_webhook_deliveries
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE picked public.service_request_webhook_deliveries;
BEGIN
  UPDATE public.service_request_webhook_deliveries
    SET status='failed',last_error_code='worker_lease_expired_max_attempts',updated_at=now()
    WHERE status='sending' AND last_attempt_at < now()-interval '2 minutes' AND attempt_count >= 8;
  SELECT * INTO picked FROM public.service_request_webhook_deliveries
  WHERE ((status IN ('pending','retrying') AND next_attempt_at <= now())
      OR (status='sending' AND last_attempt_at < now()-interval '2 minutes'))
    AND attempt_count < 8
  ORDER BY next_attempt_at,created_at LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.service_request_webhook_deliveries SET status='sending',attempt_count=attempt_count+1,last_attempt_at=now(),updated_at=now()
  WHERE id=picked.id RETURNING * INTO picked;
  RETURN NEXT picked;
END $$;

CREATE OR REPLACE FUNCTION public.pooldocai_finish_service_request_webhook(
  p_delivery_id uuid, p_success boolean, p_response_status integer DEFAULT NULL, p_error_code text DEFAULT NULL, p_retryable boolean DEFAULT false
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE current_attempt integer;
BEGIN
  SELECT attempt_count INTO current_attempt FROM public.service_request_webhook_deliveries WHERE id=p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF p_success THEN
    UPDATE public.service_request_webhook_deliveries SET status='delivered',delivered_at=now(),response_status=p_response_status,last_error_code=NULL,updated_at=now() WHERE id=p_delivery_id;
  ELSIF p_retryable AND current_attempt < 8 THEN
    UPDATE public.service_request_webhook_deliveries SET status='retrying',response_status=p_response_status,last_error_code=left(coalesce(p_error_code,'delivery_failed'),80),next_attempt_at=now()+make_interval(secs => LEAST(3600, 15 * power(2, GREATEST(current_attempt-1,0))::integer)),updated_at=now() WHERE id=p_delivery_id;
  ELSE
    UPDATE public.service_request_webhook_deliveries SET status='failed',response_status=p_response_status,last_error_code=left(coalesce(p_error_code,'delivery_failed'),80),updated_at=now() WHERE id=p_delivery_id;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.pooldocai_claim_service_request_webhook() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pooldocai_finish_service_request_webhook(uuid,boolean,integer,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_claim_service_request_webhook() TO service_role;
GRANT EXECUTE ON FUNCTION public.pooldocai_finish_service_request_webhook(uuid,boolean,integer,text,boolean) TO service_role;

COMMIT;

-- ----------------------------------------------------------------------------
-- Migration 26/47: 202610220007_grounding_cost_cache_security_review.sql
-- ----------------------------------------------------------------------------

-- Migration 025: Google Search grounding metering, public fault-code source cache, and review attestations.
-- Apply only after migration 012 (usage/rate-card schema) and 006 (learning review tables).
BEGIN;

ALTER TABLE public.pooldocai_model_rate_cards
  ADD COLUMN IF NOT EXISTS grounding_usd_per_1000_units numeric(14,8),
  ADD COLUMN IF NOT EXISTS grounding_pricing_unit text;

-- Gemini 2.5 is billed per grounded prompt; Gemini 3.x is billed per Search query.
-- Estimates use published paid-tier list rates before subtracting shared free-tier allowances.
UPDATE public.pooldocai_model_rate_cards
SET grounding_usd_per_1000_units=35.00,
    grounding_pricing_unit='grounded_prompt'
WHERE provider='google_gemini'
  AND model IN ('gemini-2.5-flash','gemini-2.5-flash-lite')
  AND active=true;

UPDATE public.pooldocai_model_rate_cards
SET grounding_usd_per_1000_units=14.00,
    grounding_pricing_unit='search_query'
WHERE provider='google_gemini'
  AND model LIKE 'gemini-3.%-flash%'
  AND active=true;

COMMENT ON COLUMN public.pooldocai_model_rate_cards.grounding_usd_per_1000_units IS
  'Gross list price per 1000 Google Search grounding billing units, before shared free-tier allowances.';
COMMENT ON COLUMN public.pooldocai_model_rate_cards.grounding_pricing_unit IS
  'grounded_prompt for Gemini 2.5 and older; search_query for Gemini 3 and newer.';

CREATE TABLE IF NOT EXISTS public.pooldocai_grounded_answer_cache (
  cache_key text PRIMARY KEY CHECK (length(cache_key)=64),
  equipment_category text NOT NULL,
  manufacturer_normalized text NOT NULL,
  model_normalized text NOT NULL,
  fault_code text NOT NULL,
  answer_redacted text NOT NULL CHECK (length(answer_redacted) BETWEEN 40 AND 4800),
  source_links jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_links)='array'),
  evidence_snippets jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_snippets)='array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS pooldocai_grounded_answer_cache_expiry_idx ON public.pooldocai_grounded_answer_cache(expires_at);
ALTER TABLE public.pooldocai_grounded_answer_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pooldocai_grounded_answer_cache FROM public, anon, authenticated;
GRANT ALL ON public.pooldocai_grounded_answer_cache TO service_role;
COMMENT ON TABLE public.pooldocai_grounded_answer_cache IS
  'Thirty-day cache of public web-grounding evidence keyed only by manufacturer, model, equipment category and explicit fault code; no tenant manuals or customer identifiers.';

ALTER TABLE public.learning_review_audit
  ADD COLUMN IF NOT EXISTS reviewer_name text,
  ADD COLUMN IF NOT EXISTS qualified_signoff_confirmed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.learning_review_audit.reviewer_name IS 'Required reviewer-supplied name for approval decisions.';
COMMENT ON COLUMN public.learning_review_audit.qualified_signoff_confirmed IS 'Explicit acknowledgement for any approved lesson containing chemical or water-balance risk.';

CREATE INDEX IF NOT EXISTS platform_page_views_created_at_idx ON public.platform_page_views(created_at);

-- Atomic short-lived reservations keep concurrent requests from racing past the grounding budget.
CREATE TABLE IF NOT EXISTS public.pooldocai_grounding_budget_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  model text NOT NULL,
  reserved_units integer NOT NULL CHECK (reserved_units > 0 AND reserved_units <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes')
);
CREATE INDEX IF NOT EXISTS pooldocai_grounding_budget_reservations_expiry_idx
  ON public.pooldocai_grounding_budget_reservations(expires_at);
ALTER TABLE public.pooldocai_grounding_budget_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pooldocai_grounding_budget_reservations FROM public, anon, authenticated;
GRANT ALL ON public.pooldocai_grounding_budget_reservations TO service_role;

CREATE OR REPLACE FUNCTION public.pooldocai_reserve_grounding_budget(
  p_company_id uuid,
  p_model text,
  p_reserved_units integer,
  p_global_limit integer,
  p_company_limit integer
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_global_used numeric := 0;
  v_global_reserved numeric := 0;
  v_company_used numeric := 0;
  v_company_reserved numeric := 0;
  v_id uuid;
BEGIN
  IF p_reserved_units IS NULL OR p_reserved_units <= 0 OR p_reserved_units > 100
     OR p_global_limit IS NULL OR p_global_limit <= 0
     OR p_company_limit IS NULL OR p_company_limit <= 0 THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pooldocai_grounding_budget_global'));
  DELETE FROM public.pooldocai_grounding_budget_reservations WHERE expires_at <= now();
  SELECT COALESCE(sum(quantity),0) INTO v_global_used
    FROM public.platform_usage_events WHERE event_type='google_search_grounding' AND created_at >= now()-interval '24 hours';
  SELECT COALESCE(sum(reserved_units),0) INTO v_global_reserved
    FROM public.pooldocai_grounding_budget_reservations WHERE expires_at > now();
  IF v_global_used + v_global_reserved + p_reserved_units > p_global_limit THEN RETURN NULL; END IF;
  IF p_company_id IS NOT NULL THEN
    SELECT COALESCE(sum(quantity),0) INTO v_company_used
      FROM public.platform_usage_events WHERE event_type='google_search_grounding' AND company_id=p_company_id AND created_at >= now()-interval '24 hours';
    SELECT COALESCE(sum(reserved_units),0) INTO v_company_reserved
      FROM public.pooldocai_grounding_budget_reservations WHERE company_id=p_company_id AND expires_at > now();
    IF v_company_used + v_company_reserved + p_reserved_units > p_company_limit THEN RETURN NULL; END IF;
  END IF;
  INSERT INTO public.pooldocai_grounding_budget_reservations(company_id,model,reserved_units,expires_at)
    VALUES(p_company_id,left(COALESCE(p_model,'unknown'),100),p_reserved_units,now()+interval '10 minutes')
    RETURNING id INTO v_id;
  RETURN v_id;
END; $$;
REVOKE ALL ON FUNCTION public.pooldocai_reserve_grounding_budget(uuid,text,integer,integer,integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_reserve_grounding_budget(uuid,text,integer,integer,integer) TO service_role;
COMMENT ON FUNCTION public.pooldocai_reserve_grounding_budget(uuid,text,integer,integer,integer) IS
  'Atomically reserves grounding-query budget across concurrent edge requests; reservation auto-expires after ten minutes.';

COMMIT;

-- ----------------------------------------------------------------------------
-- Migration 27/47: 20261023030000_temporary_access_validity_rpc_scope.sql
-- ----------------------------------------------------------------------------

-- Migration 026: keep the temporary-trial validity RPC bound to the caller's own identity.
-- The same function remains usable by restrictive RLS policies, which always pass auth.uid().
BEGIN;
CREATE OR REPLACE FUNCTION public.temporary_access_is_valid(p_user_id uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
  SELECT CASE
    WHEN p_user_id IS DISTINCT FROM (SELECT auth.uid()) THEN false
    ELSE
      NOT EXISTS (
        SELECT 1 FROM public.temporary_access_grants g WHERE g.user_id=p_user_id
      )
      OR EXISTS (
        SELECT 1 FROM public.temporary_access_grants g
        WHERE g.user_id=p_user_id AND g.revoked_at IS NULL AND g.expires_at > now()
      )
  END;
$$;
REVOKE ALL ON FUNCTION public.temporary_access_is_valid(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.temporary_access_is_valid(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.temporary_access_is_valid(uuid) IS
  'Restrictive RLS expiry gate that only answers for the invoking authenticated user; arbitrary cross-user validity probes return false.';
COMMIT;

-- ----------------------------------------------------------------------------
-- Migration 28/47: 20261023040000_finish_grounding_budget_reservation.sql
-- ----------------------------------------------------------------------------

-- Migration 027: explicitly release short-lived grounding budget reservations after provider completion.
-- Additive, idempotent, and restricted to trusted server execution.
BEGIN;

CREATE OR REPLACE FUNCTION public.pooldocai_finish_grounding_budget(p_reservation_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  affected integer;
BEGIN
  IF p_reservation_id IS NULL THEN
    RETURN false;
  END IF;

  DELETE FROM public.pooldocai_grounding_budget_reservations
  WHERE id = p_reservation_id;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_finish_grounding_budget(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_finish_grounding_budget(uuid) TO service_role;
COMMENT ON FUNCTION public.pooldocai_finish_grounding_budget(uuid) IS
  'Releases a grounding budget reservation immediately after a completed or failed Search-enabled request.';

COMMIT;

-- ----------------------------------------------------------------------------
-- Migration 29/47: 20261023050000_restore_company_diagnostic_learning_consent_trigger.sql
-- ----------------------------------------------------------------------------

-- Migration 028: restore the company diagnostic-learning consent audit trigger if it drifted.
-- Idempotent forward-only repair: migration 016 already defines the audited consent function.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.diagnostic_learning_consent_audit') IS NULL THEN
    RAISE EXCEPTION 'diagnostic_learning_consent_audit must exist before restoring its trigger';
  END IF;
  IF to_regprocedure('public.pooldocai_audit_diagnostic_learning_consent()') IS NULL THEN
    RAISE EXCEPTION 'pooldocai_audit_diagnostic_learning_consent() must exist before restoring its trigger';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='companies' AND column_name='diagnostic_learning_opt_in'
  ) THEN
    RAISE EXCEPTION 'companies.diagnostic_learning_opt_in must exist before restoring its trigger';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS companies_diagnostic_learning_consent_audit ON public.companies;
CREATE TRIGGER companies_diagnostic_learning_consent_audit
BEFORE UPDATE OF diagnostic_learning_opt_in ON public.companies
FOR EACH ROW
EXECUTE FUNCTION public.pooldocai_audit_diagnostic_learning_consent();

COMMIT;

-- ----------------------------------------------------------------------------
-- Migration 30/47: 20261023060000_storage_temporary_access_expiry_policy.sql
-- ----------------------------------------------------------------------------

-- Migration 030: Extend restrictive temporary-account expiry policy to storage.objects.
-- Ensures expired or revoked temporary trial credentials cannot read or upload files in Supabase Storage.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'storage' AND tablename = 'objects') THEN
    DROP POLICY IF EXISTS temporary_access_storage_expiry_guard ON storage.objects;
    CREATE POLICY temporary_access_storage_expiry_guard ON storage.objects
      AS RESTRICTIVE FOR ALL TO authenticated
      USING (public.temporary_access_is_valid(auth.uid()))
      WITH CHECK (public.temporary_access_is_valid(auth.uid()));
  END IF;
END $$;

COMMIT;

-- ----------------------------------------------------------------------------
-- Migration 31/47: 20261023070000_case_level_learning_consent_dual_opt_in.sql
-- ----------------------------------------------------------------------------

-- Migration 031: Case-level learning consent, applicable terms version, dual-opt-in enforcement, and automatic withdrawal revocation.
-- Forward-only and additive. Preserves all existing private diagnostic records, company permissions, and migrations 001-030.
BEGIN;

-- 1. Add case-level learning permission and terms version columns to diagnostic_cases
ALTER TABLE public.diagnostic_cases
  ADD COLUMN IF NOT EXISTS case_learning_opt_in boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS learning_terms_version text,
  ADD COLUMN IF NOT EXISTS case_learning_consent_updated_at timestamptz;

-- 2. Create index for fast lookups of consent-eligible cases
CREATE INDEX IF NOT EXISTS diagnostic_cases_learning_consent_idx
  ON public.diagnostic_cases(tenant_id, case_learning_opt_in, approved_for_learning);

-- 3. Case consent audit and automatic shared-learning withdrawal trigger
CREATE OR REPLACE FUNCTION public.pooldocai_audit_case_learning_consent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.case_learning_opt_in IS DISTINCT FROM OLD.case_learning_opt_in THEN
    NEW.case_learning_consent_updated_at := now();
    IF OLD.case_learning_opt_in AND NOT NEW.case_learning_opt_in THEN
      -- Case-level consent withdrawal immediately removes any shared lesson derived from this case
      INSERT INTO public.learning_review_audit(queue_id, case_id, actor_user_id, action, note_redacted)
      SELECT q.id, NEW.id, auth.uid(), 'consent_withdrawn', 'Case-level diagnostic shared-learning consent withdrawn; shared publication revoked.'
      FROM public.learning_review_queue q
      WHERE q.case_id = NEW.id AND q.status IN ('pending', 'approved');

      UPDATE public.learning_review_queue
      SET status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now()
      WHERE case_id = NEW.id AND status = 'pending';

      NEW.approved_for_learning := false;
      NEW.privacy_reviewed_at := null;

      DELETE FROM public.shared_learning_knowledge
      WHERE source_case_id = NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_audit_case_learning_consent() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS diagnostic_cases_learning_consent_audit ON public.diagnostic_cases;
CREATE TRIGGER diagnostic_cases_learning_consent_audit
BEFORE UPDATE OF case_learning_opt_in ON public.diagnostic_cases
FOR EACH ROW EXECUTE FUNCTION public.pooldocai_audit_case_learning_consent();

-- 4. Transaction-safe atomic approval function for learning cases
CREATE OR REPLACE FUNCTION public.pooldocai_approve_learning_case(
  p_queue_id uuid,
  p_lesson text,
  p_reviewed_by uuid,
  p_review_note text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_queue public.learning_review_queue%ROWTYPE;
  v_case public.diagnostic_cases%ROWTYPE;
  v_company_opted_in boolean := false;
  v_manual_opted_in boolean := false;
  v_manual_id uuid;
BEGIN
  -- Lock review queue row
  SELECT * INTO v_queue
  FROM public.learning_review_queue
  WHERE id = p_queue_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Review queue item % not found', p_queue_id;
  END IF;

  IF v_queue.status <> 'pending' THEN
    RAISE EXCEPTION 'Review item % is not pending (status: %)', p_queue_id, v_queue.status;
  END IF;

  -- Verify document consent if manual
  IF v_queue.source_kind = 'company_manual' THEN
    -- Extract manual id from supporting sources
    SELECT (array_agg(elem))[1]::uuid INTO v_manual_id
    FROM unnest(v_queue.supporting_source_ids) AS elem
    WHERE elem NOT LIKE '%#chunk-%';

    IF v_manual_id IS NOT NULL THEN
      SELECT shared_learning_opt_in INTO v_manual_opted_in
      FROM public.company_manuals
      WHERE id = v_manual_id AND company_id = v_queue.tenant_id;
    END IF;

    IF NOT COALESCE(v_manual_opted_in, false) THEN
      RAISE EXCEPTION 'Source company manual opt-in consent is missing or revoked';
    END IF;
  ELSIF v_queue.case_id IS NOT NULL THEN
    -- Lock diagnostic case row
    SELECT * INTO v_case
    FROM public.diagnostic_cases
    WHERE id = v_queue.case_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Diagnostic case % not found', v_queue.case_id;
    END IF;

    -- Recheck explicit case-level consent
    IF NOT COALESCE(v_case.case_learning_opt_in, false) THEN
      RAISE EXCEPTION 'Case-level learning consent was not granted or was withdrawn';
    END IF;

    -- Recheck governing company consent
    IF v_queue.tenant_id IS NOT NULL THEN
      SELECT diagnostic_learning_opt_in INTO v_company_opted_in
      FROM public.companies
      WHERE id = v_queue.tenant_id;

      IF NOT COALESCE(v_company_opted_in, false) THEN
        RAISE EXCEPTION 'Governing company diagnostic learning opt-in is required';
      END IF;
    END IF;
  END IF;

  -- Upsert into shared_learning_knowledge atomically
  INSERT INTO public.shared_learning_knowledge (
    source_case_id,
    source_queue_id,
    source_company_id,
    source_kind,
    equipment_category,
    manufacturer_normalized,
    model_normalized,
    lesson_redacted,
    approved_by,
    consent_snapshot,
    review_history
  ) VALUES (
    v_queue.case_id,
    v_queue.id,
    v_queue.tenant_id,
    v_queue.source_kind,
    v_case.equipment_category,
    v_case.manufacturer_normalized,
    v_case.model_normalized,
    p_lesson,
    p_reviewed_by,
    true,
    jsonb_build_array(jsonb_build_object(
      'action', 'approved',
      'actor', p_reviewed_by,
      'at', now(),
      'note', p_review_note
    ))
  )
  ON CONFLICT (source_queue_id) DO UPDATE SET
    lesson_redacted = EXCLUDED.lesson_redacted,
    approved_by = EXCLUDED.approved_by,
    consent_snapshot = true,
    review_history = public.shared_learning_knowledge.review_history || EXCLUDED.review_history;

  -- Mark case approved
  IF v_queue.case_id IS NOT NULL THEN
    UPDATE public.diagnostic_cases
    SET approved_for_learning = true, privacy_reviewed_at = now()
    WHERE id = v_queue.case_id;
  END IF;

  -- Mark queue item approved
  UPDATE public.learning_review_queue
  SET status = 'approved', reviewed_by = p_reviewed_by, reviewed_at = now()
  WHERE id = p_queue_id;

  -- Log audit
  INSERT INTO public.learning_review_audit (
    queue_id,
    case_id,
    actor_user_id,
    action,
    note_redacted
  ) VALUES (
    p_queue_id,
    v_queue.case_id,
    p_reviewed_by,
    'approved',
    p_review_note
  );

  RETURN jsonb_build_object('ok', true, 'status', 'approved', 'queue_id', p_queue_id);
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_approve_learning_case(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_approve_learning_case(uuid, text, uuid, text) TO service_role;

COMMENT ON FUNCTION public.pooldocai_approve_learning_case(uuid, text, uuid, text)
IS 'Atomically verifies company and case-level consent, publishes approved lesson to shared RAG, updates case and queue status, and logs audit.';

COMMIT;

-- ----------------------------------------------------------------------------
-- Migration 32/47: 20261023080000_public_demo_learning_consent_reconciliation.sql
-- ----------------------------------------------------------------------------

-- Migration 032: Reconcile public-demo case consent and enforce strict fail-closed atomic approval.
-- Forward-only and additive. Backward-compatible with legitimately consented public-demo cases (learning_permission_granted = true with legal_terms_version).
-- Does not silently grant consent to unconsented cases.
BEGIN;

-- 1. Reconcile pooldocai_approve_learning_case to support legitimately consented public-demo cases
CREATE OR REPLACE FUNCTION public.pooldocai_approve_learning_case(
  p_queue_id uuid,
  p_lesson text,
  p_reviewed_by uuid,
  p_review_note text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_queue public.learning_review_queue%ROWTYPE;
  v_case public.diagnostic_cases%ROWTYPE;
  v_company_opted_in boolean := false;
  v_manual_opted_in boolean := false;
  v_manual_id uuid;
  v_has_case_consent boolean := false;
BEGIN
  -- Lock review queue row
  SELECT * INTO v_queue
  FROM public.learning_review_queue
  WHERE id = p_queue_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Review queue item % not found', p_queue_id;
  END IF;

  IF v_queue.status <> 'pending' THEN
    RAISE EXCEPTION 'Review item % is not pending (status: %)', p_queue_id, v_queue.status;
  END IF;

  -- Verify document consent if manual
  IF v_queue.source_kind = 'company_manual' THEN
    -- Extract manual id from supporting sources
    SELECT (array_agg(elem))[1]::uuid INTO v_manual_id
    FROM unnest(v_queue.supporting_source_ids) AS elem
    WHERE elem NOT LIKE '%#chunk-%';

    IF v_manual_id IS NOT NULL THEN
      SELECT shared_learning_opt_in INTO v_manual_opted_in
      FROM public.company_manuals
      WHERE id = v_manual_id AND company_id = v_queue.tenant_id;
    END IF;

    IF NOT COALESCE(v_manual_opted_in, false) THEN
      RAISE EXCEPTION 'Source company manual opt-in consent is missing or revoked';
    END IF;
  ELSIF v_queue.case_id IS NOT NULL THEN
    -- Lock diagnostic case row
    SELECT * INTO v_case
    FROM public.diagnostic_cases
    WHERE id = v_queue.case_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Diagnostic case % not found', v_queue.case_id;
    END IF;

    -- Backwards-compatible consent check:
    -- 1) Authenticated company case: requires explicit case_learning_opt_in AND governing company opt-in
    -- 2) Public-demo case (tenant_id IS NULL): requires case_learning_opt_in OR (learning_permission_granted AND legal_terms_version IS NOT NULL)
    IF v_case.tenant_id IS NOT NULL THEN
      IF NOT COALESCE(v_case.case_learning_opt_in, false) THEN
        RAISE EXCEPTION 'Case-level learning consent was not granted or was withdrawn';
      END IF;

      -- Recheck governing company consent
      SELECT diagnostic_learning_opt_in INTO v_company_opted_in
      FROM public.companies
      WHERE id = v_case.tenant_id;

      IF NOT COALESCE(v_company_opted_in, false) THEN
        RAISE EXCEPTION 'Governing company diagnostic learning opt-in is required';
      END IF;
    ELSE
      -- Public-demo case consent check: do not grant consent to unconsented cases
      v_has_case_consent := COALESCE(v_case.case_learning_opt_in, false) OR (
        COALESCE(v_case.learning_permission_granted, false) AND v_case.legal_terms_version IS NOT NULL
      );

      IF NOT v_has_case_consent THEN
        RAISE EXCEPTION 'Public demo case-level learning consent was not granted or was withdrawn';
      END IF;
    END IF;
  END IF;

  -- Upsert into shared_learning_knowledge atomically
  INSERT INTO public.shared_learning_knowledge (
    source_case_id,
    source_queue_id,
    source_company_id,
    source_kind,
    equipment_category,
    manufacturer_normalized,
    model_normalized,
    lesson_redacted,
    approved_by,
    consent_snapshot,
    review_history
  ) VALUES (
    v_queue.case_id,
    v_queue.id,
    v_queue.tenant_id,
    v_queue.source_kind,
    v_case.equipment_category,
    v_case.manufacturer_normalized,
    v_case.model_normalized,
    p_lesson,
    p_reviewed_by,
    true,
    jsonb_build_array(jsonb_build_object(
      'action', 'approved',
      'actor', p_reviewed_by,
      'at', now(),
      'note', p_review_note
    ))
  )
  ON CONFLICT (source_queue_id) DO UPDATE SET
    lesson_redacted = EXCLUDED.lesson_redacted,
    approved_by = EXCLUDED.approved_by,
    consent_snapshot = true,
    review_history = public.shared_learning_knowledge.review_history || EXCLUDED.review_history;

  -- Mark case approved
  IF v_queue.case_id IS NOT NULL THEN
    UPDATE public.diagnostic_cases
    SET approved_for_learning = true, privacy_reviewed_at = now()
    WHERE id = v_queue.case_id;
  END IF;

  -- Mark queue item approved
  UPDATE public.learning_review_queue
  SET status = 'approved', reviewed_by = p_reviewed_by, reviewed_at = now()
  WHERE id = p_queue_id;

  -- Log audit
  INSERT INTO public.learning_review_audit (
    queue_id,
    case_id,
    actor_user_id,
    action,
    note_redacted
  ) VALUES (
    p_queue_id,
    v_queue.case_id,
    p_reviewed_by,
    'approved',
    p_review_note
  );

  RETURN jsonb_build_object('ok', true, 'status', 'approved', 'queue_id', p_queue_id);
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_approve_learning_case(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_approve_learning_case(uuid, text, uuid, text) TO service_role;

-- 2. Enhance pooldocai_audit_case_learning_consent to handle learning_permission_granted withdrawal as well
CREATE OR REPLACE FUNCTION public.pooldocai_audit_case_learning_consent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF (NEW.case_learning_opt_in IS DISTINCT FROM OLD.case_learning_opt_in) OR (NEW.learning_permission_granted IS DISTINCT FROM OLD.learning_permission_granted) THEN
    NEW.case_learning_consent_updated_at := now();
    -- If consent is revoked (either flag went from true to false)
    IF (OLD.case_learning_opt_in AND NOT NEW.case_learning_opt_in) OR (OLD.learning_permission_granted AND NOT NEW.learning_permission_granted) THEN
      NEW.case_learning_opt_in := false;
      NEW.learning_permission_granted := false;
      NEW.approved_for_learning := false;
      NEW.privacy_reviewed_at := null;

      INSERT INTO public.learning_review_audit(queue_id, case_id, actor_user_id, action, note_redacted)
      SELECT q.id, NEW.id, auth.uid(), 'consent_withdrawn', 'Case-level diagnostic shared-learning consent withdrawn; shared publication revoked.'
      FROM public.learning_review_queue q
      WHERE q.case_id = NEW.id AND q.status IN ('pending', 'approved');

      UPDATE public.learning_review_queue
      SET status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now()
      WHERE case_id = NEW.id AND status = 'pending';

      DELETE FROM public.shared_learning_knowledge
      WHERE source_case_id = NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS diagnostic_cases_learning_consent_audit ON public.diagnostic_cases;
CREATE TRIGGER diagnostic_cases_learning_consent_audit
BEFORE UPDATE OF case_learning_opt_in, learning_permission_granted ON public.diagnostic_cases
FOR EACH ROW EXECUTE FUNCTION public.pooldocai_audit_case_learning_consent();

COMMIT;

-- ----------------------------------------------------------------------------
-- Migration 33/47: 20261023090000_stripe_webhook_atomic_claim_and_recovery.sql
-- ----------------------------------------------------------------------------

-- Migration 033: Stripe webhook atomic event claiming, bounded retry/recovery, and concurrency locking.
-- Forward-only and additive.
BEGIN;

-- Add claimed_at and attempts to pooldocai_stripe_webhook_events if they do not exist
ALTER TABLE public.pooldocai_stripe_webhook_events
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

-- Function: pooldocai_claim_stripe_webhook_event
-- Atomically claims a Stripe webhook event with an exclusive row lock and lease expiration.
-- Prevents concurrent workers from simultaneously applying the same event.
CREATE OR REPLACE FUNCTION public.pooldocai_claim_stripe_webhook_event(
  p_event_id text,
  p_event_type text,
  p_lock_timeout_seconds integer DEFAULT 60,
  p_max_attempts integer DEFAULT 5
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_row public.pooldocai_stripe_webhook_events%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_remaining_seconds integer;
BEGIN
  -- Insert placeholder row if this is the first delivery of this event ID
  INSERT INTO public.pooldocai_stripe_webhook_events (
    stripe_event_id, event_type, processed, attempts
  ) VALUES (
    p_event_id, p_event_type, false, 0
  )
  ON CONFLICT (stripe_event_id) DO NOTHING;

  -- Exclusively lock the row for atomic inspection and state transition
  SELECT * INTO v_row
  FROM public.pooldocai_stripe_webhook_events
  WHERE stripe_event_id = p_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'Event row missing after insert');
  END IF;

  -- 1. If already fully processed, acknowledge idempotently as duplicate
  IF v_row.processed THEN
    RETURN jsonb_build_object('status', 'already_processed', 'processed', true, 'duplicate', true);
  END IF;

  -- 2. If currently claimed and the lease has NOT expired, another worker is actively processing it
  IF v_row.claimed_at IS NOT NULL AND v_row.claimed_at > (v_now - (p_lock_timeout_seconds || ' seconds')::interval) THEN
    v_remaining_seconds := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_row.claimed_at + (p_lock_timeout_seconds || ' seconds')::interval - v_now)))::integer);
    RETURN jsonb_build_object(
      'status', 'in_progress',
      'retry_after', v_remaining_seconds,
      'attempts', v_row.attempts
    );
  END IF;

  -- 3. If max retry attempts exceeded, prevent unbounded thrashing
  IF v_row.attempts >= p_max_attempts THEN
    RETURN jsonb_build_object(
      'status', 'max_attempts_exceeded',
      'attempts', v_row.attempts,
      'processing_error', v_row.processing_error
    );
  END IF;

  -- 4. Exclusively claim the event!
  UPDATE public.pooldocai_stripe_webhook_events
  SET claimed_at = v_now,
      attempts = attempts + 1,
      event_type = p_event_type,
      processing_error = NULL
  WHERE stripe_event_id = p_event_id;

  RETURN jsonb_build_object(
    'status', 'claimed',
    'attempts', v_row.attempts + 1
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_claim_stripe_webhook_event(text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_claim_stripe_webhook_event(text, text, integer, integer) TO service_role;

COMMIT;

-- ----------------------------------------------------------------------------
-- Migration 34/47: 20261023100000_stripe_webhook_claim_fencing.sql
-- ----------------------------------------------------------------------------

-- Migration 034: Stripe webhook claim ownership fencing, atomic billing application, and lease governance.
-- Forward-only and additive.
BEGIN;

-- 1. Add claim_token and lease_generation to pooldocai_stripe_webhook_events if they do not exist
ALTER TABLE public.pooldocai_stripe_webhook_events
  ADD COLUMN IF NOT EXISTS claim_token text,
  ADD COLUMN IF NOT EXISTS lease_generation integer NOT NULL DEFAULT 0;

-- Ensure pgcrypto extension is available for secure random token generation
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- 2. Function: pooldocai_claim_stripe_webhook_event (updated with claim token and lease generation)
CREATE OR REPLACE FUNCTION public.pooldocai_claim_stripe_webhook_event(
  p_event_id text,
  p_event_type text,
  p_lock_timeout_seconds integer DEFAULT 60,
  p_max_attempts integer DEFAULT 5
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE
  v_row public.pooldocai_stripe_webhook_events%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_remaining_seconds integer;
  v_new_token text;
  v_new_gen integer;
BEGIN
  IF p_event_id IS NULL OR trim(p_event_id) = '' THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'Event ID cannot be empty');
  END IF;

  -- Insert placeholder row if this is the first delivery of this event ID
  INSERT INTO public.pooldocai_stripe_webhook_events (
    stripe_event_id, event_type, processed, attempts, lease_generation
  ) VALUES (
    p_event_id, p_event_type, false, 0, 0
  )
  ON CONFLICT (stripe_event_id) DO NOTHING;

  -- Exclusively lock the row for atomic inspection and state transition
  SELECT * INTO v_row
  FROM public.pooldocai_stripe_webhook_events
  WHERE stripe_event_id = p_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'Event row missing after insert');
  END IF;

  -- A. If already fully processed, acknowledge idempotently as duplicate
  IF v_row.processed THEN
    RETURN jsonb_build_object(
      'status', 'already_processed',
      'processed', true,
      'duplicate', true,
      'lease_generation', v_row.lease_generation
    );
  END IF;

  -- B. If currently claimed and the lease has NOT expired, another worker is actively processing it
  IF v_row.claimed_at IS NOT NULL AND v_row.claimed_at > (v_now - (p_lock_timeout_seconds || ' seconds')::interval) THEN
    v_remaining_seconds := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_row.claimed_at + (p_lock_timeout_seconds || ' seconds')::interval - v_now)))::integer);
    RETURN jsonb_build_object(
      'status', 'in_progress',
      'retry_after', v_remaining_seconds,
      'attempts', v_row.attempts,
      'lease_generation', v_row.lease_generation
    );
  END IF;

  -- C. If max retry attempts exceeded, prevent unbounded thrashing
  IF v_row.attempts >= p_max_attempts THEN
    RETURN jsonb_build_object(
      'status', 'max_attempts_exceeded',
      'attempts', v_row.attempts,
      'processing_error', v_row.processing_error,
      'lease_generation', v_row.lease_generation
    );
  END IF;

  -- D. Generate unpredictable ownership token and advance monotonic lease generation
  v_new_token := 'claim_' || encode(gen_random_bytes(24), 'hex');
  v_new_gen := COALESCE(v_row.lease_generation, 0) + 1;

  UPDATE public.pooldocai_stripe_webhook_events
  SET claimed_at = v_now,
      claim_token = v_new_token,
      lease_generation = v_new_gen,
      attempts = attempts + 1,
      event_type = p_event_type,
      processing_error = NULL
  WHERE stripe_event_id = p_event_id;

  RETURN jsonb_build_object(
    'status', 'claimed',
    'claim_token', v_new_token,
    'lease_generation', v_new_gen,
    'attempts', v_row.attempts + 1
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_claim_stripe_webhook_event(text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_claim_stripe_webhook_event(text, text, integer, integer) TO service_role;


-- 3. Function: pooldocai_apply_and_finalize_stripe_webhook
-- Atomically applies company billing updates, logs usage, and finalizes event processing,
-- guarded by claim token fence. Fails closed if the worker's lease expired or claim token does not match.
CREATE OR REPLACE FUNCTION public.pooldocai_apply_and_finalize_stripe_webhook(
  p_event_id text,
  p_claim_token text,
  p_company_id uuid DEFAULT NULL,
  p_company_updates jsonb DEFAULT NULL,
  p_usage_event jsonb DEFAULT NULL,
  p_processing_note text DEFAULT NULL,
  p_ignored boolean DEFAULT false
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE
  v_row public.pooldocai_stripe_webhook_events%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_seat_limit integer;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_trial_ends_at timestamptz;
BEGIN
  -- Set transaction-local claim role to service_role so downstream security triggers recognize trusted billing service
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- Strict validation of claim token: empty/unknown tokens are rejected
  IF p_claim_token IS NULL OR trim(p_claim_token) = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'invalid_claim_token',
      'error', 'A non-empty claim ownership token is required to finalize webhook events'
    );
  END IF;

  -- Exclusively lock the webhook event row
  SELECT * INTO v_row
  FROM public.pooldocai_stripe_webhook_events
  WHERE stripe_event_id = p_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'not_found',
      'error', 'Webhook event row not found'
    );
  END IF;

  -- Fencing check 1: Event already finalized
  IF v_row.processed THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'already_processed',
      'fenced', true,
      'error', 'Webhook event was already finalized by another worker'
    );
  END IF;

  -- Fencing check 2: Worker claim token must match active lease exactly
  IF v_row.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'fenced_out',
      'fenced', true,
      'error', 'Stale claim token: lease expired or ownership claimed by a newer worker'
    );
  END IF;

  -- Ownership confirmed: Apply local database mutations within this transaction

  -- A. Company billing update (if provided and not ignored)
  IF NOT p_ignored AND p_company_id IS NOT NULL AND p_company_updates IS NOT NULL AND jsonb_typeof(p_company_updates) = 'object' THEN
    IF (p_company_updates->>'seat_limit') IS NOT NULL THEN
      v_seat_limit := (p_company_updates->>'seat_limit')::integer;
    END IF;
    IF (p_company_updates->>'billing_period_start') IS NOT NULL THEN
      v_period_start := (p_company_updates->>'billing_period_start')::timestamptz;
    END IF;
    IF (p_company_updates->>'current_period_end') IS NOT NULL THEN
      v_period_end := (p_company_updates->>'current_period_end')::timestamptz;
    END IF;
    IF (p_company_updates->>'trial_ends_at') IS NOT NULL THEN
      v_trial_ends_at := (p_company_updates->>'trial_ends_at')::timestamptz;
    END IF;

    UPDATE public.companies
    SET
      stripe_customer_id = COALESCE(p_company_updates->>'stripe_customer_id', stripe_customer_id),
      billing_customer_ref = COALESCE(p_company_updates->>'billing_customer_ref', billing_customer_ref),
      stripe_subscription_id = COALESCE(p_company_updates->>'stripe_subscription_id', stripe_subscription_id),
      billing_subscription_ref = COALESCE(p_company_updates->>'billing_subscription_ref', billing_subscription_ref),
      billing_status = COALESCE(p_company_updates->>'billing_status', billing_status),
      stripe_price_id = COALESCE(p_company_updates->>'stripe_price_id', stripe_price_id),
      plan_name = COALESCE(p_company_updates->>'plan_name', plan_name),
      seat_limit = COALESCE(v_seat_limit, seat_limit),
      billing_period_start = COALESCE(v_period_start, billing_period_start),
      current_period_end = COALESCE(v_period_end, current_period_end),
      trial_ends_at = COALESCE(v_trial_ends_at, trial_ends_at),
      status = COALESCE(p_company_updates->>'status', status),
      updated_at = v_now
    WHERE id = p_company_id;

    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'success', false,
        'status', 'company_not_found',
        'error', 'Target company not found for billing update'
      );
    END IF;
  END IF;

  -- B. Record usage event in platform_usage_events (if provided and not ignored)
  IF NOT p_ignored AND p_company_id IS NOT NULL AND p_usage_event IS NOT NULL AND jsonb_typeof(p_usage_event) = 'object' THEN
    INSERT INTO public.platform_usage_events (
      company_id, event_type, units, metric_type, quantity, quantity_unit, source_event_key, metadata
    ) VALUES (
      p_company_id,
      COALESCE(p_usage_event->>'event_type', 'stripe_' || v_row.event_type),
      COALESCE((p_usage_event->>'units')::integer, 1),
      COALESCE(p_usage_event->>'metric_type', 'billing_event'),
      COALESCE((p_usage_event->>'quantity')::integer, 1),
      COALESCE(p_usage_event->>'quantity_unit', 'webhook_event'),
      p_event_id,
      COALESCE(p_usage_event->'metadata', '{}'::jsonb)
    );
  END IF;

  -- C. Mark event processed and clear claim
  UPDATE public.pooldocai_stripe_webhook_events
  SET processed = true,
      processed_at = v_now,
      claimed_at = NULL,
      claim_token = NULL,
      processing_error = p_processing_note
  WHERE stripe_event_id = p_event_id;

  RETURN jsonb_build_object(
    'success', true,
    'status', CASE WHEN p_ignored THEN 'ignored' ELSE 'applied' END,
    'processed', true,
    'lease_generation', v_row.lease_generation
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_apply_and_finalize_stripe_webhook(text, text, uuid, jsonb, jsonb, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_apply_and_finalize_stripe_webhook(text, text, uuid, jsonb, jsonb, text, boolean) TO service_role;


-- 4. Function: pooldocai_release_stripe_webhook_event
-- Releases a claimed event on worker failure so it can be retried.
-- Fails closed if the caller does not possess the active claim token.
CREATE OR REPLACE FUNCTION public.pooldocai_release_stripe_webhook_event(
  p_event_id text,
  p_claim_token text,
  p_error text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE
  v_row public.pooldocai_stripe_webhook_events%ROWTYPE;
BEGIN
  IF p_claim_token IS NULL OR trim(p_claim_token) = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'invalid_claim_token',
      'error', 'A non-empty claim token is required to release an event'
    );
  END IF;

  SELECT * INTO v_row
  FROM public.pooldocai_stripe_webhook_events
  WHERE stripe_event_id = p_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'not_found',
      'error', 'Webhook event row not found'
    );
  END IF;

  IF v_row.processed THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'already_processed',
      'fenced', true,
      'error', 'Cannot release: event was already finalized'
    );
  END IF;

  IF v_row.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'fenced_out',
      'fenced', true,
      'error', 'Cannot release: claim token does not match active lease'
    );
  END IF;

  -- Release the claim so it can be retried
  UPDATE public.pooldocai_stripe_webhook_events
  SET claimed_at = NULL,
      claim_token = NULL,
      processing_error = p_error
  WHERE stripe_event_id = p_event_id;

  RETURN jsonb_build_object(
    'success', true,
    'status', 'released',
    'attempts', v_row.attempts,
    'lease_generation', v_row.lease_generation
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_release_stripe_webhook_event(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_release_stripe_webhook_event(text, text, text) TO service_role;

COMMIT;

-- ----------------------------------------------------------------------------
-- Migration 35/47: 20261023110000_stripe_webhook_company_ordering_guard.sql
-- ----------------------------------------------------------------------------

-- Migration 035: Per-company transactionally serialized ordering check for Stripe webhook processing.
-- Forward-only and additive.
BEGIN;

-- Update pooldocai_apply_and_finalize_stripe_webhook with row-level company locking and conditional state ordering
CREATE OR REPLACE FUNCTION public.pooldocai_apply_and_finalize_stripe_webhook(
  p_event_id text,
  p_claim_token text,
  p_company_id uuid DEFAULT NULL,
  p_company_updates jsonb DEFAULT NULL,
  p_usage_event jsonb DEFAULT NULL,
  p_processing_note text DEFAULT NULL,
  p_ignored boolean DEFAULT false
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE
  v_row public.pooldocai_stripe_webhook_events%ROWTYPE;
  v_company public.companies%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_seat_limit integer;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_trial_ends_at timestamptz;
  v_incoming_sub_id text;
  v_incoming_status text;
  v_incoming_billing_status text;
  v_is_stale_period boolean := false;
  v_is_old_subscription boolean := false;
  v_stale_reason text := NULL;
BEGIN
  -- Set transaction-local claim role to service_role so downstream security triggers recognize trusted billing service
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- Strict validation of claim token: empty/unknown tokens are rejected
  IF p_claim_token IS NULL OR trim(p_claim_token) = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'invalid_claim_token',
      'error', 'A non-empty claim ownership token is required to finalize webhook events'
    );
  END IF;

  -- 1. Exclusively lock the webhook event row
  SELECT * INTO v_row
  FROM public.pooldocai_stripe_webhook_events
  WHERE stripe_event_id = p_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'not_found',
      'error', 'Webhook event row not found'
    );
  END IF;

  -- Fencing check 1: Event already finalized
  IF v_row.processed THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'already_processed',
      'fenced', true,
      'error', 'Webhook event was already finalized by another worker'
    );
  END IF;

  -- Fencing check 2: Worker claim token must match active lease exactly
  IF v_row.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'fenced_out',
      'fenced', true,
      'error', 'Stale claim token: lease expired or ownership claimed by a newer worker'
    );
  END IF;

  -- 2. Company billing update branch
  IF NOT p_ignored AND p_company_id IS NOT NULL AND p_company_updates IS NOT NULL AND jsonb_typeof(p_company_updates) = 'object' THEN
    -- Exclusively lock the company row to serialize concurrent events targeting the same company
    SELECT * INTO v_company
    FROM public.companies
    WHERE id = p_company_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'success', false,
        'status', 'company_not_found',
        'error', 'Target company not found for billing update'
      );
    END IF;

    -- Extract update values for type casting and ordering comparison
    IF (p_company_updates->>'seat_limit') IS NOT NULL THEN
      v_seat_limit := (p_company_updates->>'seat_limit')::integer;
    END IF;
    IF (p_company_updates->>'billing_period_start') IS NOT NULL THEN
      v_period_start := (p_company_updates->>'billing_period_start')::timestamptz;
    END IF;
    IF (p_company_updates->>'current_period_end') IS NOT NULL THEN
      v_period_end := (p_company_updates->>'current_period_end')::timestamptz;
    END IF;
    IF (p_company_updates->>'trial_ends_at') IS NOT NULL THEN
      v_trial_ends_at := (p_company_updates->>'trial_ends_at')::timestamptz;
    END IF;

    v_incoming_sub_id := p_company_updates->>'stripe_subscription_id';
    v_incoming_status := p_company_updates->>'status';
    v_incoming_billing_status := p_company_updates->>'billing_status';

    -- Database-side conditional ordering guard A: Stale billing period
    -- If company already has a recorded period start, an incoming update with an older period start is stale
    IF v_period_start IS NOT NULL AND v_company.billing_period_start IS NOT NULL AND v_period_start < v_company.billing_period_start THEN
      v_is_stale_period := true;
      v_stale_reason := 'stale_out_of_order_event';
    END IF;

    -- Database-side conditional ordering guard B: Superseded subscription
    -- If company has an active subscription ID and incoming update is from a different subscription
    IF v_company.stripe_subscription_id IS NOT NULL AND v_incoming_sub_id IS NOT NULL AND v_incoming_sub_id <> v_company.stripe_subscription_id THEN
      IF (
        v_row.event_type = 'customer.subscription.deleted'
        OR v_row.event_type LIKE 'invoice.%'
        OR v_incoming_status = 'cancelled'
        OR v_incoming_billing_status = 'cancelled'
        OR v_period_start IS NULL
        OR v_company.billing_period_start IS NULL
        OR v_period_start <= v_company.billing_period_start
      ) THEN
        v_is_old_subscription := true;
        v_stale_reason := CASE WHEN v_row.event_type LIKE 'invoice.%' THEN 'stale_old_subscription_invoice' ELSE 'stale_old_subscription' END;
      END IF;
    END IF;

    -- If the event is determined to be stale under the company lock, safely finalize it as ignored
    IF v_is_stale_period OR v_is_old_subscription THEN
      UPDATE public.pooldocai_stripe_webhook_events
      SET processed = true,
          processed_at = v_now,
          claimed_at = NULL,
          claim_token = NULL,
          processing_error = CASE 
            WHEN v_is_old_subscription THEN 'Stale event from superseded subscription skipped (newer subscription active in database).'
            ELSE 'Stale out-of-order event skipped (newer period already active in database).'
          END
      WHERE stripe_event_id = p_event_id;

      RETURN jsonb_build_object(
        'success', true,
        'status', 'ignored',
        'reason', v_stale_reason,
        'processed', true,
        'lease_generation', v_row.lease_generation
      );
    END IF;

    -- Conditional checks passed: update company billing fields
    UPDATE public.companies
    SET
      stripe_customer_id = COALESCE(p_company_updates->>'stripe_customer_id', stripe_customer_id),
      billing_customer_ref = COALESCE(p_company_updates->>'billing_customer_ref', billing_customer_ref),
      stripe_subscription_id = COALESCE(v_incoming_sub_id, stripe_subscription_id),
      billing_subscription_ref = COALESCE(p_company_updates->>'billing_subscription_ref', billing_subscription_ref),
      billing_status = COALESCE(v_incoming_billing_status, billing_status),
      stripe_price_id = COALESCE(p_company_updates->>'stripe_price_id', stripe_price_id),
      plan_name = COALESCE(p_company_updates->>'plan_name', plan_name),
      seat_limit = COALESCE(v_seat_limit, seat_limit),
      billing_period_start = COALESCE(v_period_start, billing_period_start),
      current_period_end = COALESCE(v_period_end, current_period_end),
      trial_ends_at = COALESCE(v_trial_ends_at, trial_ends_at),
      status = COALESCE(v_incoming_status, status),
      updated_at = v_now
    WHERE id = p_company_id;

    -- Insert into platform_usage_events (if provided)
    IF p_usage_event IS NOT NULL AND jsonb_typeof(p_usage_event) = 'object' THEN
      INSERT INTO public.platform_usage_events (
        company_id, event_type, units, metric_type, quantity, quantity_unit, source_event_key, metadata
      ) VALUES (
        p_company_id,
        COALESCE(p_usage_event->>'event_type', 'stripe_' || v_row.event_type),
        COALESCE((p_usage_event->>'units')::integer, 1),
        COALESCE(p_usage_event->>'metric_type', 'billing_event'),
        COALESCE((p_usage_event->>'quantity')::integer, 1),
        COALESCE(p_usage_event->>'quantity_unit', 'webhook_event'),
        p_event_id,
        COALESCE(p_usage_event->'metadata', '{}'::jsonb)
      );
    END IF;
  END IF;

  -- 3. Mark event processed and clear claim
  UPDATE public.pooldocai_stripe_webhook_events
  SET processed = true,
      processed_at = v_now,
      claimed_at = NULL,
      claim_token = NULL,
      processing_error = p_processing_note
  WHERE stripe_event_id = p_event_id;

  RETURN jsonb_build_object(
    'success', true,
    'status', CASE WHEN p_ignored THEN 'ignored' ELSE 'applied' END,
    'processed', true,
    'lease_generation', v_row.lease_generation
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_apply_and_finalize_stripe_webhook(text, text, uuid, jsonb, jsonb, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_apply_and_finalize_stripe_webhook(text, text, uuid, jsonb, jsonb, text, boolean) TO service_role;

COMMIT;

-- ----------------------------------------------------------------------------
-- Migration 36/47: 20261023120000_stripe_webhook_provenance_and_ordering_guard.sql
-- ----------------------------------------------------------------------------

-- Migration 036: Event provenance and authoritative company row-lock validation for Stripe webhooks.
-- Forward-only and additive.
BEGIN;

-- Drop prior 7-argument signature from Migration 035 to eliminate signature ambiguity
DROP FUNCTION IF EXISTS public.pooldocai_apply_and_finalize_stripe_webhook(text, text, uuid, jsonb, jsonb, text, boolean);

-- Create 8-argument signature with structured p_event_provenance support
CREATE OR REPLACE FUNCTION public.pooldocai_apply_and_finalize_stripe_webhook(
  p_event_id text,
  p_claim_token text,
  p_company_id uuid DEFAULT NULL,
  p_company_updates jsonb DEFAULT NULL,
  p_usage_event jsonb DEFAULT NULL,
  p_processing_note text DEFAULT NULL,
  p_ignored boolean DEFAULT false,
  p_event_provenance jsonb DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE
  v_row public.pooldocai_stripe_webhook_events%ROWTYPE;
  v_company public.companies%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_seat_limit integer;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_trial_ends_at timestamptz;
  v_incoming_sub_id text;
  v_incoming_status text;
  v_incoming_billing_status text;
  v_prov_sub_id text;
  v_prov_period_start timestamptz;
  v_prov_period_end timestamptz;
  v_prov_event_type text;
  v_is_stale_period boolean := false;
  v_is_old_subscription boolean := false;
  v_stale_reason text := NULL;
BEGIN
  -- Set transaction-local claim role to service_role so downstream triggers recognize trusted billing context
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- Strict validation of claim token: empty/unknown tokens are rejected
  IF p_claim_token IS NULL OR trim(p_claim_token) = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'invalid_claim_token',
      'error', 'A non-empty claim ownership token is required to finalize webhook events'
    );
  END IF;

  -- 1. Exclusively lock the webhook event row
  SELECT * INTO v_row
  FROM public.pooldocai_stripe_webhook_events
  WHERE stripe_event_id = p_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'not_found',
      'error', 'Webhook event row not found'
    );
  END IF;

  -- Fencing check 1: Event already finalized
  IF v_row.processed THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'already_processed',
      'fenced', true,
      'error', 'Webhook event was already finalized by another worker'
    );
  END IF;

  -- Fencing check 2: Worker claim token must match active lease exactly
  IF v_row.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'fenced_out',
      'fenced', true,
      'error', 'Stale claim token: lease expired or ownership claimed by a newer worker'
    );
  END IF;

  -- 2. Explicit early ignore finalization
  IF p_ignored THEN
    UPDATE public.pooldocai_stripe_webhook_events
    SET processed = true,
        processed_at = v_now,
        claimed_at = NULL,
        claim_token = NULL,
        processing_error = p_processing_note
    WHERE stripe_event_id = p_event_id;

    RETURN jsonb_build_object(
      'success', true,
      'status', 'ignored',
      'processed', true,
      'lease_generation', v_row.lease_generation
    );
  END IF;

  -- 3. Company billing update branch
  IF p_company_id IS NOT NULL AND p_company_updates IS NOT NULL AND jsonb_typeof(p_company_updates) = 'object' THEN
    -- Exclusively lock the company row to serialize all events targeting this tenant
    SELECT * INTO v_company
    FROM public.companies
    WHERE id = p_company_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'success', false,
        'status', 'company_not_found',
        'error', 'Target company not found for billing update'
      );
    END IF;

    -- Extract update fields
    IF (p_company_updates->>'seat_limit') IS NOT NULL THEN
      v_seat_limit := (p_company_updates->>'seat_limit')::integer;
    END IF;
    IF (p_company_updates->>'billing_period_start') IS NOT NULL THEN
      v_period_start := (p_company_updates->>'billing_period_start')::timestamptz;
    END IF;
    IF (p_company_updates->>'current_period_end') IS NOT NULL THEN
      v_period_end := (p_company_updates->>'current_period_end')::timestamptz;
    END IF;
    IF (p_company_updates->>'trial_ends_at') IS NOT NULL THEN
      v_trial_ends_at := (p_company_updates->>'trial_ends_at')::timestamptz;
    END IF;

    v_incoming_sub_id := p_company_updates->>'stripe_subscription_id';
    v_incoming_status := p_company_updates->>'status';
    v_incoming_billing_status := p_company_updates->>'billing_status';

    -- Extract event provenance (passed explicitly or inferred from event/updates)
    v_prov_event_type := COALESCE(p_event_provenance->>'event_type', v_row.event_type);
    v_prov_sub_id := COALESCE(p_event_provenance->>'subscription_id', v_incoming_sub_id);
    v_prov_period_start := COALESCE((p_event_provenance->>'period_start')::timestamptz, v_period_start);
    v_prov_period_end := COALESCE((p_event_provenance->>'period_end')::timestamptz, v_period_end);

    -- Fail-closed provenance check: invoice mutating billing status on tenants with active subscriptions MUST include provenance
    IF v_prov_event_type LIKE 'invoice.%'
       AND v_incoming_billing_status IS NOT NULL
       AND v_company.stripe_subscription_id IS NOT NULL
       AND v_prov_sub_id IS NULL
       AND v_prov_period_start IS NULL THEN
      RETURN jsonb_build_object(
        'success', false,
        'status', 'missing_invoice_provenance',
        'error', 'Invoice event lacks subscription and period provenance required for tenant billing status mutation'
      );
    END IF;

    -- Database-side conditional ordering guard A: Stale billing period
    IF v_prov_period_start IS NOT NULL AND v_company.billing_period_start IS NOT NULL AND v_prov_period_start < v_company.billing_period_start THEN
      v_is_stale_period := true;
      v_stale_reason := CASE 
        WHEN v_prov_event_type LIKE 'invoice.%' THEN 'stale_out_of_order_invoice'
        ELSE 'stale_out_of_order_event'
      END;
    END IF;

    -- Database-side conditional ordering guard B: Superseded subscription
    IF v_company.stripe_subscription_id IS NOT NULL AND v_prov_sub_id IS NOT NULL AND v_prov_sub_id <> v_company.stripe_subscription_id THEN
      -- Invoices, cancellations, and older periods from non-matching subscriptions are strictly superseded
      IF (
        v_prov_event_type LIKE 'invoice.%'
        OR v_prov_event_type = 'customer.subscription.deleted'
        OR v_incoming_status = 'cancelled'
        OR v_incoming_billing_status = 'cancelled'
        OR v_prov_period_start IS NULL
        OR v_company.billing_period_start IS NULL
        OR v_prov_period_start <= v_company.billing_period_start
      ) THEN
        v_is_old_subscription := true;
        v_stale_reason := CASE 
          WHEN v_prov_event_type LIKE 'invoice.%' THEN 'stale_old_subscription_invoice'
          ELSE 'stale_old_subscription'
        END;
      END IF;
    END IF;

    -- If event is stale under locked company state, finalize it as ignored without tenant mutation
    IF v_is_stale_period OR v_is_old_subscription THEN
      UPDATE public.pooldocai_stripe_webhook_events
      SET processed = true,
          processed_at = v_now,
          claimed_at = NULL,
          claim_token = NULL,
          processing_error = CASE 
            WHEN v_stale_reason = 'stale_old_subscription_invoice' THEN 'Stale invoice from superseded subscription skipped (newer subscription active in database).'
            WHEN v_stale_reason = 'stale_out_of_order_invoice' THEN 'Stale out-of-order invoice skipped (newer billing period active in database).'
            WHEN v_stale_reason = 'stale_old_subscription' THEN 'Stale event from superseded subscription skipped (newer subscription active in database).'
            ELSE 'Stale out-of-order event skipped (newer period already active in database).'
          END
      WHERE stripe_event_id = p_event_id;

      RETURN jsonb_build_object(
        'success', true,
        'status', 'ignored',
        'reason', v_stale_reason,
        'processed', true,
        'lease_generation', v_row.lease_generation
      );
    END IF;

    -- Conditional checks passed: apply updates to locked company row
    UPDATE public.companies
    SET
      stripe_customer_id = COALESCE(p_company_updates->>'stripe_customer_id', stripe_customer_id),
      billing_customer_ref = COALESCE(p_company_updates->>'billing_customer_ref', billing_customer_ref),
      stripe_subscription_id = COALESCE(v_incoming_sub_id, stripe_subscription_id),
      billing_subscription_ref = COALESCE(p_company_updates->>'billing_subscription_ref', billing_subscription_ref),
      billing_status = COALESCE(v_incoming_billing_status, billing_status),
      stripe_price_id = COALESCE(p_company_updates->>'stripe_price_id', stripe_price_id),
      plan_name = COALESCE(p_company_updates->>'plan_name', plan_name),
      seat_limit = COALESCE(v_seat_limit, seat_limit),
      billing_period_start = COALESCE(v_period_start, billing_period_start),
      current_period_end = COALESCE(v_period_end, current_period_end),
      trial_ends_at = COALESCE(v_trial_ends_at, trial_ends_at),
      status = COALESCE(v_incoming_status, status),
      updated_at = v_now
    WHERE id = p_company_id;

    -- Insert into platform_usage_events (if provided)
    IF p_usage_event IS NOT NULL AND jsonb_typeof(p_usage_event) = 'object' THEN
      INSERT INTO public.platform_usage_events (
        company_id, event_type, units, metric_type, quantity, quantity_unit, source_event_key, metadata
      ) VALUES (
        p_company_id,
        COALESCE(p_usage_event->>'event_type', 'stripe_' || v_row.event_type),
        COALESCE((p_usage_event->>'units')::integer, 1),
        COALESCE(p_usage_event->>'metric_type', 'billing_event'),
        COALESCE((p_usage_event->>'quantity')::integer, 1),
        COALESCE(p_usage_event->>'quantity_unit', 'webhook_event'),
        p_event_id,
        COALESCE(p_usage_event->'metadata', '{}'::jsonb)
      );
    END IF;
  END IF;

  -- 4. Mark event processed and clear claim
  UPDATE public.pooldocai_stripe_webhook_events
  SET processed = true,
      processed_at = v_now,
      claimed_at = NULL,
      claim_token = NULL,
      processing_error = p_processing_note
  WHERE stripe_event_id = p_event_id;

  RETURN jsonb_build_object(
    'success', true,
    'status', 'applied',
    'processed', true,
    'lease_generation', v_row.lease_generation
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_apply_and_finalize_stripe_webhook(text, text, uuid, jsonb, jsonb, text, boolean, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_apply_and_finalize_stripe_webhook(text, text, uuid, jsonb, jsonb, text, boolean, jsonb) TO service_role;

COMMIT;

-- ----------------------------------------------------------------------------
-- Migration 37/47: 20261023130000_stripe_webhook_strict_provenance_and_same_period_ordering.sql
-- ----------------------------------------------------------------------------

-- Migration 037: Strict invoice subscription provenance enforcement and authoritative same-period event ordering.
-- Forward-only and additive.
BEGIN;

-- 1. Add last_billing_event_created to public.companies to track monotonic Stripe business event freshness
ALTER TABLE public.companies
  ADD COLUMN IF NOT EXISTS last_billing_event_created timestamptz;

COMMENT ON COLUMN public.companies.last_billing_event_created IS
  'Timestamp of the latest authoritative Stripe business event (from event.created) applied to this company tenant.';

-- 2. Update pooldocai_apply_and_finalize_stripe_webhook with strict invoice provenance & same-period ordering
CREATE OR REPLACE FUNCTION public.pooldocai_apply_and_finalize_stripe_webhook(
  p_event_id text,
  p_claim_token text,
  p_company_id uuid DEFAULT NULL,
  p_company_updates jsonb DEFAULT NULL,
  p_usage_event jsonb DEFAULT NULL,
  p_processing_note text DEFAULT NULL,
  p_ignored boolean DEFAULT false,
  p_event_provenance jsonb DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE
  v_row public.pooldocai_stripe_webhook_events%ROWTYPE;
  v_company public.companies%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_seat_limit integer;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_trial_ends_at timestamptz;
  v_incoming_sub_id text;
  v_incoming_status text;
  v_incoming_billing_status text;
  v_prov_sub_id text;
  v_prov_period_start timestamptz;
  v_prov_period_end timestamptz;
  v_prov_event_type text;
  v_prov_event_created timestamptz;
  v_is_stale_period boolean := false;
  v_is_old_subscription boolean := false;
  v_is_stale_event_time boolean := false;
  v_stale_reason text := NULL;
BEGIN
  -- Set transaction-local claim role to service_role so downstream triggers recognize trusted billing context
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- Strict validation of claim token: empty/unknown tokens are rejected
  IF p_claim_token IS NULL OR trim(p_claim_token) = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'invalid_claim_token',
      'error', 'A non-empty claim ownership token is required to finalize webhook events'
    );
  END IF;

  -- 1. Exclusively lock the webhook event row
  SELECT * INTO v_row
  FROM public.pooldocai_stripe_webhook_events
  WHERE stripe_event_id = p_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'not_found',
      'error', 'Webhook event row not found'
    );
  END IF;

  -- Fencing check 1: Event already finalized
  IF v_row.processed THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'already_processed',
      'fenced', true,
      'error', 'Webhook event was already finalized by another worker'
    );
  END IF;

  -- Fencing check 2: Worker claim token must match active lease exactly
  IF v_row.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'fenced_out',
      'fenced', true,
      'error', 'Stale claim token: lease expired or ownership claimed by a newer worker'
    );
  END IF;

  -- 2. Explicit early ignore finalization
  IF p_ignored THEN
    UPDATE public.pooldocai_stripe_webhook_events
    SET processed = true,
        processed_at = v_now,
        claimed_at = NULL,
        claim_token = NULL,
        processing_error = p_processing_note
    WHERE stripe_event_id = p_event_id;

    RETURN jsonb_build_object(
      'success', true,
      'status', 'ignored',
      'processed', true,
      'lease_generation', v_row.lease_generation
    );
  END IF;

  -- 3. Company billing update branch
  IF p_company_id IS NOT NULL AND p_company_updates IS NOT NULL AND jsonb_typeof(p_company_updates) = 'object' THEN
    -- Exclusively lock the company row to serialize all events targeting this tenant
    SELECT * INTO v_company
    FROM public.companies
    WHERE id = p_company_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'success', false,
        'status', 'company_not_found',
        'error', 'Target company not found for billing update'
      );
    END IF;

    -- Extract update fields
    IF (p_company_updates->>'seat_limit') IS NOT NULL THEN
      v_seat_limit := (p_company_updates->>'seat_limit')::integer;
    END IF;
    IF (p_company_updates->>'billing_period_start') IS NOT NULL THEN
      v_period_start := (p_company_updates->>'billing_period_start')::timestamptz;
    END IF;
    IF (p_company_updates->>'current_period_end') IS NOT NULL THEN
      v_period_end := (p_company_updates->>'current_period_end')::timestamptz;
    END IF;
    IF (p_company_updates->>'trial_ends_at') IS NOT NULL THEN
      v_trial_ends_at := (p_company_updates->>'trial_ends_at')::timestamptz;
    END IF;

    v_incoming_sub_id := p_company_updates->>'stripe_subscription_id';
    v_incoming_status := p_company_updates->>'status';
    v_incoming_billing_status := p_company_updates->>'billing_status';

    -- Extract event provenance (passed explicitly or inferred from event/updates)
    v_prov_event_type := COALESCE(p_event_provenance->>'event_type', v_row.event_type);
    v_prov_sub_id := COALESCE(p_event_provenance->>'subscription_id', v_incoming_sub_id);
    v_prov_period_start := COALESCE((p_event_provenance->>'period_start')::timestamptz, v_period_start);
    v_prov_period_end := COALESCE((p_event_provenance->>'period_end')::timestamptz, v_period_end);

    -- Extract event creation timestamp (Stripe event.created)
    IF (p_event_provenance->>'event_created') IS NOT NULL THEN
      IF (p_event_provenance->>'event_created') ~ '^\d+(\.\d+)?$' THEN
        v_prov_event_created := to_timestamp((p_event_provenance->>'event_created')::double precision);
      ELSE
        v_prov_event_created := (p_event_provenance->>'event_created')::timestamptz;
      END IF;
    END IF;

    -- Fail-closed provenance check 1: Invoices mutating billing status on a tenant with an active stripe_subscription_id
    -- MUST provide matching subscription identity. An invoice without subscription_id cannot safely bind to an active subscription tenant.
    IF v_prov_event_type LIKE 'invoice.%'
       AND v_incoming_billing_status IS NOT NULL
       AND v_company.stripe_subscription_id IS NOT NULL THEN

      -- Missing subscription ID fails closed (whether period is present or absent)
      IF v_prov_sub_id IS NULL THEN
        RETURN jsonb_build_object(
          'success', false,
          'status', 'missing_invoice_provenance',
          'error', 'Invoice event lacks subscription provenance required to verify tenant subscription binding'
        );
      END IF;

      -- If period_start is missing on matching subscription, timing MUST be verifiable via event_created
      IF v_prov_sub_id = v_company.stripe_subscription_id AND v_prov_period_start IS NULL THEN
        IF v_prov_event_created IS NULL AND v_company.billing_period_start IS NOT NULL THEN
          RETURN jsonb_build_object(
            'success', false,
            'status', 'missing_invoice_provenance',
            'error', 'Invoice event lacks period and event timestamp provenance required to verify freshness'
          );
        END IF;
      END IF;
    END IF;

    -- Database-side conditional ordering guard A: Stale billing period
    IF v_prov_period_start IS NOT NULL AND v_company.billing_period_start IS NOT NULL AND v_prov_period_start < v_company.billing_period_start THEN
      v_is_stale_period := true;
      v_stale_reason := CASE 
        WHEN v_prov_event_type LIKE 'invoice.%' THEN 'stale_out_of_order_invoice'
        ELSE 'stale_out_of_order_event'
      END;
    END IF;

    -- Database-side conditional ordering guard B: Superseded subscription
    IF v_company.stripe_subscription_id IS NOT NULL AND v_prov_sub_id IS NOT NULL AND v_prov_sub_id <> v_company.stripe_subscription_id THEN
      -- Invoices, cancellations, and older/equal periods from non-matching subscriptions are strictly superseded
      IF (
        v_prov_event_type LIKE 'invoice.%'
        OR v_prov_event_type = 'customer.subscription.deleted'
        OR v_incoming_status = 'cancelled'
        OR v_incoming_billing_status = 'cancelled'
        OR v_prov_period_start IS NULL
        OR v_company.billing_period_start IS NULL
        OR v_prov_period_start <= v_company.billing_period_start
      ) THEN
        v_is_old_subscription := true;
        v_stale_reason := CASE 
          WHEN v_prov_event_type LIKE 'invoice.%' THEN 'stale_old_subscription_invoice'
          ELSE 'stale_old_subscription'
        END;
      END IF;
    END IF;

    -- Database-side conditional ordering guard C: Same-subscription event freshness within billing period
    IF NOT v_is_stale_period AND NOT v_is_old_subscription THEN
      IF v_prov_event_created IS NOT NULL AND v_company.last_billing_event_created IS NOT NULL THEN
        -- Strictly older Stripe event creation timestamp
        IF v_prov_event_created < v_company.last_billing_event_created THEN
          v_is_stale_event_time := true;
          v_stale_reason := CASE
            WHEN v_prov_event_type LIKE 'invoice.%' THEN 'stale_out_of_order_invoice'
            ELSE 'stale_out_of_order_event'
          END;
        -- Equal timestamp tie-breaker: prevent payment_failed from downgrading an active status
        ELSIF v_prov_event_created = v_company.last_billing_event_created
              AND v_incoming_billing_status = 'past_due'
              AND v_company.billing_status = 'active' THEN
          v_is_stale_event_time := true;
          v_stale_reason := 'stale_out_of_order_invoice';
        END IF;
      END IF;
    END IF;

    -- If event is stale under locked company state, finalize it as ignored without tenant mutation
    IF v_is_stale_period OR v_is_old_subscription OR v_is_stale_event_time THEN
      UPDATE public.pooldocai_stripe_webhook_events
      SET processed = true,
          processed_at = v_now,
          claimed_at = NULL,
          claim_token = NULL,
          processing_error = CASE 
            WHEN v_stale_reason = 'stale_old_subscription_invoice' THEN 'Stale invoice from superseded subscription skipped (newer subscription active in database).'
            WHEN v_stale_reason = 'stale_out_of_order_invoice' THEN 'Stale out-of-order invoice skipped (newer billing period or event already active in database).'
            WHEN v_stale_reason = 'stale_old_subscription' THEN 'Stale event from superseded subscription skipped (newer subscription active in database).'
            ELSE 'Stale out-of-order event skipped (newer period or event already active in database).'
          END
      WHERE stripe_event_id = p_event_id;

      RETURN jsonb_build_object(
        'success', true,
        'status', 'ignored',
        'reason', v_stale_reason,
        'processed', true,
        'lease_generation', v_row.lease_generation
      );
    END IF;

    -- Conditional checks passed: apply updates to locked company row
    UPDATE public.companies
    SET
      stripe_customer_id = COALESCE(p_company_updates->>'stripe_customer_id', stripe_customer_id),
      billing_customer_ref = COALESCE(p_company_updates->>'billing_customer_ref', billing_customer_ref),
      stripe_subscription_id = COALESCE(v_incoming_sub_id, stripe_subscription_id),
      billing_subscription_ref = COALESCE(p_company_updates->>'billing_subscription_ref', billing_subscription_ref),
      billing_status = COALESCE(v_incoming_billing_status, billing_status),
      stripe_price_id = COALESCE(p_company_updates->>'stripe_price_id', stripe_price_id),
      plan_name = COALESCE(p_company_updates->>'plan_name', plan_name),
      seat_limit = COALESCE(v_seat_limit, seat_limit),
      billing_period_start = COALESCE(v_period_start, billing_period_start),
      current_period_end = COALESCE(v_period_end, current_period_end),
      trial_ends_at = COALESCE(v_trial_ends_at, trial_ends_at),
      status = COALESCE(v_incoming_status, status),
      last_billing_event_created = COALESCE(v_prov_event_created, last_billing_event_created),
      updated_at = v_now
    WHERE id = p_company_id;

    -- Insert into platform_usage_events (if provided)
    IF p_usage_event IS NOT NULL AND jsonb_typeof(p_usage_event) = 'object' THEN
      INSERT INTO public.platform_usage_events (
        company_id, event_type, units, metric_type, quantity, quantity_unit, source_event_key, metadata
      ) VALUES (
        p_company_id,
        COALESCE(p_usage_event->>'event_type', 'stripe_' || v_row.event_type),
        COALESCE((p_usage_event->>'units')::integer, 1),
        COALESCE(p_usage_event->>'metric_type', 'billing_event'),
        COALESCE((p_usage_event->>'quantity')::integer, 1),
        COALESCE(p_usage_event->>'quantity_unit', 'webhook_event'),
        p_event_id,
        COALESCE(p_usage_event->'metadata', '{}'::jsonb)
      );
    END IF;
  END IF;

  -- 4. Mark event processed and clear claim
  UPDATE public.pooldocai_stripe_webhook_events
  SET processed = true,
      processed_at = v_now,
      claimed_at = NULL,
      claim_token = NULL,
      processing_error = p_processing_note
  WHERE stripe_event_id = p_event_id;

  RETURN jsonb_build_object(
    'success', true,
    'status', 'applied',
    'processed', true,
    'lease_generation', v_row.lease_generation
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_apply_and_finalize_stripe_webhook(text, text, uuid, jsonb, jsonb, text, boolean, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_apply_and_finalize_stripe_webhook(text, text, uuid, jsonb, jsonb, text, boolean, jsonb) TO service_role;

COMMIT;

-- ----------------------------------------------------------------------------
-- Migration 38/47: 20261024100000_learning_approval_verified_repairs_and_contributor_terms.sql
-- ----------------------------------------------------------------------------

-- Migration 038: Enforce verified repairs and contributor terms in learning approval RPC
-- Forward-only and additive.
-- Enforces that:
-- 1) Cases derived from technician jobs or authenticated troubleshooter chats must have technician_verified = true and non-empty resolution_summary_redacted
-- 2) Tenant cases must have verified terms acceptance (learning_terms_version IS NOT NULL) in addition to case_learning_opt_in = true
BEGIN;

CREATE OR REPLACE FUNCTION public.pooldocai_approve_learning_case(
  p_queue_id uuid,
  p_lesson text,
  p_reviewed_by uuid,
  p_review_note text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_queue public.learning_review_queue%ROWTYPE;
  v_case public.diagnostic_cases%ROWTYPE;
  v_company_opted_in boolean := false;
  v_manual_opted_in boolean := false;
  v_manual_id uuid;
  v_has_case_consent boolean := false;
BEGIN
  -- Lock review queue row
  SELECT * INTO v_queue
  FROM public.learning_review_queue
  WHERE id = p_queue_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Review queue item % not found', p_queue_id;
  END IF;

  IF v_queue.status <> 'pending' THEN
    RAISE EXCEPTION 'Review item % is not pending (status: %)', p_queue_id, v_queue.status;
  END IF;

  -- Verify document consent if manual
  IF v_queue.source_kind = 'company_manual' THEN
    -- Extract manual id from supporting sources
    SELECT (array_agg(elem))[1]::uuid INTO v_manual_id
    FROM unnest(v_queue.supporting_source_ids) AS elem
    WHERE elem NOT LIKE '%#chunk-%';

    IF v_manual_id IS NOT NULL THEN
      SELECT shared_learning_opt_in INTO v_manual_opted_in
      FROM public.company_manuals
      WHERE id = v_manual_id AND company_id = v_queue.tenant_id;
    END IF;

    IF NOT COALESCE(v_manual_opted_in, false) THEN
      RAISE EXCEPTION 'Source company manual opt-in consent is missing or revoked';
    END IF;
  ELSIF v_queue.case_id IS NOT NULL THEN
    -- Lock diagnostic case row
    SELECT * INTO v_case
    FROM public.diagnostic_cases
    WHERE id = v_queue.case_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Diagnostic case % not found', v_queue.case_id;
    END IF;

    -- Consent and verified contributor terms check:
    -- 1) Authenticated company case: requires explicit case_learning_opt_in, verified contributor terms version, AND governing company opt-in
    -- 2) Public-demo case (tenant_id IS NULL): requires case_learning_opt_in OR (learning_permission_granted AND legal_terms_version IS NOT NULL)
    IF v_case.tenant_id IS NOT NULL THEN
      IF NOT COALESCE(v_case.case_learning_opt_in, false) THEN
        RAISE EXCEPTION 'Case-level learning consent was not granted or was withdrawn';
      END IF;

      IF v_case.learning_terms_version IS NULL AND v_case.legal_terms_version IS NULL THEN
        RAISE EXCEPTION 'Verified contributor terms acceptance is required for case learning approval';
      END IF;

      -- Recheck governing company consent
      SELECT diagnostic_learning_opt_in INTO v_company_opted_in
      FROM public.companies
      WHERE id = v_case.tenant_id;

      IF NOT COALESCE(v_company_opted_in, false) THEN
        RAISE EXCEPTION 'Governing company diagnostic learning opt-in is required';
      END IF;
    ELSE
      -- Public-demo case consent check: do not grant consent to unconsented cases
      v_has_case_consent := COALESCE(v_case.case_learning_opt_in, false) OR (
        COALESCE(v_case.learning_permission_granted, false) AND (v_case.legal_terms_version IS NOT NULL OR v_case.learning_terms_version IS NOT NULL)
      );

      IF NOT v_has_case_consent THEN
        RAISE EXCEPTION 'Public demo case-level learning consent was not granted or was withdrawn';
      END IF;
    END IF;

    -- Enforce verified repair requirement:
    -- Unverified chatbot turns or unverified field notes cannot be published as confirmed fixes
    IF v_queue.source_kind IN ('technician_job', 'authenticated_troubleshooter') THEN
      IF NOT COALESCE(v_case.technician_verified, false) OR COALESCE(trim(v_case.resolution_summary_redacted), '') = '' THEN
        RAISE EXCEPTION 'Only a resolved technician-verified case with a recorded outcome can become shared repair knowledge';
      END IF;
    END IF;
  END IF;

  -- Upsert into shared_learning_knowledge atomically
  INSERT INTO public.shared_learning_knowledge (
    source_case_id,
    source_queue_id,
    source_company_id,
    source_kind,
    equipment_category,
    manufacturer_normalized,
    model_normalized,
    lesson_redacted,
    approved_by,
    consent_snapshot,
    review_history
  ) VALUES (
    v_queue.case_id,
    v_queue.id,
    v_queue.tenant_id,
    v_queue.source_kind,
    v_case.equipment_category,
    v_case.manufacturer_normalized,
    v_case.model_normalized,
    p_lesson,
    p_reviewed_by,
    true,
    jsonb_build_array(jsonb_build_object(
      'action', 'approved',
      'actor', p_reviewed_by,
      'at', now(),
      'note', p_review_note
    ))
  )
  ON CONFLICT (source_queue_id) DO UPDATE SET
    lesson_redacted = EXCLUDED.lesson_redacted,
    approved_by = EXCLUDED.approved_by,
    consent_snapshot = true,
    review_history = public.shared_learning_knowledge.review_history || EXCLUDED.review_history;

  -- Mark case approved
  IF v_queue.case_id IS NOT NULL THEN
    UPDATE public.diagnostic_cases
    SET approved_for_learning = true, privacy_reviewed_at = now()
    WHERE id = v_queue.case_id;
  END IF;

  -- Mark queue item approved
  UPDATE public.learning_review_queue
  SET status = 'approved', reviewed_by = p_reviewed_by, reviewed_at = now()
  WHERE id = p_queue_id;

  -- Log audit
  INSERT INTO public.learning_review_audit (
    queue_id,
    case_id,
    actor_user_id,
    action,
    note_redacted
  ) VALUES (
    p_queue_id,
    v_queue.case_id,
    p_reviewed_by,
    'approved',
    p_review_note
  );

  RETURN jsonb_build_object('ok', true, 'status', 'approved', 'queue_id', p_queue_id);
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_approve_learning_case(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_approve_learning_case(uuid, text, uuid, text) TO service_role;

COMMIT;

-- ----------------------------------------------------------------------------
-- Migration 39/47: 20261024110000_learning_approval_strict_metadata_and_public_demo_quarantine.sql
-- ----------------------------------------------------------------------------

-- Migration 039: Strict metadata preservation for company manuals and public demo quarantine in learning approval
-- Forward-only and additive.
-- Enforces:
-- 1) Public demo visitor-reported cases cannot be published as verified shared repair knowledge (P0-3).
-- 2) Company manual approvals load validated tenant-matching company_manuals provenance into v_manual and populate equipment_category, manufacturer_normalized, and model_normalized directly into shared_learning_knowledge (P0-4).
-- 3) Strict cross-tenant manual opt-in check fails closed.
-- 4) Re-checks governing company diagnostic learning opt-in.
BEGIN;

ALTER TABLE public.company_manuals ADD COLUMN IF NOT EXISTS model_normalized text;

CREATE OR REPLACE FUNCTION public.pooldocai_approve_learning_case(
  p_queue_id uuid,
  p_lesson text,
  p_reviewed_by uuid,
  p_review_note text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_queue public.learning_review_queue%ROWTYPE;
  v_case public.diagnostic_cases%ROWTYPE;
  v_manual public.company_manuals%ROWTYPE;
  v_company_opted_in boolean := false;
  v_manual_id uuid;
  v_has_case_consent boolean := false;
  v_equipment_category text;
  v_manufacturer_normalized text;
  v_model_normalized text;
BEGIN
  -- Lock review queue row
  SELECT * INTO v_queue
  FROM public.learning_review_queue
  WHERE id = p_queue_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Review queue item % not found', p_queue_id;
  END IF;

  IF v_queue.status <> 'pending' THEN
    RAISE EXCEPTION 'Review item % is not pending (status: %)', p_queue_id, v_queue.status;
  END IF;

  -- P0-3: Public demo visitor-reported answers are unverified customer feedback signals
  -- and cannot be published as verified shared repair knowledge.
  IF v_queue.source_kind = 'public_demo' THEN
    RAISE EXCEPTION 'Public demo visitor-reported answers cannot be published as verified shared repair knowledge';
  END IF;

  -- P0-4: Verify document consent, provenance, and load metadata if manual
  IF v_queue.source_kind = 'company_manual' THEN
    -- Extract manual id from supporting sources
    SELECT (array_agg(elem))[1]::uuid INTO v_manual_id
    FROM unnest(v_queue.supporting_source_ids) AS elem
    WHERE elem NOT LIKE '%#chunk-%';

    IF v_manual_id IS NOT NULL THEN
      SELECT * INTO v_manual
      FROM public.company_manuals
      WHERE id = v_manual_id AND company_id = v_queue.tenant_id
      FOR UPDATE;
    END IF;

    IF v_manual.id IS NULL THEN
      RAISE EXCEPTION 'Source company manual % not found or does not belong to tenant %', v_manual_id, v_queue.tenant_id;
    END IF;

    IF NOT COALESCE(v_manual.shared_learning_opt_in, false) THEN
      RAISE EXCEPTION 'Source company manual opt-in consent is missing or revoked';
    END IF;

    -- Recheck governing company diagnostic learning opt-in
    SELECT diagnostic_learning_opt_in INTO v_company_opted_in
    FROM public.companies
    WHERE id = v_queue.tenant_id;

    IF NOT COALESCE(v_company_opted_in, false) THEN
      RAISE EXCEPTION 'Governing company diagnostic learning opt-in is required';
    END IF;

    v_equipment_category := COALESCE(v_manual.equipment_category, 'manual');
    v_manufacturer_normalized := v_manual.manufacturer_normalized;
    v_model_normalized := v_manual.model_normalized;

  ELSIF v_queue.case_id IS NOT NULL THEN
    -- Lock diagnostic case row
    SELECT * INTO v_case
    FROM public.diagnostic_cases
    WHERE id = v_queue.case_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Diagnostic case % not found', v_queue.case_id;
    END IF;

    -- Consent and verified contributor terms check:
    -- Authenticated company case requires explicit case_learning_opt_in, verified contributor terms version, AND governing company opt-in
    IF v_case.tenant_id IS NOT NULL THEN
      IF NOT COALESCE(v_case.case_learning_opt_in, false) THEN
        RAISE EXCEPTION 'Case-level learning consent was not granted or was withdrawn';
      END IF;

      IF v_case.learning_terms_version IS NULL AND v_case.legal_terms_version IS NULL THEN
        RAISE EXCEPTION 'Verified contributor terms acceptance is required for case learning approval';
      END IF;

      -- Recheck governing company consent
      SELECT diagnostic_learning_opt_in INTO v_company_opted_in
      FROM public.companies
      WHERE id = v_case.tenant_id;

      IF NOT COALESCE(v_company_opted_in, false) THEN
        RAISE EXCEPTION 'Governing company diagnostic learning opt-in is required';
      END IF;
    ELSE
      -- Public demo cases are already rejected above (P0-3), but defense-in-depth check:
      RAISE EXCEPTION 'Public demo visitor-reported answers cannot be published as verified shared repair knowledge';
    END IF;

    -- Enforce verified repair requirement:
    -- Unverified chatbot turns or unverified field notes cannot be published as confirmed fixes
    IF v_queue.source_kind IN ('technician_job', 'authenticated_troubleshooter') THEN
      IF NOT COALESCE(v_case.technician_verified, false) OR COALESCE(trim(v_case.resolution_summary_redacted), '') = '' THEN
        RAISE EXCEPTION 'Only a resolved technician-verified case with a recorded outcome can become shared repair knowledge';
      END IF;
    END IF;

    v_equipment_category := v_case.equipment_category;
    v_manufacturer_normalized := v_case.manufacturer_normalized;
    v_model_normalized := v_case.model_normalized;
  END IF;

  -- Upsert into shared_learning_knowledge atomically with exact metadata provenance
  INSERT INTO public.shared_learning_knowledge (
    source_case_id,
    source_queue_id,
    source_company_id,
    source_kind,
    equipment_category,
    manufacturer_normalized,
    model_normalized,
    lesson_redacted,
    approved_by,
    consent_snapshot,
    review_history
  ) VALUES (
    v_queue.case_id,
    v_queue.id,
    v_queue.tenant_id,
    v_queue.source_kind,
    v_equipment_category,
    v_manufacturer_normalized,
    v_model_normalized,
    p_lesson,
    p_reviewed_by,
    true,
    jsonb_build_array(jsonb_build_object(
      'action', 'approved',
      'actor', p_reviewed_by,
      'at', now(),
      'note', p_review_note
    ))
  )
  ON CONFLICT (source_queue_id) DO UPDATE SET
    lesson_redacted = EXCLUDED.lesson_redacted,
    equipment_category = EXCLUDED.equipment_category,
    manufacturer_normalized = EXCLUDED.manufacturer_normalized,
    model_normalized = EXCLUDED.model_normalized,
    approved_by = EXCLUDED.approved_by,
    consent_snapshot = true,
    review_history = public.shared_learning_knowledge.review_history || EXCLUDED.review_history;

  -- Mark case approved if present
  IF v_queue.case_id IS NOT NULL THEN
    UPDATE public.diagnostic_cases
    SET approved_for_learning = true, privacy_reviewed_at = now()
    WHERE id = v_queue.case_id;
  END IF;

  -- Mark queue item approved
  UPDATE public.learning_review_queue
  SET status = 'approved', reviewed_by = p_reviewed_by, reviewed_at = now()
  WHERE id = p_queue_id;

  RETURN jsonb_build_object(
    'ok', true,
    'queue_id', p_queue_id,
    'case_id', v_queue.case_id,
    'source_kind', v_queue.source_kind,
    'equipment_category', v_equipment_category,
    'manufacturer_normalized', v_manufacturer_normalized,
    'model_normalized', v_model_normalized,
    'status', 'approved'
  );
END;
$$;

COMMIT;

-- ----------------------------------------------------------------------------
-- Migration 40/47: 20261024120000_company_manual_search_rpc_metadata_contract.sql
-- ----------------------------------------------------------------------------

-- Migration 040: Fix company manual search RPCs return schema contract
-- Updates search_company_manual_chunks and search_company_manual_chunks_hybrid
-- to project manufacturer_normalized, model_normalized, equipment_category,
-- reference_enabled, and extraction_status from company_manuals.

DROP FUNCTION IF EXISTS public.search_company_manual_chunks(uuid, text, integer);

CREATE OR REPLACE FUNCTION public.search_company_manual_chunks(
  p_company_id uuid,
  p_query text,
  p_limit integer default 6
)
RETURNS TABLE(
  id uuid,
  manual_id uuid,
  title text,
  source_url text,
  page_number integer,
  page_start integer,
  page_end integer,
  content_text text,
  rank real,
  retrieval_method text,
  industry_key text,
  manufacturer_normalized text,
  model_normalized text,
  equipment_category text,
  reference_enabled boolean,
  extraction_status text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT
    c.id,
    c.manual_id,
    c.title,
    c.source_url,
    c.page_number,
    c.page_start,
    c.page_end,
    c.content_text,
    ts_rank(c.search_vector, websearch_to_tsquery('english', coalesce(left(p_query,1800),'')))::real AS rank,
    'keyword'::text AS retrieval_method,
    c.industry_key,
    m.manufacturer_normalized,
    m.model_normalized,
    m.equipment_category,
    m.reference_enabled,
    m.extraction_status
  FROM public.company_manual_chunks c
  JOIN public.company_manuals m ON m.id = c.manual_id AND m.company_id = c.company_id
  JOIN public.companies co ON co.id = c.company_id AND co.industry_key = c.industry_key
  JOIN public.industry_modules im ON im.industry_key = co.industry_key AND im.status = 'active'
  WHERE c.company_id = p_company_id
    AND m.reference_enabled = true
    AND m.extraction_status = 'ready'
    AND (
      c.search_vector @@ websearch_to_tsquery('english', coalesce(left(p_query,1800),''))
      OR EXISTS (
        SELECT 1 FROM regexp_split_to_table(lower(coalesce(p_query,'')), '\s+') AS q(word)
        WHERE length(q.word) > 2 AND c.content_text ILIKE '%' || left(q.word,60) || '%'
      )
    )
  ORDER BY rank DESC, c.chunk_index ASC
  LIMIT least(greatest(coalesce(p_limit,6),1),10)
$$;

REVOKE ALL ON FUNCTION public.search_company_manual_chunks(uuid, text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_company_manual_chunks(uuid, text, integer) TO service_role;

DROP FUNCTION IF EXISTS public.search_company_manual_chunks_hybrid(uuid, text, extensions.vector, integer);

CREATE OR REPLACE FUNCTION public.search_company_manual_chunks_hybrid(
  p_company_id uuid,
  p_query text,
  p_embedding extensions.vector(768) default null,
  p_limit integer default 6
)
RETURNS TABLE(
  id uuid,
  manual_id uuid,
  title text,
  source_url text,
  page_number integer,
  page_start integer,
  page_end integer,
  content_text text,
  rank real,
  retrieval_method text,
  industry_key text,
  manufacturer_normalized text,
  model_normalized text,
  equipment_category text,
  reference_enabled boolean,
  extraction_status text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
  WITH candidates AS (
    SELECT
      c.id,
      c.manual_id,
      c.title,
      c.source_url,
      c.page_number,
      c.page_start,
      c.page_end,
      c.content_text,
      c.industry_key,
      m.manufacturer_normalized,
      m.model_normalized,
      m.equipment_category,
      m.reference_enabled,
      m.extraction_status,
      ts_rank(c.search_vector, websearch_to_tsquery('english', coalesce(left(p_query,1800),'')))::real AS lexical_score,
      CASE
        WHEN p_embedding IS NOT NULL AND c.embedding IS NOT NULL THEN (1 - (c.embedding <=> p_embedding))::real
        ELSE 0::real
      END AS semantic_score,
      (
        c.search_vector @@ websearch_to_tsquery('english', coalesce(left(p_query,1800),''))
        OR EXISTS (
          SELECT 1 FROM regexp_split_to_table(lower(coalesce(p_query,'')), '\s+') AS q(word)
          WHERE length(q.word) > 2 AND c.content_text ILIKE '%' || left(q.word,60) || '%'
        )
      ) AS lexical_match
    FROM public.company_manual_chunks c
    JOIN public.company_manuals m ON m.id = c.manual_id AND m.company_id = c.company_id
    JOIN public.companies co ON co.id = c.company_id AND co.industry_key = c.industry_key
    JOIN public.industry_modules im ON im.industry_key = co.industry_key AND im.status = 'active'
    WHERE c.company_id = p_company_id
      AND m.reference_enabled = true
      AND m.extraction_status = 'ready'
  ), ranked AS (
    SELECT
      *,
      greatest(lexical_score, semantic_score * 0.85)::real AS combined_score,
      CASE
        WHEN lexical_match AND semantic_score > 0 THEN 'hybrid'
        WHEN lexical_match THEN 'keyword'
        ELSE 'semantic'
      END AS method
    FROM candidates
    WHERE lexical_match OR (p_embedding IS NOT NULL AND semantic_score > 0.25)
  )
  SELECT
    r.id,
    r.manual_id,
    r.title,
    r.source_url,
    r.page_number,
    r.page_start,
    r.page_end,
    r.content_text,
    r.combined_score,
    r.method,
    r.industry_key,
    r.manufacturer_normalized,
    r.model_normalized,
    r.equipment_category,
    r.reference_enabled,
    r.extraction_status
  FROM ranked r
  ORDER BY r.combined_score DESC, r.page_number NULLS LAST
  LIMIT least(greatest(coalesce(p_limit,6),1),12)
$$;

REVOKE ALL ON FUNCTION public.search_company_manual_chunks_hybrid(uuid, text, extensions.vector, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_company_manual_chunks_hybrid(uuid, text, extensions.vector, integer) TO service_role;

-- ----------------------------------------------------------------------------
-- Migration 41/47: 20261024130000_company_manual_search_active_tenant_gate.sql
-- ----------------------------------------------------------------------------

-- Migration 041: Enforce active company status on company manual search RPCs
-- Ensures search_company_manual_chunks and search_company_manual_chunks_hybrid
-- strictly filter on co.status = 'active' so suspended/inactive tenants cannot be searched.

DROP FUNCTION IF EXISTS public.search_company_manual_chunks(uuid, text, integer);

CREATE OR REPLACE FUNCTION public.search_company_manual_chunks(
  p_company_id uuid,
  p_query text,
  p_limit integer default 6
)
RETURNS TABLE(
  id uuid,
  manual_id uuid,
  title text,
  source_url text,
  page_number integer,
  page_start integer,
  page_end integer,
  content_text text,
  rank real,
  retrieval_method text,
  industry_key text,
  manufacturer_normalized text,
  model_normalized text,
  equipment_category text,
  reference_enabled boolean,
  extraction_status text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT
    c.id,
    c.manual_id,
    c.title,
    c.source_url,
    c.page_number,
    c.page_start,
    c.page_end,
    c.content_text,
    ts_rank(c.search_vector, websearch_to_tsquery('english', coalesce(left(p_query,1800),'')))::real AS rank,
    'keyword'::text AS retrieval_method,
    c.industry_key,
    m.manufacturer_normalized,
    m.model_normalized,
    m.equipment_category,
    m.reference_enabled,
    m.extraction_status
  FROM public.company_manual_chunks c
  JOIN public.company_manuals m ON m.id = c.manual_id AND m.company_id = c.company_id
  JOIN public.companies co ON co.id = c.company_id AND co.industry_key = c.industry_key
  JOIN public.industry_modules im ON im.industry_key = co.industry_key AND im.status = 'active'
  WHERE c.company_id = p_company_id
    AND co.status = 'active'
    AND m.reference_enabled = true
    AND m.extraction_status = 'ready'
    AND (
      c.search_vector @@ websearch_to_tsquery('english', coalesce(left(p_query,1800),''))
      OR EXISTS (
        SELECT 1 FROM regexp_split_to_table(lower(coalesce(p_query,'')), '\s+') AS q(word)
        WHERE length(q.word) > 2 AND c.content_text ILIKE '%' || left(q.word,60) || '%'
      )
    )
  ORDER BY rank DESC, c.chunk_index ASC
  LIMIT least(greatest(coalesce(p_limit,6),1),10)
$$;

REVOKE ALL ON FUNCTION public.search_company_manual_chunks(uuid, text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_company_manual_chunks(uuid, text, integer) TO service_role;

DROP FUNCTION IF EXISTS public.search_company_manual_chunks_hybrid(uuid, text, extensions.vector, integer);

CREATE OR REPLACE FUNCTION public.search_company_manual_chunks_hybrid(
  p_company_id uuid,
  p_query text,
  p_embedding extensions.vector(768) default null,
  p_limit integer default 6
)
RETURNS TABLE(
  id uuid,
  manual_id uuid,
  title text,
  source_url text,
  page_number integer,
  page_start integer,
  page_end integer,
  content_text text,
  rank real,
  retrieval_method text,
  industry_key text,
  manufacturer_normalized text,
  model_normalized text,
  equipment_category text,
  reference_enabled boolean,
  extraction_status text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
  WITH candidates AS (
    SELECT
      c.id,
      c.manual_id,
      c.title,
      c.source_url,
      c.page_number,
      c.page_start,
      c.page_end,
      c.content_text,
      c.industry_key,
      m.manufacturer_normalized,
      m.model_normalized,
      m.equipment_category,
      m.reference_enabled,
      m.extraction_status,
      ts_rank(c.search_vector, websearch_to_tsquery('english', coalesce(left(p_query,1800),'')))::real AS lexical_score,
      CASE
        WHEN p_embedding IS NOT NULL AND c.embedding IS NOT NULL THEN (1 - (c.embedding <=> p_embedding))::real
        ELSE 0::real
      END AS semantic_score,
      (
        c.search_vector @@ websearch_to_tsquery('english', coalesce(left(p_query,1800),''))
        OR EXISTS (
          SELECT 1 FROM regexp_split_to_table(lower(coalesce(p_query,'')), '\s+') AS q(word)
          WHERE length(q.word) > 2 AND c.content_text ILIKE '%' || left(q.word,60) || '%'
        )
      ) AS lexical_match
    FROM public.company_manual_chunks c
    JOIN public.company_manuals m ON m.id = c.manual_id AND m.company_id = c.company_id
    JOIN public.companies co ON co.id = c.company_id AND co.industry_key = c.industry_key
    JOIN public.industry_modules im ON im.industry_key = co.industry_key AND im.status = 'active'
    WHERE c.company_id = p_company_id
      AND co.status = 'active'
      AND m.reference_enabled = true
      AND m.extraction_status = 'ready'
  ), ranked AS (
    SELECT
      *,
      greatest(lexical_score, semantic_score * 0.85)::real AS combined_score,
      CASE
        WHEN lexical_match AND semantic_score > 0 THEN 'hybrid'
        WHEN lexical_match THEN 'keyword'
        ELSE 'semantic'
      END AS method
    FROM candidates
    WHERE lexical_match OR (p_embedding IS NOT NULL AND semantic_score > 0.25)
  )
  SELECT
    r.id,
    r.manual_id,
    r.title,
    r.source_url,
    r.page_number,
    r.page_start,
    r.page_end,
    r.content_text,
    r.combined_score,
    r.method,
    r.industry_key,
    r.manufacturer_normalized,
    r.model_normalized,
    r.equipment_category,
    r.reference_enabled,
    r.extraction_status
  FROM ranked r
  ORDER BY r.combined_score DESC, r.page_number NULLS LAST
  LIMIT least(greatest(coalesce(p_limit,6),1),12)
$$;

REVOKE ALL ON FUNCTION public.search_company_manual_chunks_hybrid(uuid, text, extensions.vector, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_company_manual_chunks_hybrid(uuid, text, extensions.vector, integer) TO service_role;

-- ----------------------------------------------------------------------------
-- Migration 42/47: 20261024140000_company_notifications_foundation.sql
-- ----------------------------------------------------------------------------

-- Migration 042: Company Notifications and Delivery Foundation
-- Implements durable, company-scoped notification events, per-recipient read states,
-- channel delivery queue (in_app, email, web_push), and strict tenant-isolated RLS.

-- 1. Company-level notification events
CREATE TABLE IF NOT EXISTS public.company_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_notifications_dedupe_uniq UNIQUE(company_id, dedupe_key),
  CONSTRAINT company_notifications_id_company_uniq UNIQUE(id, company_id)
);

CREATE INDEX IF NOT EXISTS company_notifications_company_created_idx
  ON public.company_notifications(company_id, created_at DESC);

ALTER TABLE public.company_notifications ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.company_notifications FROM public, anon, authenticated;
GRANT SELECT ON public.company_notifications TO authenticated;
GRANT ALL ON public.company_notifications TO service_role;

-- 2. Per-recipient delivery & read state
CREATE TABLE IF NOT EXISTS public.user_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_role text NOT NULL DEFAULT 'all',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_notifications_uniq_user_notif UNIQUE(notification_id, user_id),
  CONSTRAINT user_notifications_company_fk FOREIGN KEY (notification_id, company_id)
    REFERENCES public.company_notifications(id, company_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS user_notifications_user_company_unread_idx
  ON public.user_notifications(user_id, company_id, read_at, created_at DESC);

ALTER TABLE public.user_notifications ENABLE ROW LEVEL SECURITY;

-- Revoke direct client UPDATE: read state mutations must go through SECURITY DEFINER RPCs
REVOKE ALL ON public.user_notifications FROM public, anon, authenticated;
GRANT SELECT ON public.user_notifications TO authenticated;
GRANT ALL ON public.user_notifications TO service_role;

DROP POLICY IF EXISTS user_notifications_select_policy ON public.user_notifications;
CREATE POLICY user_notifications_select_policy ON public.user_notifications
  FOR SELECT TO authenticated
  USING (
    public.is_platform_admin() OR (
      user_id = auth.uid() AND EXISTS (
        SELECT 1 FROM public.company_members m
        JOIN public.companies c ON c.id = m.company_id
        WHERE m.company_id = user_notifications.company_id
          AND m.user_id = auth.uid()
          AND m.status = 'active'
          AND c.status = 'active'
      )
    )
  );

-- Direct client updates are disallowed; status changes are strictly performed via RPC
DROP POLICY IF EXISTS user_notifications_update_policy ON public.user_notifications;

-- Authenticated members can only inspect company events if they are an active recipient of that event
-- (Defined after user_notifications table creation to resolve dependency order on clean bootstrap)
DROP POLICY IF EXISTS company_notifications_select_policy ON public.company_notifications;
CREATE POLICY company_notifications_select_policy ON public.company_notifications
  FOR SELECT TO authenticated
  USING (
    public.is_platform_admin() OR EXISTS (
      SELECT 1 FROM public.user_notifications un
      JOIN public.company_members m ON m.company_id = un.company_id AND m.user_id = un.user_id
      JOIN public.companies c ON c.id = un.company_id
      WHERE un.notification_id = company_notifications.id
        AND un.company_id = company_notifications.company_id
        AND un.user_id = auth.uid()
        AND m.status = 'active'
        AND c.status = 'active'
    )
  );

-- 3. Notification delivery queue (for in_app, email, and web_push adapters)
CREATE TABLE IF NOT EXISTS public.notification_delivery_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('in_app', 'email', 'web_push')),
  delivery_status text NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'delivered', 'failed', 'opted_out', 'deferred')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  delivered_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_delivery_queue_uniq UNIQUE(notification_id, user_id, channel),
  CONSTRAINT notification_delivery_queue_company_fk FOREIGN KEY (notification_id, company_id)
    REFERENCES public.company_notifications(id, company_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS notification_delivery_queue_status_idx
  ON public.notification_delivery_queue(delivery_status, next_attempt_at)
  WHERE delivery_status = 'pending';

ALTER TABLE public.notification_delivery_queue ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.notification_delivery_queue FROM public, anon;
GRANT SELECT ON public.notification_delivery_queue TO authenticated;
GRANT ALL ON public.notification_delivery_queue TO service_role;

DROP POLICY IF EXISTS notification_delivery_queue_select_policy ON public.notification_delivery_queue;
CREATE POLICY notification_delivery_queue_select_policy ON public.notification_delivery_queue
  FOR SELECT TO authenticated
  USING (
    public.is_platform_admin() OR public.is_company_admin(company_id)
  );

-- 4. User notification preferences per channel
CREATE TABLE IF NOT EXISTS public.user_notification_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('in_app', 'email', 'web_push')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_notification_preferences_uniq UNIQUE(user_id, company_id, channel)
);

ALTER TABLE public.user_notification_preferences ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.user_notification_preferences FROM public, anon;
GRANT SELECT, INSERT, UPDATE ON public.user_notification_preferences TO authenticated;
GRANT ALL ON public.user_notification_preferences TO service_role;

DROP POLICY IF EXISTS user_notification_preferences_select ON public.user_notification_preferences;
CREATE POLICY user_notification_preferences_select ON public.user_notification_preferences
  FOR SELECT TO authenticated
  USING (
    public.is_platform_admin() OR (
      user_id = auth.uid() AND EXISTS (
        SELECT 1 FROM public.company_members m
        JOIN public.companies c ON c.id = m.company_id
        WHERE m.company_id = user_notification_preferences.company_id
          AND m.user_id = auth.uid()
          AND m.status = 'active'
          AND c.status = 'active'
      )
    )
  );

DROP POLICY IF EXISTS user_notification_preferences_manage ON public.user_notification_preferences;
CREATE POLICY user_notification_preferences_manage ON public.user_notification_preferences
  FOR ALL TO authenticated
  USING (
    user_id = auth.uid() AND EXISTS (
      SELECT 1 FROM public.company_members m
      JOIN public.companies c ON c.id = m.company_id
      WHERE m.company_id = user_notification_preferences.company_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
        AND c.status = 'active'
      )
  )
  WITH CHECK (
    user_id = auth.uid() AND EXISTS (
      SELECT 1 FROM public.company_members m
      JOIN public.companies c ON c.id = m.company_id
      WHERE m.company_id = user_notification_preferences.company_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
        AND c.status = 'active'
    )
  );

-- 5. Database RPC Functions

-- 5a. Publish notification (service role only)
CREATE OR REPLACE FUNCTION public.pooldocai_publish_company_notification(
  p_company_id uuid,
  p_event_type text,
  p_title text,
  p_body text,
  p_data jsonb DEFAULT '{}'::jsonb,
  p_dedupe_key text DEFAULT NULL,
  p_target_role text DEFAULT 'all',
  p_target_user_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_notification_id uuid;
  v_rec record;
  v_pref_in_app boolean;
  v_pref_email boolean;
  v_pref_push boolean;
BEGIN
  -- Verify active company
  IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = p_company_id AND status = 'active') THEN
    RAISE EXCEPTION 'COMPANY_NOT_ACTIVE_OR_FOUND';
  END IF;

  -- Insert event (idempotent if dedupe_key matches)
  INSERT INTO public.company_notifications (company_id, event_type, title, body, data, dedupe_key)
  VALUES (p_company_id, p_event_type, p_title, p_body, coalesce(p_data, '{}'::jsonb), p_dedupe_key)
  ON CONFLICT (company_id, dedupe_key) DO UPDATE
    SET title = EXCLUDED.title, body = EXCLUDED.body, data = EXCLUDED.data
  RETURNING id INTO v_notification_id;

  -- Determine recipients
  FOR v_rec IN
    SELECT m.user_id, m.role
    FROM public.company_members m
    WHERE m.company_id = p_company_id
      AND m.status = 'active'
      AND (
        (p_target_user_id IS NOT NULL AND m.user_id = p_target_user_id)
        OR (
          p_target_user_id IS NULL AND (
            p_target_role = 'all'
            OR (p_target_role = 'admin' AND m.role = 'company_admin')
            OR (p_target_role = 'technician' AND m.role IN ('technician', 'company_admin'))
          )
        )
      )
  LOOP
    -- Insert user notification
    INSERT INTO public.user_notifications (notification_id, company_id, user_id, recipient_role)
    VALUES (v_notification_id, p_company_id, v_rec.user_id, v_rec.role)
    ON CONFLICT (notification_id, user_id) DO NOTHING;

    -- Consult recipient preferences per channel
    SELECT enabled INTO v_pref_in_app FROM public.user_notification_preferences
    WHERE user_id = v_rec.user_id AND company_id = p_company_id AND channel = 'in_app';

    SELECT enabled INTO v_pref_email FROM public.user_notification_preferences
    WHERE user_id = v_rec.user_id AND company_id = p_company_id AND channel = 'email';

    SELECT enabled INTO v_pref_push FROM public.user_notification_preferences
    WHERE user_id = v_rec.user_id AND company_id = p_company_id AND channel = 'web_push';

    -- Enqueue in_app delivery (delivered immediately if not opted out)
    IF v_pref_in_app IS NOT FALSE THEN
      INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status, delivered_at)
      VALUES (v_notification_id, p_company_id, v_rec.user_id, 'in_app', 'delivered', now())
      ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
    ELSE
      INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status)
      VALUES (v_notification_id, p_company_id, v_rec.user_id, 'in_app', 'opted_out')
      ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
    END IF;

    -- Enqueue email adapter (deferred pending Part-2 configuration, or opted_out)
    IF v_pref_email IS NOT FALSE THEN
      INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status)
      VALUES (v_notification_id, p_company_id, v_rec.user_id, 'email', 'deferred')
      ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
    ELSE
      INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status)
      VALUES (v_notification_id, p_company_id, v_rec.user_id, 'email', 'opted_out')
      ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
    END IF;

    -- Enqueue web_push adapter (deferred pending Part-3 configuration, or opted_out)
    IF v_pref_push IS NOT FALSE THEN
      INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status)
      VALUES (v_notification_id, p_company_id, v_rec.user_id, 'web_push', 'deferred')
      ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
    ELSE
      INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status)
      VALUES (v_notification_id, p_company_id, v_rec.user_id, 'web_push', 'opted_out')
      ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
    END IF;
  END LOOP;

  RETURN v_notification_id;
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_publish_company_notification(uuid, text, text, text, jsonb, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_publish_company_notification(uuid, text, text, text, jsonb, text, text, uuid) TO service_role;

-- 5b. Get user notifications with company context validation
CREATE OR REPLACE FUNCTION public.pooldocai_get_user_notifications(
  p_company_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0,
  p_unread_only boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_unread_count integer := 0;
  v_total_count integer := 0;
  v_items jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'AUTHENTICATION_REQUIRED';
  END IF;

  -- If p_company_id is explicitly provided, validate caller's active membership in that company
  IF p_company_id IS NOT NULL THEN
    SELECT m.company_id INTO v_company_id
    FROM public.company_members m
    JOIN public.companies c ON c.id = m.company_id
    WHERE m.company_id = p_company_id
      AND m.user_id = v_user_id
      AND m.status = 'active'
      AND c.status = 'active';

    IF v_company_id IS NULL THEN
      RAISE EXCEPTION 'NOT_A_MEMBER_OF_SPECIFIED_COMPANY';
    END IF;
  ELSE
    -- Resolve caller's active company (default to earliest active membership)
    SELECT m.company_id INTO v_company_id
    FROM public.company_members m
    JOIN public.companies c ON c.id = m.company_id
    WHERE m.user_id = v_user_id
      AND m.status = 'active'
      AND c.status = 'active'
    ORDER BY m.created_at ASC
    LIMIT 1;
  END IF;

  IF v_company_id IS NULL THEN
    RETURN jsonb_build_object(
      'notifications', '[]'::jsonb,
      'unread_count', 0,
      'total_count', 0
    );
  END IF;

  -- Count unread
  SELECT count(*) INTO v_unread_count
  FROM public.user_notifications un
  WHERE un.user_id = v_user_id
    AND un.company_id = v_company_id
    AND un.read_at IS NULL;

  -- Count total
  SELECT count(*) INTO v_total_count
  FROM public.user_notifications un
  WHERE un.user_id = v_user_id
    AND un.company_id = v_company_id;

  -- Query rows with strict same-company join enforcement
  SELECT coalesce(jsonb_agg(item), '[]'::jsonb) INTO v_items
  FROM (
    SELECT
      un.id AS user_notification_id,
      un.notification_id,
      un.company_id,
      un.recipient_role,
      un.read_at,
      un.created_at,
      cn.event_type,
      cn.title,
      cn.body,
      cn.data
    FROM public.user_notifications un
    JOIN public.company_notifications cn
      ON cn.id = un.notification_id
     AND cn.company_id = un.company_id
    WHERE un.user_id = v_user_id
      AND un.company_id = v_company_id
      AND (NOT p_unread_only OR un.read_at IS NULL)
    ORDER BY un.created_at DESC
    LIMIT least(greatest(coalesce(p_limit, 20), 1), 100)
    OFFSET greatest(coalesce(p_offset, 0), 0)
  ) item;

  RETURN jsonb_build_object(
    'notifications', v_items,
    'unread_count', v_unread_count,
    'total_count', v_total_count,
    'company_id', v_company_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.pooldocai_get_user_notifications(uuid, integer, integer, boolean) TO authenticated, service_role;

-- 5c. Mark notification read
CREATE OR REPLACE FUNCTION public.pooldocai_mark_notification_read(
  p_user_notification_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_updated integer := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'AUTHENTICATION_REQUIRED';
  END IF;

  UPDATE public.user_notifications
  SET read_at = now()
  WHERE id = p_user_notification_id
    AND user_id = v_user_id
    AND read_at IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION public.pooldocai_mark_notification_read(uuid) TO authenticated, service_role;

-- 5d. Mark all notifications read with company context validation
CREATE OR REPLACE FUNCTION public.pooldocai_mark_all_notifications_read(
  p_company_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_updated integer := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'AUTHENTICATION_REQUIRED';
  END IF;

  IF p_company_id IS NOT NULL THEN
    SELECT m.company_id INTO v_company_id
    FROM public.company_members m
    JOIN public.companies c ON c.id = m.company_id
    WHERE m.company_id = p_company_id
      AND m.user_id = v_user_id
      AND m.status = 'active'
      AND c.status = 'active';

    IF v_company_id IS NULL THEN
      RAISE EXCEPTION 'NOT_A_MEMBER_OF_SPECIFIED_COMPANY';
    END IF;
  ELSE
    SELECT m.company_id INTO v_company_id
    FROM public.company_members m
    JOIN public.companies c ON c.id = m.company_id
    WHERE m.user_id = v_user_id
      AND m.status = 'active'
      AND c.status = 'active'
    ORDER BY m.created_at ASC
    LIMIT 1;
  END IF;

  IF v_company_id IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.user_notifications
  SET read_at = now()
  WHERE user_id = v_user_id
    AND company_id = v_company_id
    AND read_at IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

GRANT EXECUTE ON FUNCTION public.pooldocai_mark_all_notifications_read(uuid) TO authenticated, service_role;

-- 6. Durable Service Request Notification Outbox Trigger & Reconciliation
-- Atomically publishes company notifications and stages recipient deliveries whenever a service request is inserted.
CREATE OR REPLACE FUNCTION public.pooldocai_on_service_request_created()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_summary text;
  v_body text;
BEGIN
  -- Build notification body safely without customer PII
  v_summary := coalesce(NEW.request_summary, NEW.equipment_summary, 'Customer service requested');
  v_body := ('Service requested: ' || v_summary);
  IF length(v_body) > 160 THEN
    v_body := substring(v_body from 1 for 157) || '...';
  END IF;

  -- Atomically publish durable notification event and populate inboxes/delivery queue
  PERFORM public.pooldocai_publish_company_notification(
    p_company_id := NEW.company_id,
    p_event_type := 'service_request_created',
    p_title := 'New Customer Service Request',
    p_body := v_body,
    p_data := jsonb_build_object(
      'serviceRequestId', NEW.id,
      'sourceType', coalesce(NEW.source_type, 'customer_widget'),
      'priority', coalesce(NEW.priority, 'normal')
    ),
    p_dedupe_key := 'sr-created-' || NEW.id::text,
    p_target_role := 'admin',
    p_target_user_id := NULL
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pooldocai_service_request_notification ON public.service_requests;
CREATE TRIGGER trg_pooldocai_service_request_notification
  AFTER INSERT ON public.service_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.pooldocai_on_service_request_created();

-- Prevent direct API execution of trigger function
REVOKE ALL ON FUNCTION public.pooldocai_on_service_request_created() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_on_service_request_created() TO service_role;

-- Scheduled or manual reconciliation function for service request notifications
CREATE OR REPLACE FUNCTION public.pooldocai_reconcile_service_request_notifications(
  p_company_id uuid DEFAULT NULL,
  p_lookback_hours integer DEFAULT 24
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rec record;
  v_count integer := 0;
  v_summary text;
  v_body text;
BEGIN
  FOR v_rec IN
    SELECT sr.id, sr.company_id, sr.request_summary, sr.equipment_summary, sr.source_type, sr.priority
    FROM public.service_requests sr
    JOIN public.companies c ON c.id = sr.company_id
    WHERE (p_company_id IS NULL OR sr.company_id = p_company_id)
      AND c.status = 'active'
      AND sr.created_at >= (now() - make_interval(hours := p_lookback_hours))
      AND NOT EXISTS (
        SELECT 1 FROM public.company_notifications cn
        WHERE cn.company_id = sr.company_id
          AND cn.dedupe_key = 'sr-created-' || sr.id::text
      )
  LOOP
    v_summary := coalesce(v_rec.request_summary, v_rec.equipment_summary, 'Customer service requested');
    v_body := ('Service requested: ' || v_summary);
    IF length(v_body) > 160 THEN
      v_body := substring(v_body from 1 for 157) || '...';
    END IF;

    PERFORM public.pooldocai_publish_company_notification(
      p_company_id := v_rec.company_id,
      p_event_type := 'service_request_created',
      p_title := 'New Customer Service Request',
      p_body := v_body,
      p_data := jsonb_build_object(
        'serviceRequestId', v_rec.id,
        'sourceType', coalesce(v_rec.source_type, 'customer_widget'),
        'priority', coalesce(v_rec.priority, 'normal')
      ),
      p_dedupe_key := 'sr-created-' || v_rec.id::text,
      p_target_role := 'admin',
      p_target_user_id := NULL
    );
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_reconcile_service_request_notifications(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_reconcile_service_request_notifications(uuid, integer) TO service_role;

-- ----------------------------------------------------------------------------
-- Migration 43/47: 20261024150000_email_delivery_foundation.sql
-- ----------------------------------------------------------------------------

-- Migration 043: Email Delivery Outbox, Lease Fencing & Provider Foundation (TASK-007 Part-2)
-- Enables durable, idempotent email outbox claiming, concurrency fencing, exponential retries,
-- dead-letter capping, and privacy-first notification delivery.

-- 1. Extend notification_delivery_queue schema for lease fencing and retry states
ALTER TABLE public.notification_delivery_queue
  DROP CONSTRAINT IF EXISTS notification_delivery_queue_delivery_status_check;

ALTER TABLE public.notification_delivery_queue
  ADD CONSTRAINT notification_delivery_queue_delivery_status_check
  CHECK (delivery_status IN ('pending', 'sending', 'retrying', 'delivered', 'failed', 'dead_letter', 'opted_out', 'deferred'));

ALTER TABLE public.notification_delivery_queue
  ADD COLUMN IF NOT EXISTS lease_token text,
  ADD COLUMN IF NOT EXISTS leased_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE INDEX IF NOT EXISTS notification_delivery_queue_email_pending_idx
  ON public.notification_delivery_queue(channel, delivery_status, next_attempt_at)
  WHERE channel = 'email' AND delivery_status IN ('pending', 'retrying');

-- 2. Update pooldocai_publish_company_notification to enqueue email as 'pending' for immediate delivery
CREATE OR REPLACE FUNCTION public.pooldocai_publish_company_notification(
  p_company_id uuid,
  p_event_type text,
  p_title text,
  p_body text,
  p_data jsonb DEFAULT '{}'::jsonb,
  p_dedupe_key text DEFAULT NULL,
  p_target_role text DEFAULT 'all',
  p_target_user_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_notification_id uuid;
  v_rec record;
  v_pref_in_app boolean;
  v_pref_email boolean;
  v_pref_push boolean;
  v_idempotency_key text;
BEGIN
  -- Verify active company
  IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = p_company_id AND status = 'active') THEN
    RAISE EXCEPTION 'COMPANY_NOT_ACTIVE_OR_FOUND';
  END IF;

  -- Insert event (idempotent if dedupe_key matches)
  INSERT INTO public.company_notifications (company_id, event_type, title, body, data, dedupe_key)
  VALUES (p_company_id, p_event_type, p_title, p_body, coalesce(p_data, '{}'::jsonb), p_dedupe_key)
  ON CONFLICT (company_id, dedupe_key) DO UPDATE
    SET title = EXCLUDED.title, body = EXCLUDED.body, data = EXCLUDED.data
  RETURNING id INTO v_notification_id;

  -- Determine recipients
  FOR v_rec IN
    SELECT m.user_id, m.role
    FROM public.company_members m
    WHERE m.company_id = p_company_id
      AND m.status = 'active'
      AND (
        (p_target_user_id IS NOT NULL AND m.user_id = p_target_user_id)
        OR (
          p_target_user_id IS NULL AND (
            p_target_role = 'all'
            OR (p_target_role = 'admin' AND m.role = 'company_admin')
            OR (p_target_role = 'technician' AND m.role IN ('technician', 'company_admin'))
          )
        )
      )
  LOOP
    -- Insert user notification
    INSERT INTO public.user_notifications (notification_id, company_id, user_id, recipient_role)
    VALUES (v_notification_id, p_company_id, v_rec.user_id, v_rec.role)
    ON CONFLICT (notification_id, user_id) DO NOTHING;

    -- Consult recipient preferences per channel
    SELECT enabled INTO v_pref_in_app FROM public.user_notification_preferences
    WHERE user_id = v_rec.user_id AND company_id = p_company_id AND channel = 'in_app';

    SELECT enabled INTO v_pref_email FROM public.user_notification_preferences
    WHERE user_id = v_rec.user_id AND company_id = p_company_id AND channel = 'email';

    SELECT enabled INTO v_pref_push FROM public.user_notification_preferences
    WHERE user_id = v_rec.user_id AND company_id = p_company_id AND channel = 'web_push';

    -- Enqueue in_app delivery (delivered immediately if not opted out)
    IF v_pref_in_app IS NOT FALSE THEN
      INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status, delivered_at)
      VALUES (v_notification_id, p_company_id, v_rec.user_id, 'in_app', 'delivered', now())
      ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
    ELSE
      INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status)
      VALUES (v_notification_id, p_company_id, v_rec.user_id, 'in_app', 'opted_out')
      ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
    END IF;

    -- Enqueue email adapter (pending for email delivery worker, or opted_out)
    v_idempotency_key := 'email-' || v_notification_id::text || '-' || v_rec.user_id::text;
    IF v_pref_email IS NOT FALSE THEN
      INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status, idempotency_key)
      VALUES (v_notification_id, p_company_id, v_rec.user_id, 'email', 'pending', v_idempotency_key)
      ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
    ELSE
      INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status, idempotency_key)
      VALUES (v_notification_id, p_company_id, v_rec.user_id, 'email', 'opted_out', v_idempotency_key)
      ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
    END IF;

    -- Enqueue web_push adapter (deferred pending Part-3 configuration, or opted_out)
    IF v_pref_push IS NOT FALSE THEN
      INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status)
      VALUES (v_notification_id, p_company_id, v_rec.user_id, 'web_push', 'deferred')
      ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
    ELSE
      INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status)
      VALUES (v_notification_id, p_company_id, v_rec.user_id, 'web_push', 'opted_out')
      ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
    END IF;
  END LOOP;

  RETURN v_notification_id;
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_publish_company_notification(uuid, text, text, text, jsonb, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_publish_company_notification(uuid, text, text, text, jsonb, text, text, uuid) TO service_role;

-- 3. Atomic Outbox Batch Claiming with Concurrency Fencing (FOR UPDATE SKIP LOCKED)
CREATE OR REPLACE FUNCTION public.pooldocai_claim_email_delivery_batch(
  p_worker_id text,
  p_batch_size integer DEFAULT 10,
  p_lease_seconds integer DEFAULT 120
)
RETURNS TABLE (
  queue_id uuid,
  notification_id uuid,
  company_id uuid,
  company_name text,
  user_id uuid,
  recipient_email text,
  recipient_role text,
  event_type text,
  title text,
  body text,
  event_data jsonb,
  attempts integer,
  idempotency_key text,
  lease_token text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_rec record;
  v_lease_interval interval := (least(greatest(p_lease_seconds, 15), 600) * interval '1 second');
  v_claim_lease_token text;
  v_opted_out boolean;
  v_company_active boolean;
  v_member_active boolean;
  v_user_email text;
  v_member_role text;
BEGIN
  -- Recover stale/abandoned worker leases
  UPDATE public.notification_delivery_queue q_stale
  SET delivery_status = 'dead_letter',
      last_error = 'worker_lease_expired_max_attempts',
      updated_at = now()
  WHERE q_stale.channel = 'email'
    AND q_stale.delivery_status = 'sending'
    AND q_stale.leased_at < now() - v_lease_interval
    AND q_stale.attempts >= 5;

  UPDATE public.notification_delivery_queue q_retry
  SET delivery_status = 'retrying',
      next_attempt_at = now(),
      updated_at = now()
  WHERE q_retry.channel = 'email'
    AND q_retry.delivery_status = 'sending'
    AND q_retry.leased_at < now() - v_lease_interval
    AND q_retry.attempts < 5;

  -- Select and lock candidate queue rows using SKIP LOCKED
  FOR v_rec IN
    SELECT
      q.id AS q_id,
      q.notification_id AS q_notif_id,
      q.company_id AS q_co_id,
      q.user_id AS q_user_id,
      q.attempts AS q_attempts,
      coalesce(q.idempotency_key, 'email-' || q.notification_id::text || '-' || q.user_id::text) AS q_idem_key,
      cn.event_type AS q_event_type,
      cn.title AS q_title,
      cn.body AS q_body,
      cn.data AS q_data,
      c.name AS q_co_name,
      c.status AS q_co_status
    FROM public.notification_delivery_queue q
    JOIN public.company_notifications cn ON cn.id = q.notification_id AND cn.company_id = q.company_id
    JOIN public.companies c ON c.id = q.company_id
    WHERE q.channel = 'email'
      AND q.delivery_status IN ('pending', 'retrying')
      AND q.next_attempt_at <= now()
    ORDER BY q.next_attempt_at ASC, q.created_at ASC
    LIMIT p_batch_size
    FOR UPDATE OF q SKIP LOCKED
  LOOP
    -- 1. Check company status
    IF v_rec.q_co_status <> 'active' THEN
      UPDATE public.notification_delivery_queue q_fail
      SET delivery_status = 'failed',
          last_error = 'company_inactive_or_suspended',
          updated_at = now()
      WHERE q_fail.id = v_rec.q_id;
      CONTINUE;
    END IF;

    -- 2. Check active membership in the specified company
    SELECT m.role, (m.status = 'active') INTO v_member_role, v_member_active
    FROM public.company_members m
    WHERE m.company_id = v_rec.q_co_id AND m.user_id = v_rec.q_user_id;

    IF v_member_active IS NOT TRUE THEN
      UPDATE public.notification_delivery_queue q_mem
      SET delivery_status = 'failed',
          last_error = 'recipient_not_active_member',
          updated_at = now()
      WHERE q_mem.id = v_rec.q_id;
      CONTINUE;
    END IF;

    -- 3. Check delivery-time email opt-out preferences
    SELECT (enabled = false) INTO v_opted_out
    FROM public.user_notification_preferences
    WHERE user_id = v_rec.q_user_id AND company_id = v_rec.q_co_id AND channel = 'email';

    IF v_opted_out IS TRUE THEN
      UPDATE public.notification_delivery_queue q_opt
      SET delivery_status = 'opted_out',
          updated_at = now()
      WHERE q_opt.id = v_rec.q_id;
      CONTINUE;
    END IF;

    -- 4. Lookup auth user email
    SELECT u.email INTO v_user_email
    FROM auth.users u
    WHERE u.id = v_rec.q_user_id;

    IF v_user_email IS NULL OR v_user_email = '' THEN
      UPDATE public.notification_delivery_queue q_no_email
      SET delivery_status = 'failed',
          last_error = 'recipient_email_missing',
          updated_at = now()
      WHERE q_no_email.id = v_rec.q_id;
      CONTINUE;
    END IF;

    -- 5. Atomically transition row to 'sending' with distinct unguessable per-claim lease token (ABA safe)
    v_claim_lease_token := 'claim_' || gen_random_uuid()::text;

    UPDATE public.notification_delivery_queue q_send
    SET delivery_status = 'sending',
        lease_token = v_claim_lease_token,
        leased_at = now(),
        attempts = q_send.attempts + 1,
        idempotency_key = v_rec.q_idem_key,
        updated_at = now()
    WHERE q_send.id = v_rec.q_id;

    -- Emit row to result set
    queue_id := v_rec.q_id;
    notification_id := v_rec.q_notif_id;
    company_id := v_rec.q_co_id;
    company_name := v_rec.q_co_name;
    user_id := v_rec.q_user_id;
    recipient_email := v_user_email;
    recipient_role := coalesce(v_member_role, 'technician');
    event_type := v_rec.q_event_type;
    title := v_rec.q_title;
    body := v_rec.q_body;
    event_data := v_rec.q_data;
    attempts := v_rec.q_attempts + 1;
    idempotency_key := v_rec.q_idem_key;
    lease_token := v_claim_lease_token;

    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_claim_email_delivery_batch(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_claim_email_delivery_batch(text, integer, integer) TO service_role;

-- 4. Atomic Delivery Finalization RPC with Strict Lease Fencing
CREATE OR REPLACE FUNCTION public.pooldocai_finish_email_delivery(
  p_queue_id uuid,
  p_lease_token text,
  p_success boolean,
  p_provider_message_id text DEFAULT NULL,
  p_error text DEFAULT NULL,
  p_retryable boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.notification_delivery_queue;
  v_backoff_secs integer;
BEGIN
  -- Strict lease fencing: verify row is currently in 'sending' state with matching lease_token
  SELECT * INTO v_row
  FROM public.notification_delivery_queue
  WHERE id = p_queue_id
    AND lease_token = p_lease_token
    AND delivery_status = 'sending'
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Stale worker fenced out: row was reclaimed by another worker or aborted
    RETURN false;
  END IF;

  IF p_success THEN
    UPDATE public.notification_delivery_queue
    SET delivery_status = 'delivered',
        delivered_at = now(),
        provider_message_id = p_provider_message_id,
        last_error = NULL,
        lease_token = NULL,
        leased_at = NULL,
        updated_at = now()
    WHERE id = p_queue_id;
    RETURN true;
  END IF;

  -- Handle failure
  IF p_retryable AND v_row.attempts < 5 THEN
    -- Exponential backoff: 30s, 60s, 120s, 240s capped at 1 hour
    v_backoff_secs := least(3600, 30 * power(2, greatest(v_row.attempts - 1, 0))::integer);
    UPDATE public.notification_delivery_queue
    SET delivery_status = 'retrying',
        next_attempt_at = now() + (v_backoff_secs * interval '1 second'),
        last_error = left(coalesce(p_error, 'retryable_delivery_error'), 255),
        lease_token = NULL,
        leased_at = NULL,
        updated_at = now()
    WHERE id = p_queue_id;
    RETURN true;
  ELSE
    -- Non-retryable or max attempts exhausted -> dead_letter
    UPDATE public.notification_delivery_queue
    SET delivery_status = 'dead_letter',
        last_error = left(coalesce(p_error, 'terminal_delivery_failure'), 255),
        lease_token = NULL,
        leased_at = NULL,
        updated_at = now()
    WHERE id = p_queue_id;
    RETURN true;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_finish_email_delivery(uuid, text, boolean, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_finish_email_delivery(uuid, text, boolean, text, text, boolean) TO service_role;

-- ----------------------------------------------------------------------------
-- Migration 44/47: 20261024160000_web_push_delivery_foundation.sql
-- ----------------------------------------------------------------------------

-- Migration 044: Web Push Delivery Foundation & Device Subscription Management (TASK-007 Part-3)
-- Enables durable, idempotent Web Push outbox claiming, device subscription lifecycle,
-- tenant isolation, lease fencing, privacy minimization, and 404/410 auto-revocation.

-- 1. Create user_push_subscriptions table
CREATE TABLE IF NOT EXISTS public.user_push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  last_used_at timestamptz NULL,
  CONSTRAINT user_push_subscriptions_user_endpoint_key UNIQUE (user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_user_push_subscriptions_lookup
  ON public.user_push_subscriptions(company_id, user_id, status);

CREATE INDEX IF NOT EXISTS idx_user_push_subscriptions_endpoint
  ON public.user_push_subscriptions(endpoint);

-- 2. Row Level Security for user_push_subscriptions
ALTER TABLE public.user_push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_push_subscriptions_select_own
  ON public.user_push_subscriptions
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.company_members cm
      WHERE cm.company_id = user_push_subscriptions.company_id
        AND cm.user_id = auth.uid()
        AND cm.status = 'active'
    )
  );

CREATE POLICY user_push_subscriptions_insert_own
  ON public.user_push_subscriptions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.company_members cm
      WHERE cm.company_id = user_push_subscriptions.company_id
        AND cm.user_id = auth.uid()
        AND cm.status = 'active'
    )
  );

CREATE POLICY user_push_subscriptions_update_own
  ON public.user_push_subscriptions
  FOR UPDATE
  TO authenticated
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.company_members cm
      WHERE cm.company_id = user_push_subscriptions.company_id
        AND cm.user_id = auth.uid()
        AND cm.status = 'active'
    )
  );

CREATE POLICY user_push_subscriptions_delete_own
  ON public.user_push_subscriptions
  FOR DELETE
  TO authenticated
  USING (
    auth.uid() = user_id
  );

-- 3. Device Registration and Revocation Client RPCs
CREATE OR REPLACE FUNCTION public.pooldocai_register_push_subscription(
  p_company_id uuid,
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_user_agent text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_sub_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  -- Validate endpoint
  IF p_endpoint IS NULL OR NOT (p_endpoint LIKE 'https://%') THEN
    RAISE EXCEPTION 'INVALID_PUSH_ENDPOINT';
  END IF;

  -- Validate keys
  IF p_p256dh IS NULL OR length(trim(p_p256dh)) = 0 OR p_auth IS NULL OR length(trim(p_auth)) = 0 THEN
    RAISE EXCEPTION 'INVALID_PUSH_KEYS';
  END IF;

  -- Check company and active membership
  IF NOT EXISTS (
    SELECT 1 FROM public.company_members cm
    JOIN public.companies c ON c.id = cm.company_id
    WHERE cm.company_id = p_company_id
      AND cm.user_id = v_user_id
      AND cm.status = 'active'
      AND c.status = 'active'
  ) THEN
    RAISE EXCEPTION 'ACTIVE_COMPANY_MEMBERSHIP_REQUIRED';
  END IF;

  -- Upsert subscription
  INSERT INTO public.user_push_subscriptions (
    user_id, company_id, endpoint, p256dh, auth, user_agent, status, updated_at
  )
  VALUES (
    v_user_id, p_company_id, p_endpoint, p_p256dh, p_auth, p_user_agent, 'active', now()
  )
  ON CONFLICT (user_id, endpoint) DO UPDATE
    SET company_id = EXCLUDED.company_id,
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        user_agent = coalesce(EXCLUDED.user_agent, public.user_push_subscriptions.user_agent),
        status = 'active',
        updated_at = now()
  RETURNING id INTO v_sub_id;

  -- Ensure user preference for web_push is enabled
  INSERT INTO public.user_notification_preferences (user_id, company_id, channel, enabled, updated_at)
  VALUES (v_user_id, p_company_id, 'web_push', true, now())
  ON CONFLICT (user_id, company_id, channel) DO UPDATE
    SET enabled = true, updated_at = now();

  RETURN v_sub_id;
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_register_push_subscription(uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pooldocai_register_push_subscription(uuid, text, text, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pooldocai_unregister_push_subscription(
  p_endpoint text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_count integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  UPDATE public.user_push_subscriptions
  SET status = 'revoked',
      updated_at = now()
  WHERE user_id = v_user_id
    AND endpoint = p_endpoint
    AND status = 'active';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_unregister_push_subscription(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pooldocai_unregister_push_subscription(text) TO authenticated, service_role;

-- 4. Update pooldocai_publish_company_notification to enqueue web_push as pending when active subscriptions exist
CREATE OR REPLACE FUNCTION public.pooldocai_publish_company_notification(
  p_company_id uuid,
  p_event_type text,
  p_title text,
  p_body text,
  p_data jsonb DEFAULT '{}'::jsonb,
  p_dedupe_key text DEFAULT NULL,
  p_target_role text DEFAULT 'all',
  p_target_user_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_notification_id uuid;
  v_rec record;
  v_pref_in_app boolean;
  v_pref_email boolean;
  v_pref_push boolean;
  v_idempotency_key text;
BEGIN
  -- Verify active company
  IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = p_company_id AND status = 'active') THEN
    RAISE EXCEPTION 'COMPANY_NOT_ACTIVE_OR_FOUND';
  END IF;

  -- Insert event (idempotent if dedupe_key matches)
  INSERT INTO public.company_notifications (company_id, event_type, title, body, data, dedupe_key)
  VALUES (p_company_id, p_event_type, p_title, p_body, coalesce(p_data, '{}'::jsonb), p_dedupe_key)
  ON CONFLICT (company_id, dedupe_key) DO UPDATE
    SET title = EXCLUDED.title, body = EXCLUDED.body, data = EXCLUDED.data
  RETURNING id INTO v_notification_id;

  -- Determine recipients
  FOR v_rec IN
    SELECT m.user_id, m.role
    FROM public.company_members m
    WHERE m.company_id = p_company_id
      AND m.status = 'active'
      AND (
        (p_target_user_id IS NOT NULL AND m.user_id = p_target_user_id)
        OR (
          p_target_user_id IS NULL AND (
            p_target_role = 'all'
            OR (p_target_role = 'admin' AND m.role = 'company_admin')
            OR (p_target_role = 'technician' AND m.role IN ('technician', 'company_admin'))
          )
        )
      )
  LOOP
    -- Insert user notification
    INSERT INTO public.user_notifications (notification_id, company_id, user_id, recipient_role)
    VALUES (v_notification_id, p_company_id, v_rec.user_id, v_rec.role)
    ON CONFLICT (notification_id, user_id) DO NOTHING;

    -- Consult recipient preferences per channel
    SELECT enabled INTO v_pref_in_app FROM public.user_notification_preferences
    WHERE user_id = v_rec.user_id AND company_id = p_company_id AND channel = 'in_app';

    SELECT enabled INTO v_pref_email FROM public.user_notification_preferences
    WHERE user_id = v_rec.user_id AND company_id = p_company_id AND channel = 'email';

    SELECT enabled INTO v_pref_push FROM public.user_notification_preferences
    WHERE user_id = v_rec.user_id AND company_id = p_company_id AND channel = 'web_push';

    -- Enqueue in_app delivery (delivered immediately if not opted out)
    IF v_pref_in_app IS NOT FALSE THEN
      INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status, delivered_at)
      VALUES (v_notification_id, p_company_id, v_rec.user_id, 'in_app', 'delivered', now())
      ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
    ELSE
      INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status)
      VALUES (v_notification_id, p_company_id, v_rec.user_id, 'in_app', 'opted_out')
      ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
    END IF;

    -- Enqueue email adapter (pending for email delivery worker, or opted_out)
    v_idempotency_key := 'email-' || v_notification_id::text || '-' || v_rec.user_id::text;
    IF v_pref_email IS NOT FALSE THEN
      INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status, idempotency_key)
      VALUES (v_notification_id, p_company_id, v_rec.user_id, 'email', 'pending', v_idempotency_key)
      ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
    ELSE
      INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status, idempotency_key)
      VALUES (v_notification_id, p_company_id, v_rec.user_id, 'email', 'opted_out', v_idempotency_key)
      ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
    END IF;

    -- Enqueue web_push adapter (pending if recipient has active subscription and pref enabled, or opted_out, or deferred)
    v_idempotency_key := 'push-' || v_notification_id::text || '-' || v_rec.user_id::text;
    IF v_pref_push IS NOT FALSE THEN
      IF EXISTS (
        SELECT 1 FROM public.user_push_subscriptions ups
        WHERE ups.user_id = v_rec.user_id
          AND ups.company_id = p_company_id
          AND ups.status = 'active'
      ) THEN
        INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status, idempotency_key)
        VALUES (v_notification_id, p_company_id, v_rec.user_id, 'web_push', 'pending', v_idempotency_key)
        ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
      ELSE
        INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status, idempotency_key)
        VALUES (v_notification_id, p_company_id, v_rec.user_id, 'web_push', 'deferred', v_idempotency_key)
        ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
      END IF;
    ELSE
      INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status, idempotency_key)
      VALUES (v_notification_id, p_company_id, v_rec.user_id, 'web_push', 'opted_out', v_idempotency_key)
      ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
    END IF;
  END LOOP;

  RETURN v_notification_id;
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_publish_company_notification(uuid, text, text, text, jsonb, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_publish_company_notification(uuid, text, text, text, jsonb, text, text, uuid) TO service_role;

-- 5. Outbox Batch Claim RPC for Web Push
CREATE INDEX IF NOT EXISTS notification_delivery_queue_push_pending_idx
  ON public.notification_delivery_queue(channel, delivery_status, next_attempt_at)
  WHERE channel = 'web_push' AND delivery_status IN ('pending', 'retrying');

CREATE OR REPLACE FUNCTION public.pooldocai_claim_push_delivery_batch(
  p_worker_id text,
  p_batch_size integer DEFAULT 10,
  p_lease_seconds integer DEFAULT 120
)
RETURNS TABLE (
  queue_id uuid,
  notification_id uuid,
  company_id uuid,
  company_name text,
  user_id uuid,
  recipient_role text,
  event_type text,
  title text,
  body text,
  event_data jsonb,
  subscriptions jsonb,
  attempts integer,
  idempotency_key text,
  lease_token text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_rec record;
  v_lease_interval interval := (least(greatest(p_lease_seconds, 15), 600) * interval '1 second');
  v_claim_lease_token text;
  v_opted_out boolean;
  v_company_active boolean;
  v_member_active boolean;
  v_member_role text;
  v_subs jsonb;
BEGIN
  -- 1. Recover stale/abandoned worker leases
  UPDATE public.notification_delivery_queue q_stale
  SET delivery_status = 'dead_letter',
      last_error = 'worker_lease_expired_max_attempts',
      updated_at = now()
  WHERE q_stale.channel = 'web_push'
    AND q_stale.delivery_status = 'sending'
    AND q_stale.leased_at < now() - v_lease_interval
    AND q_stale.attempts >= 5;

  UPDATE public.notification_delivery_queue q_retry
  SET delivery_status = 'retrying',
      next_attempt_at = now(),
      updated_at = now()
  WHERE q_retry.channel = 'web_push'
    AND q_retry.delivery_status = 'sending'
    AND q_retry.leased_at < now() - v_lease_interval
    AND q_retry.attempts < 5;

  -- 2. Select and lock candidate queue rows using SKIP LOCKED
  FOR v_rec IN
    SELECT
      q.id AS q_id,
      q.notification_id AS q_notif_id,
      q.company_id AS q_co_id,
      q.user_id AS q_user_id,
      q.attempts AS q_attempts,
      coalesce(q.idempotency_key, 'push-' || q.notification_id::text || '-' || q.user_id::text) AS q_idem_key,
      cn.event_type AS q_event_type,
      cn.title AS q_title,
      cn.body AS q_body,
      cn.data AS q_data,
      c.name AS q_co_name,
      c.status AS q_co_status
    FROM public.notification_delivery_queue q
    JOIN public.company_notifications cn ON cn.id = q.notification_id AND cn.company_id = q.company_id
    JOIN public.companies c ON c.id = q.company_id
    WHERE q.channel = 'web_push'
      AND q.delivery_status IN ('pending', 'retrying')
      AND q.next_attempt_at <= now()
    ORDER BY q.next_attempt_at ASC, q.created_at ASC
    LIMIT p_batch_size
    FOR UPDATE OF q SKIP LOCKED
  LOOP
    -- Check company status
    IF v_rec.q_co_status <> 'active' THEN
      UPDATE public.notification_delivery_queue q_fail
      SET delivery_status = 'failed',
          last_error = 'company_inactive_or_suspended',
          updated_at = now()
      WHERE q_fail.id = v_rec.q_id;
      CONTINUE;
    END IF;

    -- Check active membership
    SELECT m.role, (m.status = 'active') INTO v_member_role, v_member_active
    FROM public.company_members m
    WHERE m.company_id = v_rec.q_co_id AND m.user_id = v_rec.q_user_id;

    IF v_member_active IS NOT TRUE THEN
      UPDATE public.notification_delivery_queue q_mem
      SET delivery_status = 'failed',
          last_error = 'recipient_not_active_member',
          updated_at = now()
      WHERE q_mem.id = v_rec.q_id;
      CONTINUE;
    END IF;

    -- Check opt-out
    SELECT (enabled = false) INTO v_opted_out
    FROM public.user_notification_preferences
    WHERE user_id = v_rec.q_user_id AND company_id = v_rec.q_co_id AND channel = 'web_push';

    IF v_opted_out IS TRUE THEN
      UPDATE public.notification_delivery_queue q_opt
      SET delivery_status = 'opted_out',
          updated_at = now()
      WHERE q_opt.id = v_rec.q_id;
      CONTINUE;
    END IF;

    -- Query active device subscriptions for this user and company
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', ups.id,
      'endpoint', ups.endpoint,
      'p256dh', ups.p256dh,
      'auth', ups.auth
    )), '[]'::jsonb) INTO v_subs
    FROM public.user_push_subscriptions ups
    WHERE ups.user_id = v_rec.q_user_id
      AND ups.company_id = v_rec.q_co_id
      AND ups.status = 'active';

    IF v_subs IS NULL OR jsonb_array_length(v_subs) = 0 THEN
      UPDATE public.notification_delivery_queue q_no_sub
      SET delivery_status = 'failed',
          last_error = 'no_active_push_subscriptions',
          updated_at = now()
      WHERE q_no_sub.id = v_rec.q_id;
      CONTINUE;
    END IF;

    -- Atomically transition row to 'sending' with distinct unguessable per-claim lease token
    v_claim_lease_token := 'claim_' || gen_random_uuid()::text;

    UPDATE public.notification_delivery_queue q_send
    SET delivery_status = 'sending',
        lease_token = v_claim_lease_token,
        leased_at = now(),
        attempts = q_send.attempts + 1,
        idempotency_key = v_rec.q_idem_key,
        updated_at = now()
    WHERE q_send.id = v_rec.q_id;

    queue_id := v_rec.q_id;
    notification_id := v_rec.q_notif_id;
    company_id := v_rec.q_co_id;
    company_name := v_rec.q_co_name;
    user_id := v_rec.q_user_id;
    recipient_role := coalesce(v_member_role, 'technician');
    event_type := v_rec.q_event_type;
    title := v_rec.q_title;
    body := v_rec.q_body;
    event_data := v_rec.q_data;
    subscriptions := v_subs;
    attempts := v_rec.q_attempts + 1;
    idempotency_key := v_rec.q_idem_key;
    lease_token := v_claim_lease_token;

    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_claim_push_delivery_batch(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_claim_push_delivery_batch(text, integer, integer) TO service_role;

-- 6. Atomic Push Delivery Finalization RPC
CREATE OR REPLACE FUNCTION public.pooldocai_finish_push_delivery(
  p_queue_id uuid,
  p_lease_token text,
  p_success boolean,
  p_provider_message_id text DEFAULT NULL,
  p_error text DEFAULT NULL,
  p_retryable boolean DEFAULT false,
  p_revoked_endpoints text[] DEFAULT '{}'::text[]
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.notification_delivery_queue;
  v_backoff_secs integer;
  v_ep text;
BEGIN
  -- Lease fencing: verify row is currently in 'sending' state with matching lease_token
  SELECT * INTO v_row
  FROM public.notification_delivery_queue
  WHERE id = p_queue_id
    AND lease_token = p_lease_token
    AND delivery_status = 'sending'
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Stale worker fenced out
    RETURN false;
  END IF;

  -- Auto-revoke dead endpoints (404/410 returned by push service)
  IF p_revoked_endpoints IS NOT NULL AND array_length(p_revoked_endpoints, 1) > 0 THEN
    FOREACH v_ep IN ARRAY p_revoked_endpoints LOOP
      UPDATE public.user_push_subscriptions
      SET status = 'revoked',
          updated_at = now()
      WHERE endpoint = v_ep;
    END LOOP;
  END IF;

  IF p_success THEN
    UPDATE public.notification_delivery_queue
    SET delivery_status = 'delivered',
        delivered_at = now(),
        provider_message_id = p_provider_message_id,
        last_error = NULL,
        lease_token = NULL,
        leased_at = NULL,
        updated_at = now()
    WHERE id = p_queue_id;
    RETURN true;
  END IF;

  -- Failure handling
  IF p_retryable AND v_row.attempts < 5 THEN
    v_backoff_secs := least(3600, 30 * power(2, greatest(v_row.attempts - 1, 0))::integer);
    UPDATE public.notification_delivery_queue
    SET delivery_status = 'retrying',
        next_attempt_at = now() + (v_backoff_secs * interval '1 second'),
        last_error = left(coalesce(p_error, 'retryable_delivery_error'), 255),
        lease_token = NULL,
        leased_at = NULL,
        updated_at = now()
    WHERE id = p_queue_id;
    RETURN true;
  ELSE
    UPDATE public.notification_delivery_queue
    SET delivery_status = 'dead_letter',
        last_error = left(coalesce(p_error, 'terminal_delivery_failure'), 255),
        lease_token = NULL,
        leased_at = NULL,
        updated_at = now()
    WHERE id = p_queue_id;
    RETURN true;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_finish_push_delivery(uuid, text, boolean, text, text, boolean, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_finish_push_delivery(uuid, text, boolean, text, text, boolean, text[]) TO service_role;

-- ----------------------------------------------------------------------------
-- Migration 45/47: 20261024170000_company_manual_provenance_and_duplicate_guard.sql
-- ----------------------------------------------------------------------------

-- Migration 045: Company manual provenance contract and duplicate protection
-- Implements Task-007 Part-3 Addendum (Comment #6392787154):
-- 1. Provenance contract: source_publisher, canonical_title, publication_number, revision, publication_date, content_sha256, source_locator, product_name, model_family
-- 2. Duplicate protection: same-tenant duplicate rejection + privacy-preserving cross-tenant match detection (pooldocai_check_manual_duplicate)
-- 3. Projects provenance attributes in search_company_manual_chunks and search_company_manual_chunks_hybrid

ALTER TABLE public.company_manuals
  ADD COLUMN IF NOT EXISTS source_publisher text,
  ADD COLUMN IF NOT EXISTS canonical_title text,
  ADD COLUMN IF NOT EXISTS publication_number text,
  ADD COLUMN IF NOT EXISTS revision text,
  ADD COLUMN IF NOT EXISTS publication_date date,
  ADD COLUMN IF NOT EXISTS content_sha256 text,
  ADD COLUMN IF NOT EXISTS source_locator text,
  ADD COLUMN IF NOT EXISTS product_name text,
  ADD COLUMN IF NOT EXISTS model_family text,
  ADD COLUMN IF NOT EXISTS is_duplicate boolean not null default false,
  ADD COLUMN IF NOT EXISTS duplicate_of_manual_id uuid references public.company_manuals(id) on delete set null;

CREATE INDEX IF NOT EXISTS company_manuals_company_sha256_idx ON public.company_manuals(company_id, content_sha256) WHERE content_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS company_manuals_global_sha256_idx ON public.company_manuals(content_sha256) WHERE content_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS company_manuals_pub_rev_idx ON public.company_manuals(publication_number, revision) WHERE publication_number IS NOT NULL;

-- Secure duplicate check function
-- Returns same-company duplicate status and privacy-preserving cross-company match count WITHOUT leaking any other tenant IDs, company names, or storage paths.
CREATE OR REPLACE FUNCTION public.pooldocai_check_manual_duplicate(
  p_company_id uuid,
  p_sha256 text,
  p_manual_id uuid default null
)
RETURNS TABLE(
  is_same_company_duplicate boolean,
  existing_manual_id uuid,
  has_cross_company_match boolean,
  cross_company_match_count integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_same_id uuid := null;
  v_cross_count integer := 0;
BEGIN
  IF p_sha256 IS NULL OR length(trim(p_sha256)) < 32 THEN
    RETURN QUERY SELECT false, null::uuid, false, 0;
    RETURN;
  END IF;

  SELECT id INTO v_same_id
  FROM public.company_manuals
  WHERE company_id = p_company_id
    AND content_sha256 = trim(p_sha256)
    AND (p_manual_id IS NULL OR id <> p_manual_id)
  LIMIT 1;

  SELECT count(DISTINCT company_id)::integer INTO v_cross_count
  FROM public.company_manuals
  WHERE company_id <> p_company_id
    AND content_sha256 = trim(p_sha256);

  RETURN QUERY SELECT
    (v_same_id IS NOT NULL),
    v_same_id,
    (v_cross_count > 0),
    coalesce(v_cross_count, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_check_manual_duplicate(uuid, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.pooldocai_check_manual_duplicate(uuid, text, uuid) TO authenticated, service_role;

-- Update keyword retrieval RPC to project provenance metadata
DROP FUNCTION IF EXISTS public.search_company_manual_chunks(uuid, text, integer);

CREATE OR REPLACE FUNCTION public.search_company_manual_chunks(
  p_company_id uuid,
  p_query text,
  p_limit integer default 6
)
RETURNS TABLE(
  id uuid,
  manual_id uuid,
  title text,
  source_url text,
  page_number integer,
  page_start integer,
  page_end integer,
  content_text text,
  rank real,
  retrieval_method text,
  industry_key text,
  manufacturer_normalized text,
  model_normalized text,
  equipment_category text,
  reference_enabled boolean,
  extraction_status text,
  canonical_title text,
  publication_number text,
  revision text,
  content_sha256 text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT
    c.id,
    c.manual_id,
    c.title,
    c.source_url,
    c.page_number,
    c.page_start,
    c.page_end,
    c.content_text,
    ts_rank(c.search_vector, websearch_to_tsquery('english', coalesce(left(p_query,1800),'')))::real AS rank,
    'keyword'::text AS retrieval_method,
    c.industry_key,
    m.manufacturer_normalized,
    m.model_normalized,
    m.equipment_category,
    m.reference_enabled,
    m.extraction_status,
    m.canonical_title,
    m.publication_number,
    m.revision,
    m.content_sha256
  FROM public.company_manual_chunks c
  JOIN public.company_manuals m ON m.id = c.manual_id AND m.company_id = c.company_id
  JOIN public.companies co ON co.id = c.company_id AND co.industry_key = c.industry_key
  JOIN public.industry_modules im ON im.industry_key = co.industry_key AND im.status = 'active'
  WHERE c.company_id = p_company_id
    AND co.status = 'active'
    AND m.reference_enabled = true
    AND m.extraction_status = 'ready'
    AND (
      c.search_vector @@ websearch_to_tsquery('english', coalesce(left(p_query,1800),''))
      OR EXISTS (
        SELECT 1 FROM regexp_split_to_table(lower(coalesce(p_query,'')), '\s+') AS q(word)
        WHERE length(q.word) > 2 AND c.content_text ILIKE '%' || left(q.word,60) || '%'
      )
    )
  ORDER BY rank DESC, c.chunk_index ASC
  LIMIT least(greatest(coalesce(p_limit,6),1),10)
$$;

REVOKE ALL ON FUNCTION public.search_company_manual_chunks(uuid, text, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.search_company_manual_chunks(uuid, text, integer) TO authenticated, service_role;

-- Update hybrid retrieval RPC to project provenance metadata
DROP FUNCTION IF EXISTS public.search_company_manual_chunks_hybrid(uuid, text, extensions.vector, integer);

CREATE OR REPLACE FUNCTION public.search_company_manual_chunks_hybrid(
  p_company_id uuid,
  p_query text,
  p_embedding extensions.vector(768) default null,
  p_limit integer default 6
)
RETURNS TABLE(
  id uuid,
  manual_id uuid,
  title text,
  source_url text,
  page_number integer,
  page_start integer,
  page_end integer,
  content_text text,
  rank real,
  retrieval_method text,
  industry_key text,
  manufacturer_normalized text,
  model_normalized text,
  equipment_category text,
  reference_enabled boolean,
  extraction_status text,
  canonical_title text,
  publication_number text,
  revision text,
  content_sha256 text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
  WITH candidates AS (
    SELECT
      c.id,
      c.manual_id,
      c.title,
      c.source_url,
      c.page_number,
      c.page_start,
      c.page_end,
      c.content_text,
      c.industry_key,
      m.manufacturer_normalized,
      m.model_normalized,
      m.equipment_category,
      m.reference_enabled,
      m.extraction_status,
      m.canonical_title,
      m.publication_number,
      m.revision,
      m.content_sha256,
      ts_rank(c.search_vector, websearch_to_tsquery('english', coalesce(left(p_query,1800),'')))::real AS lexical_score,
      CASE
        WHEN p_embedding IS NOT NULL AND c.embedding IS NOT NULL THEN (1 - (c.embedding <=> p_embedding))::real
        ELSE 0::real
      END AS semantic_score,
      (
        c.search_vector @@ websearch_to_tsquery('english', coalesce(left(p_query,1800),''))
        OR EXISTS (
          SELECT 1 FROM regexp_split_to_table(lower(coalesce(p_query,'')), '\s+') AS q(word)
          WHERE length(q.word) > 2 AND c.content_text ILIKE '%' || left(q.word,60) || '%'
        )
      ) AS has_lexical_match
    FROM public.company_manual_chunks c
    JOIN public.company_manuals m ON m.id = c.manual_id AND m.company_id = c.company_id
    JOIN public.companies co ON co.id = c.company_id AND co.industry_key = c.industry_key
    JOIN public.industry_modules im ON im.industry_key = co.industry_key AND im.status = 'active'
    WHERE c.company_id = p_company_id
      AND co.status = 'active'
      AND m.reference_enabled = true
      AND m.extraction_status = 'ready'
  ),
  scored AS (
    SELECT
      candidates.*,
      CASE
        WHEN p_embedding IS NOT NULL AND semantic_score > 0.45 AND has_lexical_match THEN (0.45 * lexical_score + 0.55 * semantic_score)::real
        WHEN p_embedding IS NOT NULL AND semantic_score > 0.45 THEN semantic_score
        WHEN has_lexical_match THEN lexical_score
        ELSE 0::real
      END AS final_rank,
      CASE
        WHEN p_embedding IS NOT NULL AND semantic_score > 0.45 AND has_lexical_match THEN 'hybrid'
        WHEN p_embedding IS NOT NULL AND semantic_score > 0.45 THEN 'semantic'
        ELSE 'keyword'
      END AS method
    FROM candidates
    WHERE has_lexical_match OR (p_embedding IS NOT NULL AND semantic_score > 0.45)
  )
  SELECT
    id,
    manual_id,
    title,
    source_url,
    page_number,
    page_start,
    page_end,
    content_text,
    final_rank AS rank,
    method AS retrieval_method,
    industry_key,
    manufacturer_normalized,
    model_normalized,
    equipment_category,
    reference_enabled,
    extraction_status,
    canonical_title,
    publication_number,
    revision,
    content_sha256
  FROM scored
  ORDER BY final_rank DESC
  LIMIT least(greatest(coalesce(p_limit,6),1),10)
$$;

REVOKE ALL ON FUNCTION public.search_company_manual_chunks_hybrid(uuid, text, extensions.vector, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.search_company_manual_chunks_hybrid(uuid, text, extensions.vector, integer) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Migration 46/47: 20261025170000_security_advisor_hardening_rpc_grants.sql
-- ----------------------------------------------------------------------------

-- ============================================================================
-- Migration 046: Supabase Security Advisor Hardening - Explicit Privilege Revocation
-- Resolves anonymous-executable SECURITY DEFINER findings by explicitly revoking
-- PUBLIC and anon execution grants on sensitive RPCs and trigger functions.
-- ============================================================================

-- 1. Explicitly revoke anonymous access to notification read RPCs
REVOKE ALL ON FUNCTION public.pooldocai_get_user_notifications(uuid, integer, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pooldocai_get_user_notifications(uuid, integer, integer, boolean) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.pooldocai_mark_notification_read(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pooldocai_mark_notification_read(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.pooldocai_mark_all_notifications_read(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pooldocai_mark_all_notifications_read(uuid) TO authenticated, service_role;

-- 2. Explicitly revoke public/anon/authenticated execution on trigger function
REVOKE ALL ON FUNCTION public.pooldocai_touch_updated_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_touch_updated_at() TO service_role;

-- ----------------------------------------------------------------------------
-- Migration 47/47: 20261025210000_learning_safety_and_consent_lifecycle.sql
-- ----------------------------------------------------------------------------

-- Migration 047: Learning Publication Safety Trust Boundary, Knowledge Typing, and Consent Lifecycle
-- Forward-only and additive.
-- Enforces:
-- 1) Schema extensions on shared_learning_knowledge:
--    - knowledge_type: verified_repair, manufacturer_manual, observed_diagnosis, unconfirmed_suggestion
--    - technician_verified: boolean flag
--    - publication_status: active, revoked, quarantined
--    - source_manual_id: uuid reference to company_manuals(id)
-- 2) Dedicated Durable Case-Specific Consent Record:
--    - case_learning_consents table tracking authenticated actor, company/case, purpose, terms version, and revocation lifecycle.
-- 3) Atomic Security-Definer Consent Withdrawal RPC:
--    - pooldocai_withdraw_case_learning_consent: single transactional operation updating diagnostic_cases,
--      recording withdrawal in case_learning_consents, soft-revoking shared_learning_knowledge,
--      rejecting review queue items, and logging immutable audit trail.
-- 4) Strict Server-Side Evidence & Tenant Match Gates on pooldocai_approve_learning_case:
--    - Asserts v_case.tenant_id = v_queue.tenant_id (cross-tenant mismatch strictly rejected).
--    - Asserts v_case.case_status = 'resolved' (unresolved cases cannot be published as verified repairs).
--    - Asserts authenticated contributor provenance (contributor_user_id IS NOT NULL).
--    - Asserts active granted record in case_learning_consents.
--    - Rejects model-generated authenticated_troubleshooter suggestions with technician_verified=false.
-- 5) Strict Read & Search Eligibility on search_shared_learning:
--    - Excludes revoked entries (publication_status = 'revoked')
--    - Restricts actionable procedure retrieval to verified repairs and eligible manufacturer manuals
--      (excludes observed_diagnosis and unconfirmed_suggestion)
--    - Enforces per-document company manual consent (joins company_manuals on source_manual_id;
--      if individual manual shared_learning_opt_in is revoked, excludes immediately even if company remains opted in)
--    - Enforces active case_learning_consents row for case-backed records.
-- 6) Historical Re-Review & Revocation Hygiene:
--    - Safely revokes historical unverified authenticated_troubleshooter rows from shared retrieval.
--    - Rejects pending review queue items lacking independent technician verification.
--
-- STRICT NOTE: Code-only task. This migration is committed to the repository for review and staging bundle parity.
-- DO NOT EXECUTE on staging or production databases without separate owner authorization.

BEGIN;

-- 1. Extend shared_learning_knowledge schema
ALTER TABLE public.shared_learning_knowledge
  ADD COLUMN IF NOT EXISTS knowledge_type text DEFAULT 'observed_diagnosis'
  CHECK (knowledge_type IN ('verified_repair', 'manufacturer_manual', 'observed_diagnosis', 'unconfirmed_suggestion'));

ALTER TABLE public.shared_learning_knowledge
  ADD COLUMN IF NOT EXISTS technician_verified boolean DEFAULT false;

ALTER TABLE public.shared_learning_knowledge
  ADD COLUMN IF NOT EXISTS publication_status text NOT NULL DEFAULT 'active'
  CHECK (publication_status IN ('active', 'revoked', 'quarantined'));

ALTER TABLE public.shared_learning_knowledge
  ADD COLUMN IF NOT EXISTS source_manual_id uuid REFERENCES public.company_manuals(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS shared_learning_status_idx
  ON public.shared_learning_knowledge (publication_status, knowledge_type, technician_verified);

CREATE INDEX IF NOT EXISTS shared_learning_manual_idx
  ON public.shared_learning_knowledge (source_manual_id)
  WHERE source_manual_id IS NOT NULL;

-- 1b. Extend diagnostic_cases schema with authenticated contributor provenance and consent origin
ALTER TABLE public.diagnostic_cases
  ADD COLUMN IF NOT EXISTS contributor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contributor_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS consent_origin text;

CREATE INDEX IF NOT EXISTS diagnostic_cases_contributor_idx
  ON public.diagnostic_cases (contributor_user_id, contributor_accepted_at)
  WHERE contributor_user_id IS NOT NULL;

-- 1c. Allow case-level withdrawal audit entries when queue row is absent
ALTER TABLE public.learning_review_audit
  ALTER COLUMN queue_id DROP NOT NULL;

-- 2. Durable Case-Specific Learning Consent Table
CREATE TABLE IF NOT EXISTS public.case_learning_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.diagnostic_cases(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  purpose text NOT NULL DEFAULT 'shared_diagnostic_learning',
  terms_version text NOT NULL,
  consent_status text NOT NULL DEFAULT 'granted' CHECK (consent_status IN ('granted', 'withdrawn', 'revoked')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  revocation_reason text,
  UNIQUE (case_id, purpose)
);

ALTER TABLE public.case_learning_consents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.case_learning_consents FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.case_learning_consents TO service_role;

-- 3. Atomic Transactional Consent Withdrawal RPC
CREATE OR REPLACE FUNCTION public.pooldocai_withdraw_case_learning_consent(
  p_case_id uuid,
  p_company_id uuid,
  p_actor_user_id uuid,
  p_reason text DEFAULT 'Consent withdrawn by company'
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_case public.diagnostic_cases%ROWTYPE;
BEGIN
  -- Lock diagnostic case row
  SELECT * INTO v_case
  FROM public.diagnostic_cases
  WHERE id = p_case_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Diagnostic case % not found', p_case_id;
  END IF;

  IF v_case.tenant_id <> p_company_id THEN
    RAISE EXCEPTION 'You cannot modify another company''s case';
  END IF;

  -- 1. Update diagnostic case flags
  UPDATE public.diagnostic_cases
  SET case_learning_opt_in = false,
      approved_for_learning = false,
      privacy_reviewed_at = NULL
  WHERE id = p_case_id;

  -- 2. Update or insert durable case consent state
  INSERT INTO public.case_learning_consents (
    case_id, company_id, actor_user_id, purpose, terms_version, consent_status, granted_at, withdrawn_at, revocation_reason
  ) VALUES (
    p_case_id, p_company_id, p_actor_user_id, 'shared_diagnostic_learning',
    COALESCE(v_case.learning_terms_version, 'withdrawn'), 'withdrawn', now(), now(), p_reason
  )
  ON CONFLICT (case_id, purpose) DO UPDATE SET
    consent_status = 'withdrawn',
    withdrawn_at = now(),
    revocation_reason = EXCLUDED.revocation_reason;

  -- 3. Soft-revoke shared knowledge publications
  UPDATE public.shared_learning_knowledge
  SET publication_status = 'revoked',
      review_history = review_history || jsonb_build_array(jsonb_build_object(
        'action', 'consent_withdrawn',
        'actor', p_actor_user_id,
        'at', now(),
        'reason', p_reason
      ))
  WHERE source_case_id = p_case_id AND publication_status <> 'revoked';

  -- 4. Update review queue entries
  UPDATE public.learning_review_queue
  SET status = 'rejected', reviewed_at = now()
  WHERE case_id = p_case_id AND status IN ('pending', 'approved');

  -- 5. Immutable audit record
  INSERT INTO public.learning_review_audit (
    queue_id, case_id, actor_user_id, action, note_redacted
  )
  SELECT q.id, p_case_id, p_actor_user_id, 'rejected', p_reason
  FROM public.learning_review_queue q
  WHERE q.case_id = p_case_id;

  IF NOT FOUND THEN
    INSERT INTO public.learning_review_audit (
      queue_id, case_id, actor_user_id, action, note_redacted
    ) VALUES (
      NULL, p_case_id, p_actor_user_id, 'rejected', p_reason
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'case_id', p_case_id,
    'status', 'consent_withdrawn'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_withdraw_case_learning_consent(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_withdraw_case_learning_consent(uuid, uuid, uuid, text) TO service_role;

-- 4. Update pooldocai_approve_learning_case with tenant match, resolved outcome, and durable consent checks
CREATE OR REPLACE FUNCTION public.pooldocai_approve_learning_case(
  p_queue_id uuid,
  p_lesson text,
  p_reviewed_by uuid,
  p_review_note text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_queue public.learning_review_queue%ROWTYPE;
  v_case public.diagnostic_cases%ROWTYPE;
  v_manual public.company_manuals%ROWTYPE;
  v_company_opted_in boolean := false;
  v_manual_id uuid;
  v_has_case_consent boolean := false;
  v_equipment_category text;
  v_manufacturer_normalized text;
  v_model_normalized text;
  v_knowledge_type text;
  v_technician_verified boolean := false;
BEGIN
  -- Lock review queue row
  SELECT * INTO v_queue
  FROM public.learning_review_queue
  WHERE id = p_queue_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Review queue item % not found', p_queue_id;
  END IF;

  IF v_queue.status <> 'pending' THEN
    RAISE EXCEPTION 'Review item % is not pending (status: %)', p_queue_id, v_queue.status;
  END IF;

  -- P0 Evidence Gate 1: Public demo visitor-reported answers are unverified customer feedback signals
  -- and cannot be published as verified shared repair knowledge.
  IF v_queue.source_kind = 'public_demo' THEN
    RAISE EXCEPTION 'Public demo visitor-reported answers cannot be published as verified shared repair knowledge';
  END IF;

  -- P0 Evidence Gate 2: Company manual provenance and document consent
  IF v_queue.source_kind = 'company_manual' THEN
    SELECT (array_agg(elem))[1]::uuid INTO v_manual_id
    FROM unnest(v_queue.supporting_source_ids) AS elem
    WHERE elem NOT LIKE '%#chunk-%';

    IF v_manual_id IS NOT NULL THEN
      SELECT * INTO v_manual
      FROM public.company_manuals
      WHERE id = v_manual_id AND company_id = v_queue.tenant_id
      FOR UPDATE;
    END IF;

    IF v_manual.id IS NULL THEN
      RAISE EXCEPTION 'Source company manual % not found or does not belong to tenant %', v_manual_id, v_queue.tenant_id;
    END IF;

    IF NOT COALESCE(v_manual.shared_learning_opt_in, false) THEN
      RAISE EXCEPTION 'Source company manual opt-in consent is missing or revoked';
    END IF;

    -- Recheck governing company diagnostic learning opt-in
    SELECT diagnostic_learning_opt_in INTO v_company_opted_in
    FROM public.companies
    WHERE id = v_queue.tenant_id;

    IF NOT COALESCE(v_company_opted_in, false) THEN
      RAISE EXCEPTION 'Governing company diagnostic learning opt-in is required';
    END IF;

    v_equipment_category := COALESCE(v_manual.equipment_category, 'manual');
    v_manufacturer_normalized := v_manual.manufacturer_normalized;
    v_model_normalized := v_manual.model_normalized;
    v_knowledge_type := 'manufacturer_manual';
    v_technician_verified := false;

  ELSIF v_queue.case_id IS NOT NULL THEN
    -- Lock diagnostic case row
    SELECT * INTO v_case
    FROM public.diagnostic_cases
    WHERE id = v_queue.case_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Diagnostic case % not found', v_queue.case_id;
    END IF;

    -- Strict Tenant Match Check: Diagnostic case tenant must match review queue tenant
    IF v_case.tenant_id IS DISTINCT FROM v_queue.tenant_id THEN
      RAISE EXCEPTION 'Diagnostic case % tenant % does not match review queue tenant %', v_case.id, v_case.tenant_id, v_queue.tenant_id;
    END IF;

    -- Consent and verified contributor terms check:
    IF v_case.tenant_id IS NOT NULL THEN
      IF NOT COALESCE(v_case.case_learning_opt_in, false) THEN
        RAISE EXCEPTION 'Case-level learning consent was not granted or was withdrawn';
      END IF;

      IF v_case.learning_terms_version IS NULL AND v_case.legal_terms_version IS NULL THEN
        RAISE EXCEPTION 'Verified contributor terms acceptance is required for case learning approval';
      END IF;

      -- Check durable case-specific learning consent record
      IF NOT EXISTS (
        SELECT 1 FROM public.case_learning_consents
        WHERE case_id = v_case.id AND consent_status = 'granted' AND company_id = v_case.tenant_id
      ) THEN
        RAISE EXCEPTION 'Durable case-specific learning consent record is missing or withdrawn';
      END IF;

      -- Verify authenticated contributor provenance
      IF v_case.contributor_user_id IS NULL OR v_case.contributor_accepted_at IS NULL THEN
        RAISE EXCEPTION 'Authenticated contributor consent provenance is required for case learning approval';
      END IF;

      -- Recheck governing company consent
      SELECT diagnostic_learning_opt_in INTO v_company_opted_in
      FROM public.companies
      WHERE id = v_case.tenant_id;

      IF NOT COALESCE(v_company_opted_in, false) THEN
        RAISE EXCEPTION 'Governing company diagnostic learning opt-in is required';
      END IF;
    ELSE
      RAISE EXCEPTION 'Public demo visitor-reported answers cannot be published as verified shared repair knowledge';
    END IF;

    -- P0 Evidence Gate 3: Model-generated troubleshooter suggestions without technician verification
    -- CANNOT become established verified repairs solely because a platform reviewer approved it.
    IF v_queue.source_kind = 'authenticated_troubleshooter' AND NOT COALESCE(v_case.technician_verified, false) THEN
      RAISE EXCEPTION 'Model-generated authenticated_troubleshooter suggestion without technician verification cannot be published as shared repair knowledge';
    END IF;

    -- P0 Evidence Gate 4: Authoritative Outcome Check: Case status must be 'resolved'
    IF v_queue.source_kind IN ('technician_job', 'authenticated_troubleshooter') THEN
      IF v_case.case_status <> 'resolved' THEN
        RAISE EXCEPTION 'Only a resolved case with status resolved can become shared repair knowledge (current status: %)', v_case.case_status;
      END IF;
      IF NOT COALESCE(v_case.technician_verified, false) OR COALESCE(trim(v_case.resolution_summary_redacted), '') = '' THEN
        RAISE EXCEPTION 'Only a resolved technician-verified case with a recorded outcome can become shared repair knowledge';
      END IF;
    END IF;

    v_equipment_category := v_case.equipment_category;
    v_manufacturer_normalized := v_case.manufacturer_normalized;
    v_model_normalized := v_case.model_normalized;
    v_technician_verified := COALESCE(v_case.technician_verified, false);
    v_knowledge_type := CASE
      WHEN v_technician_verified THEN 'verified_repair'
      ELSE 'observed_diagnosis'
    END;
  ELSE
    RAISE EXCEPTION 'Review queue item % has no associated case or manual source', p_queue_id;
  END IF;

  -- Upsert into shared_learning_knowledge atomically with exact metadata provenance, manual ID, and verification status
  INSERT INTO public.shared_learning_knowledge (
    source_case_id,
    source_queue_id,
    source_company_id,
    source_manual_id,
    source_kind,
    equipment_category,
    manufacturer_normalized,
    model_normalized,
    lesson_redacted,
    approved_by,
    consent_snapshot,
    knowledge_type,
    technician_verified,
    publication_status,
    review_history
  ) VALUES (
    v_queue.case_id,
    v_queue.id,
    v_queue.tenant_id,
    v_manual_id,
    v_queue.source_kind,
    v_equipment_category,
    v_manufacturer_normalized,
    v_model_normalized,
    p_lesson,
    p_reviewed_by,
    true,
    v_knowledge_type,
    v_technician_verified,
    'active',
    jsonb_build_array(jsonb_build_object(
      'action', 'approved',
      'actor', p_reviewed_by,
      'at', now(),
      'note', p_review_note,
      'knowledge_type', v_knowledge_type,
      'technician_verified', v_technician_verified
    ))
  )
  ON CONFLICT (source_queue_id) DO UPDATE SET
    lesson_redacted = EXCLUDED.lesson_redacted,
    equipment_category = EXCLUDED.equipment_category,
    manufacturer_normalized = EXCLUDED.manufacturer_normalized,
    model_normalized = EXCLUDED.model_normalized,
    source_manual_id = EXCLUDED.source_manual_id,
    approved_by = EXCLUDED.approved_by,
    consent_snapshot = true,
    knowledge_type = EXCLUDED.knowledge_type,
    technician_verified = EXCLUDED.technician_verified,
    publication_status = 'active',
    review_history = public.shared_learning_knowledge.review_history || EXCLUDED.review_history;

  -- Mark case approved if present
  IF v_queue.case_id IS NOT NULL THEN
    UPDATE public.diagnostic_cases
    SET approved_for_learning = true, privacy_reviewed_at = now()
    WHERE id = v_queue.case_id;
  END IF;

  -- Mark queue item approved
  UPDATE public.learning_review_queue
  SET status = 'approved', reviewed_by = p_reviewed_by, reviewed_at = now()
  WHERE id = p_queue_id;

  -- Insert audit trail record
  INSERT INTO public.learning_review_audit (
    queue_id,
    case_id,
    actor_user_id,
    action,
    note_redacted
  ) VALUES (
    p_queue_id,
    v_queue.case_id,
    p_reviewed_by,
    'approved',
    p_review_note
  );

  RETURN jsonb_build_object(
    'ok', true,
    'queue_id', p_queue_id,
    'case_id', v_queue.case_id,
    'source_kind', v_queue.source_kind,
    'source_manual_id', v_manual_id,
    'equipment_category', v_equipment_category,
    'manufacturer_normalized', v_manufacturer_normalized,
    'model_normalized', v_model_normalized,
    'knowledge_type', v_knowledge_type,
    'technician_verified', v_technician_verified,
    'status', 'approved'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_approve_learning_case(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_approve_learning_case(uuid, text, uuid, text) TO service_role;

-- 5. Replace search_shared_learning:
--    - Enforces read-side verification, manual-level consent, and active case consent
--    - Restricts actionable procedure retrieval to verified repairs and eligible manufacturer manuals
--    - Excludes observed_diagnosis and unconfirmed_suggestion
DROP FUNCTION IF EXISTS public.search_shared_learning(text, integer);

CREATE OR REPLACE FUNCTION public.search_shared_learning(
  p_query text,
  p_limit integer DEFAULT 4
)
RETURNS TABLE(
  id uuid,
  equipment_category text,
  manufacturer_normalized text,
  model_normalized text,
  lesson_redacted text,
  source_kind text,
  knowledge_type text,
  technician_verified boolean,
  publication_status text,
  rank real
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT
    k.id,
    k.equipment_category,
    k.manufacturer_normalized,
    k.model_normalized,
    k.lesson_redacted,
    k.source_kind,
    COALESCE(k.knowledge_type, CASE WHEN k.source_kind = 'company_manual' THEN 'manufacturer_manual' WHEN k.source_kind = 'technician_job' THEN 'verified_repair' ELSE 'observed_diagnosis' END) AS knowledge_type,
    COALESCE(k.technician_verified, false) AS technician_verified,
    COALESCE(k.publication_status, 'active') AS publication_status,
    ts_rank(
      to_tsvector('english', coalesce(k.equipment_category, '') || ' ' || coalesce(k.manufacturer_normalized, '') || ' ' || coalesce(k.model_normalized, '') || ' ' || k.lesson_redacted),
      websearch_to_tsquery('english', coalesce(left(p_query, 1800), ''))
    ) AS rank
  FROM public.shared_learning_knowledge k
  LEFT JOIN public.companies c ON c.id = k.source_company_id
  LEFT JOIN public.diagnostic_cases dc ON dc.id = k.source_case_id
  LEFT JOIN public.company_manuals cm ON cm.id = k.source_manual_id
  WHERE
    to_tsvector('english', coalesce(k.equipment_category, '') || ' ' || coalesce(k.manufacturer_normalized, '') || ' ' || coalesce(k.model_normalized, '') || ' ' || k.lesson_redacted)
      @@ websearch_to_tsquery('english', coalesce(left(p_query, 1800), ''))
    -- Must be actively published (not revoked or quarantined)
    AND COALESCE(k.publication_status, 'active') = 'active'
    -- Actionable repair procedure retrieval is strictly restricted to verified repairs and manufacturer manuals
    AND k.knowledge_type IN ('verified_repair', 'manufacturer_manual')
    AND COALESCE(k.knowledge_type, 'observed_diagnosis') <> 'observed_diagnosis'
    AND COALESCE(k.knowledge_type, 'observed_diagnosis') <> 'unconfirmed_suggestion'
    -- Authenticated troubleshooter entries strictly require technician verification
    AND (k.source_kind <> 'authenticated_troubleshooter' OR COALESCE(k.technician_verified, false) = true)
    -- Company-backed knowledge strictly requires that the source company remains active and opted in
    AND (k.source_company_id IS NULL OR (c.status IN ('active', 'pilot') AND COALESCE(c.diagnostic_learning_opt_in, false) = true))
    -- Per-document company manual consent check: if manual consent is revoked or manual is disabled, exclude immediately
    AND (k.source_kind <> 'company_manual' OR (cm.id IS NOT NULL AND COALESCE(cm.shared_learning_opt_in, false) = true AND COALESCE(cm.reference_enabled, true) = true AND cm.extraction_status = 'ready'))
    -- Case-backed knowledge strictly requires active case-level learning consent and active durable consent record
    AND (k.source_case_id IS NULL OR (
      COALESCE(dc.case_learning_opt_in, false) = true
      AND EXISTS (
        SELECT 1 FROM public.case_learning_consents clc
        WHERE clc.case_id = k.source_case_id AND clc.consent_status = 'granted'
      )
    ))
  ORDER BY rank DESC
  LIMIT least(greatest(coalesce(p_limit, 4), 1), 8);
$$;

REVOKE ALL ON FUNCTION public.search_shared_learning(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_shared_learning(text, integer) TO service_role;

-- 6. Safe Historical Re-Review & Revocation Hygiene:
-- Revoke retrieval eligibility for any historical unverified authenticated_troubleshooter entries
UPDATE public.shared_learning_knowledge
SET
  publication_status = 'revoked',
  knowledge_type = 'unconfirmed_suggestion',
  review_history = review_history || jsonb_build_array(jsonb_build_object(
    'action', 'revoked_safety_audit',
    'reason', 'TASK-012 Part-1 P0 Trust Boundary Enforcement: Model-generated AI suggestions without independent technician verification cannot be shared repair knowledge',
    'at', now()
  ))
WHERE
  source_kind = 'authenticated_troubleshooter'
  AND (technician_verified IS NOT TRUE OR technician_verified IS NULL);

-- Reject any pending review queue items for unverified AI suggestions
UPDATE public.learning_review_queue
SET
  status = 'rejected',
  reviewed_at = now()
WHERE
  source_kind = 'authenticated_troubleshooter'
  AND status = 'pending';

COMMIT;

