-- Separate company reference use from optional shared-learning consent.
-- Uploaded files remain company-private and reference-enabled by default.
alter table public.company_manuals
  add column if not exists reference_enabled boolean not null default true,
  add column if not exists shared_learning_opt_in boolean not null default false,
  add column if not exists learning_consent_updated_at timestamptz;

comment on column public.company_manuals.reference_enabled is 'When true, this file is eligible as a private, company-specific troubleshooting reference regardless of shared-learning consent.';
comment on column public.company_manuals.shared_learning_opt_in is 'Explicit company-admin consent for eligible extracted content from this file to contribute to the shared learning loop. Defaults off.';

-- Case records created from technician notes or authenticated troubleshooting are queued
-- for privacy review automatically; they are not automatically approved for shared reuse.
alter table public.learning_review_queue
  add column if not exists source_kind text not null default 'diagnostic_case',
  add column if not exists tenant_id uuid references public.companies(id) on delete set null;

alter table public.learning_review_queue
  drop constraint if exists learning_review_queue_source_kind_check;
alter table public.learning_review_queue
  add constraint learning_review_queue_source_kind_check
  check (source_kind in ('diagnostic_case','technician_job','authenticated_troubleshooter','company_manual'));

create index if not exists company_manuals_reference_enabled_idx
  on public.company_manuals(company_id, reference_enabled) where reference_enabled = true;
create index if not exists learning_review_queue_tenant_created_idx
  on public.learning_review_queue(tenant_id, created_at desc);
