-- Migration 017: document upload rights attestation and private-only company SOP/policy guard.
-- Additive. Existing company documents default to private and are not newly shared.
create extension if not exists pgcrypto;

alter table public.company_manuals
  add column if not exists rights_attested_at timestamptz,
  add column if not exists rights_attested_by uuid references auth.users(id) on delete set null,
  add column if not exists knowledge_scope text not null default 'company_private',
  add column if not exists general_learning_rights_attested boolean not null default false;

-- Normalize older company-specific manuals/SOP/policy documents before adding a validated check constraint.
update public.company_manuals set shared_learning_opt_in=false, knowledge_scope='company_private'
where (lower(coalesce(document_type,'')) in ('company_manual','sop','policy') and (shared_learning_opt_in=true or knowledge_scope <> 'company_private'))
   or (shared_learning_opt_in=true and (general_learning_rights_attested=false or knowledge_scope <> 'general_candidate'));

do $$ begin
  if not exists (select 1 from pg_constraint where conname='company_manuals_knowledge_scope_allowed') then
    alter table public.company_manuals add constraint company_manuals_knowledge_scope_allowed
      check (knowledge_scope in ('company_private','general_candidate'));
  end if;
  if not exists (select 1 from pg_constraint where conname='company_sop_policy_never_general') then
    alter table public.company_manuals add constraint company_sop_policy_never_general
      check (not (lower(coalesce(document_type,'')) in ('company_manual','sop','policy') and (knowledge_scope <> 'company_private' or shared_learning_opt_in = true)));
  end if;
  if not exists (select 1 from pg_constraint where conname='company_manual_general_rights_attestation_required') then
    alter table public.company_manuals add constraint company_manual_general_rights_attestation_required
      check (shared_learning_opt_in = false or (knowledge_scope = 'general_candidate' and general_learning_rights_attested = true));
  end if;
end $$;

-- Remove any related shared-learning queue/publication records before release.
update public.learning_review_queue q set status='rejected', reviewed_at=now(),
  evidence_summary_redacted=left(concat_ws(' ', evidence_summary_redacted, 'Uploader did not record explicit general-knowledge redistribution rights; private reference retained.'),1200)
where q.source_kind='company_manual' and exists (
  select 1 from public.company_manuals m where q.tenant_id=m.company_id and q.supporting_source_ids @> array[m.id::text]
    and m.shared_learning_opt_in=false
) and q.status in ('pending','approved');

delete from public.shared_learning_knowledge k
where k.source_kind='company_manual' and exists (
  select 1 from public.learning_review_queue q join public.company_manuals m
    on q.tenant_id=m.company_id and q.supporting_source_ids @> array[m.id::text]
  where q.id=k.source_queue_id and m.shared_learning_opt_in=false
);

update public.learning_review_queue q set status='rejected', reviewed_at=now(),
  evidence_summary_redacted=left(concat_ws(' ', evidence_summary_redacted, 'Private-only company-specific manual/SOP/policy; removed from shared-learning eligibility by migration 017.'),1200)
where q.source_kind='company_manual' and exists (
  select 1 from public.company_manuals m
  where lower(coalesce(m.document_type,'')) in ('sop','policy')
    and q.tenant_id=m.company_id and q.supporting_source_ids @> array[m.id::text]
) and q.status in ('pending','approved');

delete from public.shared_learning_knowledge k
where k.source_kind='company_manual' and exists (
  select 1 from public.learning_review_queue q join public.company_manuals m
    on q.tenant_id=m.company_id and q.supporting_source_ids @> array[m.id::text]
  where q.id=k.source_queue_id and lower(coalesce(m.document_type,'')) in ('sop','policy')
);

