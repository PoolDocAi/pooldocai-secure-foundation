-- Migration 016: durable diagnostic learning sessions, explicit company consent, and workflow-evaluation outcomes.
-- Additive and forward-only. Existing cases, memberships, companies, and approved knowledge remain intact.
create extension if not exists pgcrypto;

alter table public.diagnostic_cases
  add column if not exists client_session_id text,
  add column if not exists outcome_status text not null default 'in_progress',
  add column if not exists outcome_evidence_redacted text,
  add column if not exists last_activity_at timestamptz not null default now();

do $$ begin
  if not exists (select 1 from pg_constraint where conname='diagnostic_cases_outcome_status_allowed') then
    alter table public.diagnostic_cases add constraint diagnostic_cases_outcome_status_allowed
      check (outcome_status in ('in_progress','customer_reported_resolved','technician_confirmed_diagnosis','verified_repair','unresolved','technician_handoff'));
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname='diagnostic_cases_client_session_id_format') then
    alter table public.diagnostic_cases add constraint diagnostic_cases_client_session_id_format
      check (client_session_id is null or client_session_id ~ '^[A-Za-z0-9_-]{8,80}$');
  end if;
end $$;
create unique index if not exists diagnostic_cases_tenant_client_session_uidx
  on public.diagnostic_cases(tenant_id, client_session_id) where client_session_id is not null and tenant_id is not null;
create index if not exists diagnostic_cases_outcome_recent_idx on public.diagnostic_cases(tenant_id,outcome_status,last_activity_at desc);

alter table public.diagnostic_case_steps add column if not exists turn_metadata jsonb not null default '{}'::jsonb;
alter table public.learning_review_queue add column if not exists outcome_status text;
alter table public.learning_review_queue add column if not exists workflow_version text;
alter table public.learning_review_queue add column if not exists evidence_summary_redacted text;

alter table public.companies
  add column if not exists diagnostic_learning_opt_in boolean not null default false,
  add column if not exists diagnostic_learning_consent_updated_at timestamptz,
  add column if not exists diagnostic_learning_consent_updated_by uuid references auth.users(id) on delete set null;

create table if not exists public.diagnostic_learning_consent_audit (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  old_opt_in boolean not null,
  new_opt_in boolean not null,
  created_at timestamptz not null default now()
);
alter table public.diagnostic_learning_consent_audit enable row level security;
revoke all on public.diagnostic_learning_consent_audit from public, anon, authenticated;
grant all on public.diagnostic_learning_consent_audit to service_role;

alter table public.learning_review_audit drop constraint if exists learning_review_audit_action_check;
alter table public.learning_review_audit add constraint learning_review_audit_action_check
  check (action in ('approved','rejected','reopened','consent_withdrawn'));

create or replace function public.pooldocai_audit_diagnostic_learning_consent()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.diagnostic_learning_opt_in is distinct from old.diagnostic_learning_opt_in then
    new.diagnostic_learning_consent_updated_at := now();
    new.diagnostic_learning_consent_updated_by := auth.uid();
    insert into public.diagnostic_learning_consent_audit(company_id,actor_user_id,old_opt_in,new_opt_in)
    values(new.id,auth.uid(),old.diagnostic_learning_opt_in,new.diagnostic_learning_opt_in);
    if old.diagnostic_learning_opt_in and not new.diagnostic_learning_opt_in then
      -- Withdrawal immediately removes this company's case-derived lessons from shared RAG.
      insert into public.learning_review_audit(queue_id,case_id,actor_user_id,action,note_redacted)
      select q.id,q.case_id,auth.uid(),'consent_withdrawn','Company withdrew diagnostic shared-learning consent; shared publication revoked.'
      from public.learning_review_queue q
      where q.tenant_id=new.id and q.source_kind <> 'company_manual' and q.status in ('pending','approved');
      update public.learning_review_queue q set status='rejected',reviewed_by=auth.uid(),reviewed_at=now()
      where q.tenant_id=new.id and q.source_kind <> 'company_manual' and q.status='pending';
      update public.diagnostic_cases c set approved_for_learning=false,privacy_reviewed_at=null
      where c.tenant_id=new.id and c.approved_for_learning=true;
      delete from public.shared_learning_knowledge k where k.source_company_id=new.id and k.source_kind <> 'company_manual';
    end if;
  end if;
  return new;
end; $$;
revoke all on function public.pooldocai_audit_diagnostic_learning_consent() from public,anon,authenticated;
drop trigger if exists companies_diagnostic_learning_consent_audit on public.companies;
create trigger companies_diagnostic_learning_consent_audit before update of diagnostic_learning_opt_in on public.companies
for each row execute function public.pooldocai_audit_diagnostic_learning_consent();

-- Store workflow feedback separately from reusable knowledge. Feedback is evidence for future
-- workflow evaluation only; it is never published to retrieval or model training automatically.
create table if not exists public.diagnostic_workflow_feedback (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.diagnostic_cases(id) on delete cascade,
  tenant_id uuid references public.companies(id) on delete set null,
  workflow_key text,
  workflow_version text,
  feedback_type text not null check (feedback_type in ('helpful','not_helpful','wrong_branch','missing_question','unsafe','resolved','unresolved','handoff_needed')),
  note_redacted text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (note_redacted is null or length(note_redacted) <= 1200)
);
create index if not exists diagnostic_workflow_feedback_tenant_recent_idx on public.diagnostic_workflow_feedback(tenant_id,created_at desc);
alter table public.diagnostic_workflow_feedback enable row level security;
revoke all on public.diagnostic_workflow_feedback from public,anon,authenticated;
grant all on public.diagnostic_workflow_feedback to service_role;

comment on column public.companies.diagnostic_learning_opt_in is 'Explicit company-wide consent for redacted diagnostic case outcomes to be considered for shared learning. Defaults off; distinct from private company retrieval and per-document consent.';
comment on table public.diagnostic_workflow_feedback is 'Evaluation signals for improving diagnostic workflows. Never automatically published as knowledge or used for fine-tuning.';
