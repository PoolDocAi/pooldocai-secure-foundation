-- PoolDocAI feature expansion: invitation lifecycle, Stripe preparation, usage metering,
-- semantic retrieval, page citations, offline idempotency, and modular industry profiles.
-- Forward-only and additive. Existing companies, Auth users, seats, jobs, manuals and cases remain.

create extension if not exists pgcrypto;
create schema if not exists extensions;
create extension if not exists vector with schema extensions;

-- Industry modules are a reusable configuration layer. Pool is enabled; HVAC/plumbing
-- records are intentionally planned until their catalogs, workflows, and safety rules are reviewed.
create table if not exists public.industry_modules (
  industry_key text primary key,
  display_name text not null,
  status text not null default 'planned' check (status in ('active','planned','disabled')),
  module_version integer not null default 1 check (module_version > 0),
  configuration jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into public.industry_modules(industry_key,display_name,status,module_version,configuration) values
 ('pool','Swimming Pools','active',1,'{"default_source_order":["company_manual","approved_shared_knowledge","official_manufacturer_web","general_web"],"categories":["pump","heater","filter","salt system","automation","cleaner","water chemistry"],"safety_profile":"pool"}'::jsonb),
 ('hvac','HVAC','planned',1,'{"requires_review_before_activation":true,"safety_profile":"hvac"}'::jsonb),
 ('plumbing','Plumbing','planned',1,'{"requires_review_before_activation":true,"safety_profile":"plumbing"}'::jsonb)
on conflict (industry_key) do nothing;

create table if not exists public.industry_equipment_catalog (
  id uuid primary key default gen_random_uuid(),
  industry_key text not null references public.industry_modules(industry_key) on delete cascade,
  equipment_code text not null,
  display_name text not null,
  manufacturer text,
  model_family text,
  attributes jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(industry_key,equipment_code,manufacturer,model_family)
);
create table if not exists public.industry_diagnostic_workflows (
  id uuid primary key default gen_random_uuid(),
  industry_key text not null references public.industry_modules(industry_key) on delete cascade,
  workflow_key text not null,
  display_name text not null,
  rules jsonb not null default '{}'::jsonb,
  safety_class text not null default 'normal' check (safety_class in ('normal','caution','qualified_technician','emergency_stop')),
  active boolean not null default false,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(industry_key,workflow_key,version)
);
create table if not exists public.industry_safety_rules (
  id uuid primary key default gen_random_uuid(),
  industry_key text not null references public.industry_modules(industry_key) on delete cascade,
  rule_key text not null,
  rule_text text not null,
  severity text not null default 'warning' check (severity in ('info','warning','qualified_technician','emergency_stop')),
  non_bypassable boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(industry_key,rule_key)
);
create table if not exists public.industry_source_ranking_rules (
  id uuid primary key default gen_random_uuid(),
  industry_key text not null references public.industry_modules(industry_key) on delete cascade,
  source_type text not null,
  priority integer not null check (priority between 1 and 1000),
  require_authoritative boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique(industry_key,source_type)
);
insert into public.industry_source_ranking_rules(industry_key,source_type,priority,require_authoritative) values
 ('pool','company_manual',10,false),('pool','approved_shared_knowledge',20,false),('pool','official_manufacturer_web',30,true),('pool','general_web',50,true)
on conflict (industry_key,source_type) do nothing;
insert into public.industry_safety_rules(industry_key,rule_key,rule_text,severity,non_bypassable) values
 ('pool','chemical_mixing','Never mix pool chemicals. Keep acid products separate from chlorine products and follow each product label.', 'emergency_stop', true),
 ('pool','energized_equipment','Do not direct homeowners to work on energized equipment, internal electrical parts, gas trains, or bypassed safety switches.', 'qualified_technician', true),
 ('pool','pressurized_filter','Never open a filter or pressure vessel until the equipment is isolated and manufacturer safe-depressurization steps are confirmed.', 'qualified_technician', true)
on conflict (industry_key,rule_key) do nothing;

alter table public.companies add column if not exists industry_key text not null default 'pool';
do $$ begin
  if not exists (select 1 from pg_constraint where conname='companies_industry_key_fkey') then
    alter table public.companies add constraint companies_industry_key_fkey foreign key (industry_key) references public.industry_modules(industry_key);
  end if;
end $$;

alter table public.company_manuals add column if not exists industry_key text not null default 'pool';
update public.company_manuals m set industry_key=c.industry_key from public.companies c where c.id=m.company_id and m.industry_key is distinct from c.industry_key;
alter table public.company_manual_chunks add column if not exists industry_key text not null default 'pool';
update public.company_manual_chunks ch set industry_key=m.industry_key from public.company_manuals m where m.id=ch.manual_id and ch.industry_key is distinct from m.industry_key;
alter table public.company_manual_chunks add column if not exists page_start integer;
alter table public.company_manual_chunks add column if not exists page_end integer;
alter table public.company_manual_chunks add column if not exists embedding extensions.vector(768);
alter table public.company_manual_chunks add column if not exists embedding_model text;
alter table public.company_manual_chunks add column if not exists embedded_at timestamptz;
create index if not exists company_manual_chunks_industry_company_idx on public.company_manual_chunks(industry_key,company_id,manual_id);
create index if not exists company_manual_chunks_embedding_hnsw_idx on public.company_manual_chunks using hnsw (embedding extensions.vector_cosine_ops) where embedding is not null;

-- Replace the keyword-only private-source function with an optional hybrid variant. The
-- original RPC remains intact for compatibility. Company-id and reference-enabled filters
-- are mandatory in both lexical and vector retrieval paths.
create or replace function public.search_company_manual_chunks_hybrid(
  p_company_id uuid,
  p_query text,
  p_embedding extensions.vector(768) default null,
  p_limit integer default 6
)
returns table(id uuid, manual_id uuid, title text, source_url text, page_number integer, page_start integer, page_end integer, content_text text, rank real, retrieval_method text, industry_key text)
language sql stable security definer set search_path=public,extensions,pg_temp as $$
  with candidates as (
    select c.id,c.manual_id,c.title,c.source_url,c.page_number,c.page_start,c.page_end,c.content_text,c.industry_key,
      ts_rank(c.search_vector, websearch_to_tsquery('english', coalesce(left(p_query,1800),'')))::real as lexical_score,
      case when p_embedding is not null and c.embedding is not null then (1 - (c.embedding <=> p_embedding))::real else 0::real end as semantic_score,
      (c.search_vector @@ websearch_to_tsquery('english', coalesce(left(p_query,1800),''))
       or exists (select 1 from regexp_split_to_table(lower(coalesce(p_query,'')), '\s+') as q(word) where length(q.word)>2 and c.content_text ilike '%'||left(q.word,60)||'%')) as lexical_match
    from public.company_manual_chunks c
    join public.company_manuals m on m.id=c.manual_id and m.company_id=c.company_id
    join public.companies co on co.id=c.company_id and co.industry_key=c.industry_key
    join public.industry_modules im on im.industry_key=co.industry_key and im.status='active'
    where c.company_id=p_company_id and m.reference_enabled=true and m.extraction_status='ready'
  ), ranked as (
    select *, greatest(lexical_score, semantic_score * 0.85)::real as combined_score,
      case when lexical_match and semantic_score > 0 then 'hybrid' when lexical_match then 'keyword' else 'semantic' end as method
    from candidates
    where lexical_match or (p_embedding is not null and semantic_score > 0.25)
  )
  select r.id,r.manual_id,r.title,r.source_url,r.page_number,r.page_start,r.page_end,r.content_text,r.combined_score,r.method,r.industry_key
  from ranked r order by r.combined_score desc, r.page_number nulls last limit least(greatest(coalesce(p_limit,6),1),12)
$$;
revoke all on function public.search_company_manual_chunks_hybrid(uuid,text,extensions.vector,integer) from public,anon,authenticated;
grant execute on function public.search_company_manual_chunks_hybrid(uuid,text,extensions.vector,integer) to service_role;

-- Invitation lifecycle columns. A pending/invited member has a suspended membership until acceptance.
alter table public.technician_invitation_requests add column if not exists auth_user_id uuid references auth.users(id) on delete set null;
alter table public.technician_invitation_requests add column if not exists expires_at timestamptz;
alter table public.technician_invitation_requests add column if not exists accepted_at timestamptz;
alter table public.technician_invitation_requests add column if not exists revoked_at timestamptz;
alter table public.technician_invitation_requests add column if not exists last_sent_at timestamptz;
alter table public.technician_invitation_requests add column if not exists existing_auth_user boolean not null default false;
alter table public.technician_invitation_requests add column if not exists invite_permissions jsonb not null default '{}'::jsonb;
update public.technician_invitation_requests set expires_at=coalesce(expires_at,created_at + interval '7 days') where expires_at is null;
do $$ begin
  alter table public.technician_invitation_requests drop constraint if exists technician_invitation_requests_status_check;
  alter table public.technician_invitation_requests add constraint technician_invitation_requests_status_check check(status in ('pending','sent','cancelled','accepted','expired','revoked'));
exception when duplicate_object then null; end $$;
create index if not exists technician_invitations_company_status_idx on public.technician_invitation_requests(company_id,status,created_at desc);
create index if not exists technician_invitations_email_status_idx on public.technician_invitation_requests(lower(invite_email),status,expires_at desc);

-- Durable PWA idempotency key. Replaying a queued job after reconnect cannot create duplicates.
alter table public.technician_job_records add column if not exists client_job_id uuid;
create unique index if not exists technician_jobs_client_idempotency_idx on public.technician_job_records(tenant_id,technician_id,client_job_id) where client_job_id is not null;

-- Meter both quantities and provider-reported token/cost values where available. NULL estimated
-- cost means no model rate card is configured; do not fabricate a cost.
alter table public.platform_usage_events add column if not exists metric_type text not null default 'event';
alter table public.platform_usage_events add column if not exists quantity numeric(20,4) not null default 1;
alter table public.platform_usage_events add column if not exists quantity_unit text not null default 'event';
alter table public.platform_usage_events add column if not exists provider text;
alter table public.platform_usage_events add column if not exists model text;
alter table public.platform_usage_events add column if not exists input_tokens bigint;
alter table public.platform_usage_events add column if not exists output_tokens bigint;
alter table public.platform_usage_events add column if not exists estimated_cost_usd numeric(14,6);
alter table public.platform_usage_events add column if not exists cost_source text not null default 'not_priced' check (cost_source in ('not_priced','rate_card_estimate','provider_reported'));
alter table public.platform_usage_events add column if not exists storage_bytes bigint;
alter table public.platform_usage_events add column if not exists extracted_characters bigint;
alter table public.platform_usage_events add column if not exists duration_ms integer;
alter table public.platform_usage_events add column if not exists source_event_key text;
alter table public.platform_usage_events add column if not exists period_start date not null default date_trunc('month',now())::date;
create unique index if not exists platform_usage_source_event_key_idx on public.platform_usage_events(source_event_key) where source_event_key is not null;
create index if not exists platform_usage_company_period_idx on public.platform_usage_events(company_id,period_start,event_type,created_at desc);

create table if not exists public.pooldocai_model_rate_cards (
  id uuid primary key default gen_random_uuid(), provider text not null, model text not null,
  input_usd_per_million_tokens numeric(14,8), output_usd_per_million_tokens numeric(14,8),
  active boolean not null default true, valid_from timestamptz not null default now(), valid_to timestamptz,
  created_at timestamptz not null default now(), unique(provider,model,valid_from)
);
create table if not exists public.pooldocai_usage_alerts (
  id uuid primary key default gen_random_uuid(), company_id uuid references public.companies(id) on delete cascade,
  period_start date not null, metric_type text not null check(metric_type in ('ai_requests','document_characters','storage_bytes')),
  threshold_percent integer not null check(threshold_percent in (80,100)), observed_value numeric(20,4) not null,
  limit_value numeric(20,4) not null, status text not null default 'open' check(status in ('open','acknowledged','resolved')),
  created_at timestamptz not null default now(), acknowledged_at timestamptz,
  unique(company_id,period_start,metric_type,threshold_percent)
);
create table if not exists public.pooldocai_stripe_webhook_events (
  stripe_event_id text primary key, event_type text not null, processed boolean not null default false,
  processing_error text, received_at timestamptz not null default now(), processed_at timestamptz
);
alter table public.companies add column if not exists stripe_customer_id text;
alter table public.companies add column if not exists stripe_subscription_id text;
alter table public.companies add column if not exists stripe_price_id text;
alter table public.companies add column if not exists billing_period_start timestamptz;
alter table public.companies add column if not exists trial_ends_at timestamptz;
alter table public.companies add column if not exists monthly_ai_request_limit bigint;
alter table public.companies add column if not exists monthly_document_character_limit bigint;
alter table public.companies add column if not exists storage_limit_bytes bigint;

alter table public.pooldocai_model_rate_cards enable row level security;
alter table public.pooldocai_usage_alerts enable row level security;
alter table public.pooldocai_stripe_webhook_events enable row level security;
alter table public.industry_modules enable row level security;
alter table public.industry_equipment_catalog enable row level security;
alter table public.industry_diagnostic_workflows enable row level security;
alter table public.industry_safety_rules enable row level security;
alter table public.industry_source_ranking_rules enable row level security;
revoke all on public.pooldocai_model_rate_cards,public.pooldocai_usage_alerts,public.pooldocai_stripe_webhook_events,public.industry_modules,public.industry_equipment_catalog,public.industry_diagnostic_workflows,public.industry_safety_rules,public.industry_source_ranking_rules from anon,authenticated;
grant all on public.pooldocai_model_rate_cards,public.pooldocai_usage_alerts,public.pooldocai_stripe_webhook_events to service_role;
grant all on public.industry_modules,public.industry_equipment_catalog,public.industry_diagnostic_workflows,public.industry_safety_rules,public.industry_source_ranking_rules to service_role;
create policy industry_modules_active_read on public.industry_modules for select to authenticated using(status='active');
create policy industry_catalog_active_read on public.industry_equipment_catalog for select to authenticated using(active and exists(select 1 from public.industry_modules im where im.industry_key=industry_equipment_catalog.industry_key and im.status='active'));
create policy industry_workflows_active_read on public.industry_diagnostic_workflows for select to authenticated using(active and exists(select 1 from public.industry_modules im where im.industry_key=industry_diagnostic_workflows.industry_key and im.status='active'));
create policy industry_safety_active_read on public.industry_safety_rules for select to authenticated using(active and exists(select 1 from public.industry_modules im where im.industry_key=industry_safety_rules.industry_key and im.status='active'));
create policy industry_sources_active_read on public.industry_source_ranking_rules for select to authenticated using(active and exists(select 1 from public.industry_modules im where im.industry_key=industry_source_ranking_rules.industry_key and im.status='active'));
create policy usage_alerts_company_or_platform_read on public.pooldocai_usage_alerts for select to authenticated using(public.is_platform_admin() or public.is_company_admin(company_id));
create policy model_rates_platform_read on public.pooldocai_model_rate_cards for select to authenticated using(public.is_platform_admin());

comment on table public.industry_modules is 'Reusable industry layer for catalogs, diagnostic workflows, safety policy, and source ranking; activation requires reviewed configuration.';
comment on table public.pooldocai_model_rate_cards is 'Versioned token prices used for estimated—not guaranteed invoice—provider cost accounting. Configure current rates from the provider before relying on costs.';
comment on table public.pooldocai_stripe_webhook_events is 'Idempotency/audit ledger for verified Stripe webhook events; no payment data or card details are stored.';
comment on column public.company_manual_chunks.page_number is 'PDF page number when extracted with page-preserving parsing; NULL when the source does not provide a reliable page number.';
