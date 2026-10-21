-- Company-private document extraction/indexing. Shared learning consent is separate from
-- reference access. Full extracted text remains tenant-scoped and is never exposed to anon.
create extension if not exists pgcrypto;

alter table public.company_manuals
  add column if not exists source_url text,
  add column if not exists original_filename text,
  add column if not exists extraction_status text not null default 'queued',
  add column if not exists extraction_error text,
  add column if not exists extracted_char_count integer not null default 0,
  add column if not exists chunk_count integer not null default 0,
  add column if not exists processed_at timestamptz;

do $$ begin
  if not exists (select 1 from pg_constraint where conname='company_manuals_extraction_status_check') then
    alter table public.company_manuals add constraint company_manuals_extraction_status_check
      check (extraction_status in ('queued','processing','ready','failed'));
  end if;
end $$;

create table if not exists public.company_manual_chunks (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  manual_id uuid not null references public.company_manuals(id) on delete cascade,
  chunk_index integer not null check (chunk_index >= 0),
  title text not null default '',
  source_url text,
  page_number integer,
  content_text text not null,
  content_redacted text not null default '',
  search_vector tsvector generated always as (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content_text,''))) stored,
  created_at timestamptz not null default now(),
  unique(manual_id, chunk_index),
  constraint company_manual_chunk_size check (length(content_text) between 1 and 5000)
);
create index if not exists company_manual_chunks_company_idx on public.company_manual_chunks(company_id, manual_id);
create index if not exists company_manual_chunks_search_idx on public.company_manual_chunks using gin(search_vector);
create index if not exists company_manuals_status_idx on public.company_manuals(company_id, extraction_status);

alter table public.company_manual_chunks enable row level security;
revoke all on public.company_manual_chunks from anon, authenticated;
grant all on public.company_manual_chunks to service_role;

create or replace function public.search_company_manual_chunks(p_company_id uuid, p_query text, p_limit integer default 6)
returns table(id uuid, manual_id uuid, title text, source_url text, page_number integer, content_text text, rank real)
language sql stable security definer set search_path=public,pg_temp as $$
  select c.id, c.manual_id, c.title, c.source_url, c.page_number, c.content_text,
    ts_rank(c.search_vector, websearch_to_tsquery('english', coalesce(left(p_query,1800),''))) as rank
  from public.company_manual_chunks c
  join public.company_manuals m on m.id=c.manual_id and m.company_id=c.company_id
  where c.company_id=p_company_id and m.reference_enabled=true and m.extraction_status='ready'
    and (c.search_vector @@ websearch_to_tsquery('english', coalesce(left(p_query,1800),''))
      or exists (select 1 from regexp_split_to_table(lower(coalesce(p_query,'')), '\s+') as q(word) where length(q.word) > 2 and c.content_text ilike '%' || left(q.word,60) || '%'))
  order by rank desc, c.chunk_index asc
  limit least(greatest(coalesce(p_limit,6),1),10)
$$;
revoke all on function public.search_company_manual_chunks(uuid,text,integer) from public, anon, authenticated;
grant execute on function public.search_company_manual_chunks(uuid,text,integer) to service_role;

-- Extend private bucket MIME allow-list. Storage stays private and company-folder RLS still applies.
update storage.buckets set allowed_mime_types = array[
  'application/pdf','text/plain','text/markdown','text/csv','application/json','application/xml','text/xml',
  'text/html','application/xhtml+xml','application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-word.document.macroEnabled.12',
  'image/jpeg','image/png','image/heic','image/heif','image/webp','image/tiff','image/bmp','image/gif'
] where id='company-manuals';

comment on table public.company_manual_chunks is 'Private extracted document chunks, isolated by company_id. Search is performed only by trusted server code after verifying company membership.';
comment on column public.company_manuals.shared_learning_opt_in is 'Explicit consent for extracted content to enter pending shared-learning review. Does not control private company-reference use.';
