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
