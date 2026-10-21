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
