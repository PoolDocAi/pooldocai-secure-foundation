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
