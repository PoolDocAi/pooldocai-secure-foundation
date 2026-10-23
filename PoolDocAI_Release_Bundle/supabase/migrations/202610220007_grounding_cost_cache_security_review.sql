-- Migration 025: Google Search grounding metering, public fault-code source cache, and review attestations.
-- Apply only after migration 012 (usage/rate-card schema) and 006 (learning review tables).
BEGIN;

ALTER TABLE public.pooldocai_model_rate_cards
  ADD COLUMN IF NOT EXISTS grounding_usd_per_1000_units numeric(14,8),
  ADD COLUMN IF NOT EXISTS grounding_pricing_unit text;

-- Gemini 2.5 is billed per grounded prompt; Gemini 3.x is billed per Search query.
-- Estimates use published paid-tier list rates before subtracting shared free-tier allowances.
UPDATE public.pooldocai_model_rate_cards
SET grounding_usd_per_1000_units=35.00,
    grounding_pricing_unit='grounded_prompt'
WHERE provider='google_gemini'
  AND model IN ('gemini-2.5-flash','gemini-2.5-flash-lite')
  AND active=true;

UPDATE public.pooldocai_model_rate_cards
SET grounding_usd_per_1000_units=14.00,
    grounding_pricing_unit='search_query'
WHERE provider='google_gemini'
  AND model LIKE 'gemini-3.%-flash%'
  AND active=true;

COMMENT ON COLUMN public.pooldocai_model_rate_cards.grounding_usd_per_1000_units IS
  'Gross list price per 1000 Google Search grounding billing units, before shared free-tier allowances.';
COMMENT ON COLUMN public.pooldocai_model_rate_cards.grounding_pricing_unit IS
  'grounded_prompt for Gemini 2.5 and older; search_query for Gemini 3 and newer.';

CREATE TABLE IF NOT EXISTS public.pooldocai_grounded_answer_cache (
  cache_key text PRIMARY KEY CHECK (length(cache_key)=64),
  equipment_category text NOT NULL,
  manufacturer_normalized text NOT NULL,
  model_normalized text NOT NULL,
  fault_code text NOT NULL,
  answer_redacted text NOT NULL CHECK (length(answer_redacted) BETWEEN 40 AND 4800),
  source_links jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(source_links)='array'),
  evidence_snippets jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence_snippets)='array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS pooldocai_grounded_answer_cache_expiry_idx ON public.pooldocai_grounded_answer_cache(expires_at);
ALTER TABLE public.pooldocai_grounded_answer_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pooldocai_grounded_answer_cache FROM public, anon, authenticated;
GRANT ALL ON public.pooldocai_grounded_answer_cache TO service_role;
COMMENT ON TABLE public.pooldocai_grounded_answer_cache IS
  'Thirty-day cache of public web-grounding evidence keyed only by manufacturer, model, equipment category and explicit fault code; no tenant manuals or customer identifiers.';

ALTER TABLE public.learning_review_audit
  ADD COLUMN IF NOT EXISTS reviewer_name text,
  ADD COLUMN IF NOT EXISTS qualified_signoff_confirmed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.learning_review_audit.reviewer_name IS 'Required reviewer-supplied name for approval decisions.';
COMMENT ON COLUMN public.learning_review_audit.qualified_signoff_confirmed IS 'Explicit acknowledgement for any approved lesson containing chemical or water-balance risk.';

CREATE INDEX IF NOT EXISTS platform_page_views_created_at_idx ON public.platform_page_views(created_at);

-- Atomic short-lived reservations keep concurrent requests from racing past the grounding budget.
CREATE TABLE IF NOT EXISTS public.pooldocai_grounding_budget_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  model text NOT NULL,
  reserved_units integer NOT NULL CHECK (reserved_units > 0 AND reserved_units <= 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '10 minutes')
);
CREATE INDEX IF NOT EXISTS pooldocai_grounding_budget_reservations_expiry_idx
  ON public.pooldocai_grounding_budget_reservations(expires_at);
ALTER TABLE public.pooldocai_grounding_budget_reservations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pooldocai_grounding_budget_reservations FROM public, anon, authenticated;
GRANT ALL ON public.pooldocai_grounding_budget_reservations TO service_role;

CREATE OR REPLACE FUNCTION public.pooldocai_reserve_grounding_budget(
  p_company_id uuid,
  p_model text,
  p_reserved_units integer,
  p_global_limit integer,
  p_company_limit integer
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_global_used numeric := 0;
  v_global_reserved numeric := 0;
  v_company_used numeric := 0;
  v_company_reserved numeric := 0;
  v_id uuid;
BEGIN
  IF p_reserved_units IS NULL OR p_reserved_units <= 0 OR p_reserved_units > 100
     OR p_global_limit IS NULL OR p_global_limit <= 0
     OR p_company_limit IS NULL OR p_company_limit <= 0 THEN
    RETURN NULL;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('pooldocai_grounding_budget_global'));
  DELETE FROM public.pooldocai_grounding_budget_reservations WHERE expires_at <= now();
  SELECT COALESCE(sum(quantity),0) INTO v_global_used
    FROM public.platform_usage_events WHERE event_type='google_search_grounding' AND created_at >= now()-interval '24 hours';
  SELECT COALESCE(sum(reserved_units),0) INTO v_global_reserved
    FROM public.pooldocai_grounding_budget_reservations WHERE expires_at > now();
  IF v_global_used + v_global_reserved + p_reserved_units > p_global_limit THEN RETURN NULL; END IF;
  IF p_company_id IS NOT NULL THEN
    SELECT COALESCE(sum(quantity),0) INTO v_company_used
      FROM public.platform_usage_events WHERE event_type='google_search_grounding' AND company_id=p_company_id AND created_at >= now()-interval '24 hours';
    SELECT COALESCE(sum(reserved_units),0) INTO v_company_reserved
      FROM public.pooldocai_grounding_budget_reservations WHERE company_id=p_company_id AND expires_at > now();
    IF v_company_used + v_company_reserved + p_reserved_units > p_company_limit THEN RETURN NULL; END IF;
  END IF;
  INSERT INTO public.pooldocai_grounding_budget_reservations(company_id,model,reserved_units,expires_at)
    VALUES(p_company_id,left(COALESCE(p_model,'unknown'),100),p_reserved_units,now()+interval '10 minutes')
    RETURNING id INTO v_id;
  RETURN v_id;
END; $$;
REVOKE ALL ON FUNCTION public.pooldocai_reserve_grounding_budget(uuid,text,integer,integer,integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_reserve_grounding_budget(uuid,text,integer,integer,integer) TO service_role;
COMMENT ON FUNCTION public.pooldocai_reserve_grounding_budget(uuid,text,integer,integer,integer) IS
  'Atomically reserves grounding-query budget across concurrent edge requests; reservation auto-expires after ten minutes.';

COMMIT;
