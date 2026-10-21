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
