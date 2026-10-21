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
