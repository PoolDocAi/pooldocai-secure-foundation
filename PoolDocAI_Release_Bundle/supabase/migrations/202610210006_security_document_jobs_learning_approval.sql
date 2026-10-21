-- PoolDocAI security hardening, durable document jobs, consent audit, and human-approved shared knowledge.
-- Fresh install: apply migrations in filename order. Never expose service-role credentials to browsers.
create extension if not exists pgcrypto;

-- Private storage is mandatory; fail closed if the bucket is absent or public.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('company-manuals','company-manuals',false,26214400,array[
'application/pdf','text/plain','text/markdown','text/csv','application/json','application/xml','text/xml','text/html','application/xhtml+xml',
'application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-word.document.macroEnabled.12',
'image/jpeg','image/png','image/heic','image/heif','image/webp','image/tiff','image/bmp','image/gif'
]) on conflict(id) do update set public=false,file_size_limit=26214400,allowed_mime_types=excluded.allowed_mime_types;

-- Default deny: service role is the only direct reader of extracted text and review records.
alter table public.company_manual_chunks enable row level security;
revoke all on public.company_manual_chunks from anon, authenticated;
grant all on public.company_manual_chunks to service_role;
alter table public.diagnostic_cases enable row level security;
alter table public.diagnostic_case_steps enable row level security;
alter table public.learning_review_queue enable row level security;
revoke all on public.diagnostic_cases,public.diagnostic_case_steps,public.learning_review_queue from anon,authenticated;
grant all on public.diagnostic_cases,public.diagnostic_case_steps,public.learning_review_queue to service_role;

-- Reassert tenant-aware RLS policies for core customer/job/manual data. Policies are restrictive by company.
drop policy if exists service_requests_read on public.service_requests;
drop policy if exists requests_read on public.service_requests;
create policy requests_read on public.service_requests for select to authenticated using (public.is_platform_admin() or public.is_company_member(company_id));
drop policy if exists service_customers_company_access on public.service_customers;
drop policy if exists customers_company_access on public.service_customers;
create policy customers_company_access on public.service_customers for select to authenticated using (public.is_platform_admin() or public.is_company_member(company_id));
drop policy if exists company_manuals_company_read on public.company_manuals;
drop policy if exists manuals_company_read on public.company_manuals;
create policy manuals_company_read on public.company_manuals for select to authenticated using (public.is_platform_admin() or public.is_company_member(company_id));
drop policy if exists jobs_company_read on public.technician_job_records;
create policy jobs_company_read on public.technician_job_records for select to authenticated using (public.is_platform_admin() or (tenant_id is not null and public.is_company_member(tenant_id)));
drop policy if exists jobs_company_update on public.technician_job_records;
create policy jobs_company_update on public.technician_job_records for update to authenticated using (public.is_platform_admin() or (tenant_id is not null and public.is_company_operator(tenant_id))) with check (public.is_platform_admin() or (tenant_id is not null and public.is_company_operator(tenant_id)));

-- company_manuals in earlier releases did not have updated_at; queue deduplication uses it.
alter table public.company_manuals add column if not exists updated_at timestamptz not null default now();
create or replace function public.pooldocai_touch_updated_at() returns trigger language plpgsql set search_path=public,pg_temp as $$
begin new.updated_at=now(); return new; end; $$;
drop trigger if exists company_manuals_touch_updated_at on public.company_manuals;
create trigger company_manuals_touch_updated_at before update on public.company_manuals for each row execute function public.pooldocai_touch_updated_at();

