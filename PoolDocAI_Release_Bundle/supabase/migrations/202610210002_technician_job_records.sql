-- Technician-entered job records. Identity/contact fields are intentionally absent.
create table if not exists public.technician_job_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  case_status text not null default 'open' check (case_status in ('open','resolved','unresolved','technician_handoff')),
  job_reference_redacted text,
  equipment_category text,
  manufacturer_normalized text,
  model_normalized text,
  complaint_redacted text not null default '',
  diagnostic_notes_redacted text not null default '',
  repair_steps_redacted jsonb not null default '[]'::jsonb,
  resolution_summary_redacted text not null default '',
  outcome text not null default 'in_progress' check (outcome in ('in_progress','resolved','unresolved','follow_up_required','parts_required')),
  related_case_id uuid references public.diagnostic_cases(id) on delete set null,
  voice_transcribed boolean not null default false,
  source text not null default 'technician_manual' check (source in ('technician_manual','troubleshooter')),
  technician_verified boolean not null default true,
  approved_for_learning boolean not null default false,
  privacy_reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tech_job_text_limits check (
    (job_reference_redacted is null or length(job_reference_redacted) <= 120) and length(complaint_redacted) <= 1500 and length(diagnostic_notes_redacted) <= 4000 and
    length(resolution_summary_redacted) <= 3000 and jsonb_typeof(repair_steps_redacted) = 'array'
  )
);
create index if not exists technician_job_records_created_at_idx on public.technician_job_records (created_at desc);
create index if not exists technician_job_records_related_case_idx on public.technician_job_records (related_case_id) where related_case_id is not null;
alter table public.technician_job_records enable row level security;
revoke all on public.technician_job_records from anon, authenticated;
grant all on public.technician_job_records to service_role;
comment on table public.technician_job_records is 'PII-minimized technician-entered job notes, including jobs that did not use AI troubleshooting. Human review required before approved_for_learning is enabled.';
