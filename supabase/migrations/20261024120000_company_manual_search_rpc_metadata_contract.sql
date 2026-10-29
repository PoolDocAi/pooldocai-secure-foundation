-- Migration 040: Fix company manual search RPCs return schema contract
-- Updates search_company_manual_chunks and search_company_manual_chunks_hybrid
-- to project manufacturer_normalized, model_normalized, equipment_category,
-- reference_enabled, and extraction_status from company_manuals.

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
  extraction_status text
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
    m.extraction_status
  FROM public.company_manual_chunks c
  JOIN public.company_manuals m ON m.id = c.manual_id AND m.company_id = c.company_id
  JOIN public.companies co ON co.id = c.company_id AND co.industry_key = c.industry_key
  JOIN public.industry_modules im ON im.industry_key = co.industry_key AND im.status = 'active'
  WHERE c.company_id = p_company_id
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

REVOKE ALL ON FUNCTION public.search_company_manual_chunks(uuid, text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_company_manual_chunks(uuid, text, integer) TO service_role;

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
  extraction_status text
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
      ) AS lexical_match
    FROM public.company_manual_chunks c
    JOIN public.company_manuals m ON m.id = c.manual_id AND m.company_id = c.company_id
    JOIN public.companies co ON co.id = c.company_id AND co.industry_key = c.industry_key
    JOIN public.industry_modules im ON im.industry_key = co.industry_key AND im.status = 'active'
    WHERE c.company_id = p_company_id
      AND m.reference_enabled = true
      AND m.extraction_status = 'ready'
  ), ranked AS (
    SELECT
      *,
      greatest(lexical_score, semantic_score * 0.85)::real AS combined_score,
      CASE
        WHEN lexical_match AND semantic_score > 0 THEN 'hybrid'
        WHEN lexical_match THEN 'keyword'
        ELSE 'semantic'
      END AS method
    FROM candidates
    WHERE lexical_match OR (p_embedding IS NOT NULL AND semantic_score > 0.25)
  )
  SELECT
    r.id,
    r.manual_id,
    r.title,
    r.source_url,
    r.page_number,
    r.page_start,
    r.page_end,
    r.content_text,
    r.combined_score,
    r.method,
    r.industry_key,
    r.manufacturer_normalized,
    r.model_normalized,
    r.equipment_category,
    r.reference_enabled,
    r.extraction_status
  FROM ranked r
  ORDER BY r.combined_score DESC, r.page_number NULLS LAST
  LIMIT least(greatest(coalesce(p_limit,6),1),12)
$$;

REVOKE ALL ON FUNCTION public.search_company_manual_chunks_hybrid(uuid, text, extensions.vector, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_company_manual_chunks_hybrid(uuid, text, extensions.vector, integer) TO service_role;