-- A durable, idempotent queue; the worker claims one job atomically via RPC.
create table if not exists public.document_processing_jobs (
 id uuid primary key default gen_random_uuid(), manual_id uuid not null references public.company_manuals(id) on delete cascade,
 company_id uuid not null references public.companies(id) on delete cascade,
 status text not null default 'queued' check(status in ('queued','processing','ready','failed')),
 attempts integer not null default 0 check(attempts between 0 and 10), max_attempts integer not null default 4 check(max_attempts between 1 and 10),
 dedupe_key text not null, requested_by uuid references auth.users(id) on delete set null,
 last_error text, available_at timestamptz not null default now(), started_at timestamptz, finished_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 unique(company_id,dedupe_key)
);
create index if not exists document_jobs_claim_idx on public.document_processing_jobs(status,available_at,created_at) where status='queued';
create index if not exists document_jobs_company_idx on public.document_processing_jobs(company_id,created_at desc);
alter table public.document_processing_jobs enable row level security;
revoke all on public.document_processing_jobs from public,anon,authenticated;
grant all on public.document_processing_jobs to service_role;

create or replace function public.pooldocai_enqueue_document_job(p_manual_id uuid,p_requested_by uuid default null,p_force boolean default false)
returns public.document_processing_jobs language plpgsql security definer set search_path=public,pg_temp as $$
declare m public.company_manuals%rowtype; j public.document_processing_jobs%rowtype; k text;
begin
 select * into m from public.company_manuals where id=p_manual_id for update;
 if not found then raise exception 'document not found'; end if;
 k := m.id::text || ':' || coalesce(m.storage_path,'') || ':' || coalesce(m.file_size::text,'0') || ':learn=' || m.shared_learning_opt_in::text;
 insert into public.document_processing_jobs(manual_id,company_id,status,dedupe_key,requested_by)
 values(m.id,m.company_id,'queued',k,p_requested_by)
 on conflict(company_id,dedupe_key) do update set
   status=case when public.document_processing_jobs.status='processing' then 'processing' when p_force or public.document_processing_jobs.status='failed' then 'queued' else public.document_processing_jobs.status end,
   attempts=case when public.document_processing_jobs.status<>'processing' and (p_force or public.document_processing_jobs.status='failed') then 0 else public.document_processing_jobs.attempts end,
   last_error=case when public.document_processing_jobs.status<>'processing' and (p_force or public.document_processing_jobs.status='failed') then null else public.document_processing_jobs.last_error end,
   available_at=case when public.document_processing_jobs.status<>'processing' and (p_force or public.document_processing_jobs.status='failed') then now() else public.document_processing_jobs.available_at end,
   finished_at=case when public.document_processing_jobs.status<>'processing' and (p_force or public.document_processing_jobs.status='failed') then null else public.document_processing_jobs.finished_at end,
   updated_at=now()
 returning * into j;
 update public.company_manuals set extraction_status=case when j.status='ready' then 'ready' when j.status='processing' then 'processing' else 'queued' end, extraction_error=null where id=m.id;
 return j;
