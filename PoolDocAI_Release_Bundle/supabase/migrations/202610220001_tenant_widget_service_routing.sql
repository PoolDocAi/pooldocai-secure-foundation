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
