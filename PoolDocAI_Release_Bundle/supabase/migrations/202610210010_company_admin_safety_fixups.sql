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