end; $$;
revoke all on function public.pooldocai_enqueue_document_job(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.pooldocai_enqueue_document_job(uuid,uuid,boolean) to service_role;

create or replace function public.pooldocai_claim_document_job()
returns setof public.document_processing_jobs language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.document_processing_jobs%rowtype;
begin
 update public.document_processing_jobs set status=case when attempts>=max_attempts then 'failed' else 'queued' end, last_error='Worker lease expired; job recovered by queue.', available_at=now(), finished_at=case when attempts>=max_attempts then now() else null end, updated_at=now() where status='processing' and started_at < now()-interval '30 minutes';
 update public.company_manuals m set extraction_status='failed',extraction_error='Worker lease expired after maximum retries.' from public.document_processing_jobs j0 where j0.manual_id=m.id and j0.status='failed' and j0.last_error='Worker lease expired; job recovered by queue.';
 select * into j from public.document_processing_jobs where status='queued' and available_at<=now() and attempts<max_attempts order by created_at for update skip locked limit 1;
 if not found then return; end if;
 update public.document_processing_jobs set status='processing',attempts=attempts+1,started_at=now(),updated_at=now() where id=j.id returning * into j;
 update public.company_manuals set extraction_status='processing',extraction_error=null where id=j.manual_id;
 return next j;
end; $$;
revoke all on function public.pooldocai_claim_document_job() from public,anon,authenticated;
grant execute on function public.pooldocai_claim_document_job() to service_role;

create or replace function public.pooldocai_finish_document_job(p_job_id uuid,p_success boolean,p_error text default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare j public.document_processing_jobs%rowtype; next_status text;
begin
 select * into j from public.document_processing_jobs where id=p_job_id for update;
 if not found then raise exception 'job not found'; end if;
 if p_success then next_status:='ready';
 elsif j.attempts < j.max_attempts then next_status:='queued';
 else next_status:='failed'; end if;
 update public.document_processing_jobs set status=next_status,last_error=case when p_success then null else left(coalesce(p_error,'Processing failed'),500) end,
   available_at=case when next_status='queued' then now() + make_interval(secs => least(300, 15 * power(2,greatest(j.attempts-1,0))::integer)) else available_at end,
   finished_at=case when next_status in ('ready','failed') then now() else null end,updated_at=now() where id=p_job_id;
 if next_status='failed' then update public.company_manuals set extraction_status='failed',extraction_error=left(coalesce(p_error,'Processing failed'),500) where id=j.manual_id;
 elsif p_success then update public.company_manuals set extraction_status='ready',extraction_error=null where id=j.manual_id;
 else update public.company_manuals set extraction_status='queued',extraction_error=left(coalesce(p_error,'Retry scheduled'),500) where id=j.manual_id; end if;
end; $$;
revoke all on function public.pooldocai_finish_document_job(uuid,boolean,text) from public,anon,authenticated;
grant execute on function public.pooldocai_finish_document_job(uuid,boolean,text) to service_role;

-- Consent audit log: document stays private-reference eligible even if shared learning is off.
create table if not exists public.document_consent_audit (
 id uuid primary key default gen_random_uuid(), manual_id uuid not null references public.company_manuals(id) on delete cascade,
 company_id uuid not null references public.companies(id) on delete cascade, actor_user_id uuid references auth.users(id) on delete set null,
 old_opt_in boolean not null, new_opt_in boolean not null, reason text, created_at timestamptz not null default now()
);
alter table public.document_consent_audit enable row level security;
revoke all on public.document_consent_audit from public,anon,authenticated;
grant all on public.document_consent_audit to service_role;

-- Record the consent state that was chosen at initial upload/registration. Updates are
-- logged by the authenticated Edge Function so the actual acting user is preserved.
create or replace function public.pooldocai_audit_initial_document_consent()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into public.document_consent_audit(manual_id,company_id,actor_user_id,old_opt_in,new_opt_in,reason)
 values(new.id,new.company_id,coalesce(auth.uid(),new.uploaded_by),false,coalesce(new.shared_learning_opt_in,false),'Initial document consent state recorded at upload');
 return new;
end; $$;
drop trigger if exists company_manuals_initial_consent_audit on public.company_manuals;
create trigger company_manuals_initial_consent_audit after insert on public.company_manuals
for each row execute function public.pooldocai_audit_initial_document_consent();

-- Shared knowledge is a separate, minimized store. Only explicitly approved lessons enter it.
create table if not exists public.shared_learning_knowledge (
 id uuid primary key default gen_random_uuid(), source_case_id uuid references public.diagnostic_cases(id) on delete set null,
 source_queue_id uuid references public.learning_review_queue(id) on delete set null, source_company_id uuid references public.companies(id) on delete set null,
 source_kind text not null, equipment_category text, manufacturer_normalized text, model_normalized text,
 lesson_redacted text not null check(length(lesson_redacted) between 40 and 4000), approved_by uuid not null references auth.users(id),
 consent_snapshot boolean, review_history jsonb not null default '[]'::jsonb, created_at timestamptz not null default now(),
 unique(source_queue_id)
);
create index if not exists shared_learning_search_idx on public.shared_learning_knowledge using gin(to_tsvector('english',coalesce(equipment_category,'')||' '||coalesce(manufacturer_normalized,'')||' '||coalesce(model_normalized,'')||' '||lesson_redacted));
alter table public.shared_learning_knowledge enable row level security;
revoke all on public.shared_learning_knowledge from public,anon,authenticated;
grant all on public.shared_learning_knowledge to service_role;

create table if not exists public.learning_review_audit (
 id uuid primary key default gen_random_uuid(), queue_id uuid not null references public.learning_review_queue(id) on delete cascade,
 case_id uuid references public.diagnostic_cases(id) on delete set null, actor_user_id uuid references auth.users(id) on delete set null,
 action text not null check(action in ('approved','rejected','reopened')), note_redacted text, created_at timestamptz not null default now()
);
alter table public.learning_review_audit enable row level security;
revoke all on public.learning_review_audit from public,anon,authenticated;
grant all on public.learning_review_audit to service_role;

create or replace function public.search_shared_learning(p_query text,p_limit integer default 4)
returns table(id uuid,equipment_category text,manufacturer_normalized text,model_normalized text,lesson_redacted text,rank real)
language sql stable security definer set search_path=public,pg_temp as $$
 select k.id,k.equipment_category,k.manufacturer_normalized,k.model_normalized,k.lesson_redacted,
 ts_rank(to_tsvector('english',coalesce(k.equipment_category,'')||' '||coalesce(k.manufacturer_normalized,'')||' '||coalesce(k.model_normalized,'')||' '||k.lesson_redacted),websearch_to_tsquery('english',coalesce(left(p_query,1800),''))) rank
 from public.shared_learning_knowledge k
 where to_tsvector('english',coalesce(k.equipment_category,'')||' '||coalesce(k.manufacturer_normalized,'')||' '||coalesce(k.model_normalized,'')||' '||k.lesson_redacted) @@ websearch_to_tsquery('english',coalesce(left(p_query,1800),''))
 order by rank desc limit least(greatest(coalesce(p_limit,4),1),8)
$$;
revoke all on function public.search_shared_learning(text,integer) from public,anon,authenticated;
grant execute on function public.search_shared_learning(text,integer) to service_role;

comment on table public.document_processing_jobs is 'Durable, deduplicated queue. Private worker only; statuses queued/processing/ready/failed.';
comment on table public.shared_learning_knowledge is 'Approved privacy-minimized knowledge only; separate from private manuals and pending cases. This is retrieval, not model training.';

-- Make account revocation and company suspension effective at the database boundary too.
create or replace function public.is_company_member(p_company_id uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.company_members m join public.companies c on c.id=m.company_id
 where m.company_id=p_company_id and m.user_id=auth.uid() and m.status='active' and c.status in ('active','pilot'))
$$;
create or replace function public.is_company_admin(p_company_id uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select public.is_platform_admin() or exists(select 1 from public.company_members m join public.companies c on c.id=m.company_id
 where m.company_id=p_company_id and m.user_id=auth.uid() and m.role='company_admin' and m.status='active' and c.status in ('active','pilot'))
$$;
create or replace function public.is_company_operator(p_company_id uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select public.is_platform_admin() or exists(select 1 from public.company_members m join public.companies c on c.id=m.company_id
 where m.company_id=p_company_id and m.user_id=auth.uid() and m.role in ('company_admin','technician') and m.status='active' and c.status in ('active','pilot'))
$$;
revoke all on function public.is_company_member(uuid),public.is_company_admin(uuid),public.is_company_operator(uuid) from public,anon;
grant execute on function public.is_company_member(uuid),public.is_company_admin(uuid),public.is_company_operator(uuid) to authenticated;


-- Assigned-technician request updates must also require a live membership in a live company.
drop policy if exists requests_admin_update on public.service_requests;
create policy requests_admin_update on public.service_requests for update to authenticated
using (public.is_platform_admin() or public.is_company_admin(company_id) or (assigned_technician=auth.uid() and public.is_company_operator(company_id)))
with check (public.is_platform_admin() or public.is_company_admin(company_id) or (assigned_technician=auth.uid() and public.is_company_operator(company_id)));