comment on column public.company_manuals.rights_attested_at is 'Timestamp when uploader affirmed they have rights to upload and authorize the selected processing.';
comment on column public.company_manuals.rights_attested_by is 'Authenticated uploader who made the rights attestation.';
comment on column public.company_manuals.knowledge_scope is 'Company documents default to company_private. General candidate is reserved for eligible non-confidential material and still requires platform-owner approval.';
comment on column public.company_manuals.general_learning_rights_attested is 'Uploader explicitly attested to sufficient rights for eligible non-confidential content to be proposed for the general knowledge base.';

-- Bind each diagnostic case to the accepted terms version before it can be considered for shared learning.
alter table public.diagnostic_cases
  add column if not exists learning_permission_granted boolean not null default false,
  add column if not exists legal_terms_version text,
  add column if not exists created_by uuid references auth.users(id) on delete set null;

-- Versioned agreement acceptance for authenticated company workspace access.
create table if not exists public.pooldocai_legal_acceptances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  terms_version text not null,
  privacy_version text not null,
  accepted_at timestamptz not null default now(),
  acceptance_source text not null default 'authenticated_workspace',
  unique(user_id, company_id, terms_version, privacy_version)
);
alter table public.pooldocai_legal_acceptances enable row level security;
revoke all on public.pooldocai_legal_acceptances from public, anon, authenticated;
grant all on public.pooldocai_legal_acceptances to service_role;
create index if not exists pooldocai_legal_acceptances_company_idx on public.pooldocai_legal_acceptances(company_id, accepted_at desc);
comment on table public.pooldocai_legal_acceptances is 'Versioned terms/privacy acceptance records. Access only through the authenticated server-side handler.';

-- The current policy is governed by each user's versioned agreement acceptance and case-level permission snapshot.
-- Retire the former company opt-in trigger so an obsolete flag cannot silently erase approved diagnostic lessons.
drop trigger if exists companies_diagnostic_learning_consent_audit on public.companies;
comment on column public.companies.diagnostic_learning_opt_in is 'Legacy field retained for compatibility only. Current diagnostic learning eligibility is tied to versioned user agreement acceptance recorded on each case and platform-owner review.';

-- Enforce the uploader attestation at the database boundary, not only in the website.
create or replace function public.pooldocai_enforce_manual_rights_scope()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if tg_op = 'INSERT' then
    if auth.uid() is not null and not exists (
      select 1 from public.pooldocai_legal_acceptances a
      where a.user_id=auth.uid() and a.company_id=new.company_id
        and a.terms_version='2026-10-21-v1' and a.privacy_version='2026-10-21-v1'
    ) then
      raise exception 'Accept current PoolDocAI Terms and Privacy Policy before uploading company documents';
    end if;
    if new.rights_attested_at is null or new.rights_attested_by is null then
      raise exception 'Document upload requires a recorded uploader-rights attestation';
    end if;
    if auth.uid() is not null and new.rights_attested_by is distinct from auth.uid() then
      raise exception 'Document rights attestation must be made by the authenticated uploader';
    end if;
  end if;
  if new.shared_learning_opt_in = true then
    if new.rights_attested_at is null or new.rights_attested_by is null then
      raise exception 'Shared-learning candidate requires an uploader-rights attestation';
    end if;
    if new.general_learning_rights_attested is distinct from true or new.knowledge_scope <> 'general_candidate' then
      raise exception 'General knowledge requires separate redistribution-rights attestation and general_candidate scope';
    end if;
    if lower(coalesce(new.document_type,'')) in ('company_manual','sop','policy') then
      raise exception 'Company-specific manuals, SOPs, and policies must remain private';
    end if;
  end if;
  return new;
end; $$;
revoke all on function public.pooldocai_enforce_manual_rights_scope() from public,anon,authenticated;
drop trigger if exists company_manuals_enforce_rights_scope on public.company_manuals;
create trigger company_manuals_enforce_rights_scope
before insert or update on public.company_manuals
for each row execute function public.pooldocai_enforce_manual_rights_scope();
comment on function public.pooldocai_enforce_manual_rights_scope() is 'Database-level guard for uploader rights attestation and private-only company documents.';
