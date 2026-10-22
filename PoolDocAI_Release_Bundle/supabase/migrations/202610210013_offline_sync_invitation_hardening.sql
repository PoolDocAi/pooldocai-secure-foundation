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
