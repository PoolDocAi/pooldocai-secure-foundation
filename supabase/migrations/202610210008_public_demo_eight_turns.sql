-- Increase the server-enforced public demo allowance to eight turns per opaque session.
-- Frontend mode-specific session IDs keep Homeowner Triage and Field Tech Mobile App allowances separate.
-- Existing session counters are preserved; no company, user, or learning data is deleted.

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
  s public.public_demo_sessions%rowtype;
  already_used boolean;
begin
  insert into public.public_demo_sessions(session_hash, turns_used, window_started_at, updated_at)
  values (p_session_hash, 0, now(), now())
  on conflict (session_hash) do nothing;

  select * into s
  from public.public_demo_sessions
  where session_hash = p_session_hash
  for update;

  if s.window_started_at < now() - make_interval(hours => greatest(1, p_window_hours)) then
    update public.public_demo_sessions
       set turns_used = 0, window_started_at = now(), updated_at = now()
     where session_hash = p_session_hash
     returning * into s;
  end if;

  select exists (
    select 1
    from public.public_demo_turns
    where session_hash = p_session_hash
      and turn_id = p_turn_id
      and created_at >= s.window_started_at
  ) into already_used;

  if already_used then
    return query select true, s.turns_used;
    return;
  end if;

  if s.turns_used >= least(greatest(p_max_turns, 1), 8) then
    return query select false, s.turns_used;
    return;
  end if;

  insert into public.public_demo_turns(session_hash, turn_id)
  values (p_session_hash, p_turn_id)
  on conflict do nothing;

  update public.public_demo_sessions
     set turns_used = turns_used + 1, updated_at = now()
   where session_hash = p_session_hash
   returning * into s;

  return query select true, s.turns_used;
end;
$$;

revoke all on function public.pooldocai_consume_public_demo_turn(text, text, integer, integer) from public;
grant execute on function public.pooldocai_consume_public_demo_turn(text, text, integer, integer) to service_role;

comment on function public.pooldocai_consume_public_demo_turn(text, text, integer, integer)
is 'Atomically consumes a unique public demo turn, with an enforced maximum of eight turns per mode-specific session in the configured window.';
