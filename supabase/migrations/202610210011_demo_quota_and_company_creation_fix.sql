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
