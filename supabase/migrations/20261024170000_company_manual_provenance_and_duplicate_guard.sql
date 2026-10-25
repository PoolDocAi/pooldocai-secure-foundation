-- Migration 045: Company manual provenance contract and duplicate protection
-- Implements Task-007 Part-3 Addendum (Comment #6392787154):
-- 1. Provenance contract: source_publisher, canonical_title, publication_number, revision, publication_date, content_sha256, source_locator, product_name, model_family
-- 2. Duplicate protection: same-tenant duplicate rejection + privacy-preserving cross-tenant match detection (pooldocai_check_manual_duplicate)
-- 3. Projects provenance attributes in search_company_manual_chunks and search_company_manual_chunks_hybrid

ALTER TABLE public.company_manuals
  ADD COLUMN IF NOT EXISTS source_publisher text,
  ADD COLUMN IF NOT EXISTS canonical_title text,
  ADD COLUMN IF NOT EXISTS publication_number text,
  ADD COLUMN IF NOT EXISTS revision text,
  ADD COLUMN IF NOT EXISTS publication_date date,
  ADD COLUMN IF NOT EXISTS content_sha256 text,
  ADD COLUMN IF NOT EXISTS source_locator text,
  ADD COLUMN IF NOT EXISTS product_name text,
  ADD COLUMN IF NOT EXISTS model_family text,
  ADD COLUMN IF NOT EXISTS is_duplicate boolean not null default false,
  ADD COLUMN IF NOT EXISTS duplicate_of_manual_id uuid references public.company_manuals(id) on delete set null;

CREATE INDEX IF NOT EXISTS company_manuals_company_sha256_idx ON public.company_manuals(company_id, content_sha256) WHERE content_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS company_manuals_global_sha256_idx ON public.company_manuals(content_sha256) WHERE content_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS company_manuals_pub_rev_idx ON public.company_manuals(publication_number, revision) WHERE publication_number IS NOT NULL;

-- Secure duplicate check function
-- Returns same-company duplicate status and privacy-preserving cross-company match count WITHOUT leaking any other tenant IDs, company names, or storage paths.
CREATE OR REPLACE FUNCTION public.pooldocai_check_manual_duplicate(
  p_company_id uuid,
  p_sha256 text,
  p_manual_id uuid default null
)
RETURNS TABLE(
  is_same_company_duplicate boolean,
  existing_manual_id uuid,
  has_cross_company_match boolean,
  cross_company_match_count integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_same_id uuid := null;
  v_cross_count integer := 0;
BEGIN
  IF p_sha256 IS NULL OR length(trim(p_sha256)) < 32 THEN
    RETURN QUERY SELECT false, null::uuid, false, 0;
    RETURN;
  END IF;

  SELECT id INTO v_same_id
  FROM public.company_manuals
  WHERE company_id = p_company_id
    AND content_sha256 = trim(p_sha256)
    AND (p_manual_id IS NULL OR id <> p_manual_id)
  LIMIT 1;

  SELECT count(DISTINCT company_id)::integer INTO v_cross_count
  FROM public.company_manuals
  WHERE company_id <> p_company_id
    AND content_sha256 = trim(p_sha256);

  RETURN QUERY SELECT
    (v_same_id IS NOT NULL),
    v_same_id,
    (v_cross_count > 0),
    coalesce(v_cross_count, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_check_manual_duplicate(uuid, text, uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.pooldocai_check_manual_duplicate(uuid, text, uuid) TO authenticated, service_role;

-- Update keyword retrieval RPC to project provenance metadata
DROP FUNCTION IF EXISTS public.search_company_manual_chunks(uuid, text, integer);

CREATE OR REPLACE FUNCTION public.search_company_manual_chunks(
  p_company_id uuid,
  p_query text,
  p_limit integer default 6
)
RETURNS TABLE(
  id uuid,
  manual_id uuid,
  title text,
  source_url text,
  page_number integer,
  page_start integer,
  page_end integer,
  content_text text,
  rank real,
  retrieval_method text,
  industry_key text,
  manufacturer_normalized text,
  model_normalized text,
  equipment_category text,
  reference_enabled boolean,
  extraction_status text,
  canonical_title text,
  publication_number text,
  revision text,
  content_sha256 text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT
    c.id,
    c.manual_id,
    c.title,
    c.source_url,
    c.page_number,
    c.page_start,
    c.page_end,
    c.content_text,
    ts_rank(c.search_vector, websearch_to_tsquery('english', coalesce(left(p_query,1800),'')))::real AS rank,
    'keyword'::text AS retrieval_method,
    c.industry_key,
    m.manufacturer_normalized,
    m.model_normalized,
    m.equipment_category,
    m.reference_enabled,
    m.extraction_status,
    m.canonical_title,
    m.publication_number,
    m.revision,
    m.content_sha256
  FROM public.company_manual_chunks c
  JOIN public.company_manuals m ON m.id = c.manual_id AND m.company_id = c.company_id
  JOIN public.companies co ON co.id = c.company_id AND co.industry_key = c.industry_key
  JOIN public.industry_modules im ON im.industry_key = co.industry_key AND im.status = 'active'
  WHERE c.company_id = p_company_id
    AND co.status = 'active'
    AND m.reference_enabled = true
    AND m.extraction_status = 'ready'
    AND (
      c.search_vector @@ websearch_to_tsquery('english', coalesce(left(p_query,1800),''))
      OR EXISTS (
        SELECT 1 FROM regexp_split_to_table(lower(coalesce(p_query,'')), '\s+') AS q(word)
        WHERE length(q.word) > 2 AND c.content_text ILIKE '%' || left(q.word,60) || '%'
      )
    )
  ORDER BY rank DESC, c.chunk_index ASC
  LIMIT least(greatest(coalesce(p_limit,6),1),10)
$$;

REVOKE ALL ON FUNCTION public.search_company_manual_chunks(uuid, text, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.search_company_manual_chunks(uuid, text, integer) TO authenticated, service_role;

-- Update hybrid retrieval RPC to project provenance metadata
DROP FUNCTION IF EXISTS public.search_company_manual_chunks_hybrid(uuid, text, extensions.vector, integer);

CREATE OR REPLACE FUNCTION public.search_company_manual_chunks_hybrid(
  p_company_id uuid,
  p_query text,
  p_embedding extensions.vector(768) default null,
  p_limit integer default 6
)
RETURNS TABLE(
  id uuid,
  manual_id uuid,
  title text,
  source_url text,
  page_number integer,
  page_start integer,
  page_end integer,
  content_text text,
  rank real,
  retrieval_method text,
  industry_key text,
  manufacturer_normalized text,
  model_normalized text,
  equipment_category text,
  reference_enabled boolean,
  extraction_status text,
  canonical_title text,
  publication_number text,
  revision text,
  content_sha256 text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
  WITH candidates AS (
    SELECT
      c.id,
      c.manual_id,
      c.title,
      c.source_url,
      c.page_number,
      c.page_start,
      c.page_end,
      c.content_text,
      c.industry_key,
      m.manufacturer_normalized,
      m.model_normalized,
      m.equipment_category,
      m.reference_enabled,
      m.extraction_status,
      m.canonical_title,
      m.publication_number,
      m.revision,
      m.content_sha256,
      ts_rank(c.search_vector, websearch_to_tsquery('english', coalesce(left(p_query,1800),'')))::real AS lexical_score,
      CASE
        WHEN p_embedding IS NOT NULL AND c.embedding IS NOT NULL THEN (1 - (c.embedding <=> p_embedding))::real
        ELSE 0::real
      END AS semantic_score,
      (
        c.search_vector @@ websearch_to_tsquery('english', coalesce(left(p_query,1800),''))
        OR EXISTS (
          SELECT 1 FROM regexp_split_to_table(lower(coalesce(p_query,'')), '\s+') AS q(word)
          WHERE length(q.word) > 2 AND c.content_text ILIKE '%' || left(q.word,60) || '%'
        )
      ) AS has_lexical_match
    FROM public.company_manual_chunks c
    JOIN public.company_manuals m ON m.id = c.manual_id AND m.company_id = c.company_id
    JOIN public.companies co ON co.id = c.company_id AND co.industry_key = c.industry_key
    JOIN public.industry_modules im ON im.industry_key = co.industry_key AND im.status = 'active'
    WHERE c.company_id = p_company_id
      AND co.status = 'active'
      AND m.reference_enabled = true
      AND m.extraction_status = 'ready'
  ),
  scored AS (
    SELECT
      candidates.*,
      CASE
        WHEN p_embedding IS NOT NULL AND semantic_score > 0.45 AND has_lexical_match THEN (0.45 * lexical_score + 0.55 * semantic_score)::real
        WHEN p_embedding IS NOT NULL AND semantic_score > 0.45 THEN semantic_score
        WHEN has_lexical_match THEN lexical_score
        ELSE 0::real
      END AS final_rank,
      CASE
        WHEN p_embedding IS NOT NULL AND semantic_score > 0.45 AND has_lexical_match THEN 'hybrid'
        WHEN p_embedding IS NOT NULL AND semantic_score > 0.45 THEN 'semantic'
        ELSE 'keyword'
      END AS method
    FROM candidates
    WHERE has_lexical_match OR (p_embedding IS NOT NULL AND semantic_score > 0.45)
  )
  SELECT
    id,
    manual_id,
    title,
    source_url,
    page_number,
    page_start,
    page_end,
    content_text,
    final_rank AS rank,
    method AS retrieval_method,
    industry_key,
    manufacturer_normalized,
    model_normalized,
    equipment_category,
    reference_enabled,
    extraction_status,
    canonical_title,
    publication_number,
    revision,
    content_sha256
  FROM scored
  ORDER BY final_rank DESC
  LIMIT least(greatest(coalesce(p_limit,6),1),10)
$$;

REVOKE ALL ON FUNCTION public.search_company_manual_chunks_hybrid(uuid, text, extensions.vector, integer) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.search_company_manual_chunks_hybrid(uuid, text, extensions.vector, integer) TO authenticated, service_role;
