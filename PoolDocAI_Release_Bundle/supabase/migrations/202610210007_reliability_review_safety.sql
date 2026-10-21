-- Reliability, queue performance, and safety metadata. Safe additive migration.
create extension if not exists pgcrypto;

-- Enforce known states even if a prior schema was created without a CHECK constraint.
do $$ begin
 if not exists (select 1 from pg_constraint where conname='document_processing_jobs_status_allowed') then
  alter table public.document_processing_jobs add constraint document_processing_jobs_status_allowed check(status in ('queued','processing','ready','failed'));
 end if;
 if not exists (select 1 from pg_constraint where conname='learning_review_queue_status_allowed') then
  alter table public.learning_review_queue add constraint learning_review_queue_status_allowed check(status in ('pending','approved','rejected'));
 end if;
end $$;

create index if not exists learning_review_queue_tenant_status_created_idx on public.learning_review_queue(tenant_id,status,created_at desc);
create index if not exists learning_review_queue_status_created_idx on public.learning_review_queue(status,created_at desc);
create index if not exists diagnostic_cases_tenant_created_idx on public.diagnostic_cases(tenant_id,created_at desc);
create index if not exists technician_job_records_tenant_created_idx on public.technician_job_records(tenant_id,created_at desc);

-- Explicitly prevent browser roles from bypassing the reviewed shared-knowledge path.
alter table public.shared_learning_knowledge enable row level security;
revoke all on public.shared_learning_knowledge from public,anon,authenticated;
grant all on public.shared_learning_knowledge to service_role;

-- Record safety flags for proposed shared lessons; a flag is advisory metadata, never auto-approval.
alter table public.learning_review_queue add column if not exists safety_flags text[] not null default '{}';
alter table public.learning_review_queue add column if not exists updated_at timestamptz not null default now();
create or replace function public.pooldocai_review_queue_touch_updated_at() returns trigger language plpgsql set search_path=public,pg_temp as $$ begin new.updated_at=now(); return new; end $$;
drop trigger if exists learning_review_queue_touch_updated_at on public.learning_review_queue;
create trigger learning_review_queue_touch_updated_at before update on public.learning_review_queue for each row execute function public.pooldocai_review_queue_touch_updated_at();

-- Manufacturer/category tags support later service and warranty trend reporting.
alter table public.company_manuals add column if not exists manufacturer_normalized text;
alter table public.company_manuals add column if not exists equipment_category text;
create index if not exists company_manuals_company_manufacturer_idx on public.company_manuals(company_id,manufacturer_normalized,equipment_category);
