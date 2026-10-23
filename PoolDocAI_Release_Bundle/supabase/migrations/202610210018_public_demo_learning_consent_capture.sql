-- Migration 018: explicit public-demo/widget learning notice and privacy-minimized case capture.
-- Additive: does not change existing accounts, company cases, or published knowledge.
create extension if not exists pgcrypto;

create table if not exists public.pooldocai_public_demo_learning_acceptances (
  session_hash text primary key check (session_hash ~ '^[a-f0-9]{64}$'),
  terms_version text not null,
  privacy_version text not null,
  notice_version text not null,
  acceptance_source text not null check (acceptance_source in ('public_demo','customer_widget')),
  demo_mode text not null check (demo_mode in ('homeowner','field-tech')),
  accepted_terms boolean not null check (accepted_terms = true),
  acknowledged_privacy boolean not null check (acknowledged_privacy = true),
  acknowledged_diagnostic_learning boolean not null check (acknowledged_diagnostic_learning = true),
  accepted_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
alter table public.pooldocai_public_demo_learning_acceptances enable row level security;
revoke all on public.pooldocai_public_demo_learning_acceptances from public, anon, authenticated;
grant all on public.pooldocai_public_demo_learning_acceptances to service_role;

create table if not exists public.public_demo_learning_events (
  id uuid primary key default gen_random_uuid(),
  session_hash text not null references public.pooldocai_public_demo_learning_acceptances(session_hash) on delete cascade,
  turn_id text not null check (length(turn_id) between 8 and 160),
  demo_mode text not null check (demo_mode in ('homeowner','field-tech')),
  user_message_redacted text not null default '',
  assistant_response_redacted text not null default '',
  outcome_status text not null default 'in_progress' check (outcome_status in ('in_progress','customer_reported_resolved','unresolved','technician_handoff')),
  created_at timestamptz not null default now(),
  unique(session_hash, turn_id),
  check (length(user_message_redacted) <= 1800),
  check (length(assistant_response_redacted) <= 3600)
);
create index if not exists public_demo_learning_events_session_idx on public.public_demo_learning_events(session_hash, created_at);
alter table public.public_demo_learning_events enable row level security;
revoke all on public.public_demo_learning_events from public, anon, authenticated;
grant all on public.public_demo_learning_events to service_role;
comment on table public.pooldocai_public_demo_learning_acceptances is 'Versioned acceptance of Terms, Privacy notice, and general-knowledge learning disclosure for public demo/customer-widget sessions. Only opaque session digests are stored.';
comment on table public.public_demo_learning_events is 'Privacy-minimized public demo/widget troubleshooting turn evidence. Raw session IDs, direct identifiers, and image bytes must never be stored.';

-- Allow the public-demo case source in the review queue while retaining the same human approval gate.
alter table public.learning_review_queue drop constraint if exists learning_review_queue_source_kind_check;
alter table public.learning_review_queue add constraint learning_review_queue_source_kind_check
  check (source_kind in ('diagnostic_case','technician_job','authenticated_troubleshooter','company_manual','public_demo'));

-- Public demo cases can be indexed by a one-way session digest; no company tenant is assigned.
create unique index if not exists diagnostic_cases_public_session_uidx
  on public.diagnostic_cases(client_session_id)
  where tenant_id is null and client_session_id is not null;
