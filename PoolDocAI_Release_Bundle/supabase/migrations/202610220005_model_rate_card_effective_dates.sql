-- Migration 023: effective-dated model rates for the models currently used by PoolDocAI.
BEGIN;

-- Source: Google Gemini Developer API official pricing page, standard paid tier:
-- https://ai.google.dev/gemini-api/docs/pricing
-- Gemini 3.8 Flash: $0.75/$3.75 per million input/output tokens through 2026-12-31;
-- $1.50/$7.50 starting 2027-01-01. Gemini 2.5 Flash: $0.30/$2.50;
-- Gemini 2.5 Flash-Lite: $0.10/$0.40; Gemini Embedding 001: $0.15/input token million.
-- Rates are estimates only; provider invoices remain authoritative.
-- Idempotent, audit preserving, and does not grant runtime/API access.
DO $$
BEGIN
  IF to_regclass('public.pooldocai_model_rate_cards') IS NULL THEN
    RAISE EXCEPTION 'Apply migration 012 before migration 023: pooldocai_model_rate_cards is missing';
  END IF;
  IF EXISTS (
    SELECT required.column_name
    FROM (VALUES ('provider'),('model'),('input_usd_per_million_tokens'),('output_usd_per_million_tokens'),('active'),('valid_from'),('valid_to')) AS required(column_name)
    WHERE NOT EXISTS (
      SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.table_name='pooldocai_model_rate_cards' AND c.column_name=required.column_name
    )
  ) THEN
    RAISE EXCEPTION 'Rate-card schema is incomplete; migration 012 must be repaired before migration 023';
  END IF;
END $$;

UPDATE public.pooldocai_model_rate_cards
SET active=false, valid_to='2026-10-22 00:00:00+00'::timestamptz
WHERE provider='google_gemini'
  AND model='gemini-3.8-flash'
  AND active=true
  AND valid_from < '2026-10-22 00:00:00+00'::timestamptz
  AND (valid_to IS NULL OR valid_to > '2026-10-22 00:00:00+00'::timestamptz);

UPDATE public.pooldocai_model_rate_cards
SET active=false, valid_to='2026-10-22 00:00:00+00'::timestamptz
WHERE provider='google_gemini'
  AND model IN ('gemini-2.5-flash','gemini-2.5-flash-lite','gemini-embedding-001')
  AND active=true
  AND valid_from < '2026-10-22 00:00:00+00'::timestamptz
  AND (valid_to IS NULL OR valid_to > '2026-10-22 00:00:00+00'::timestamptz);

WITH defaults(provider,model,input_rate,output_rate,valid_from,preferred_valid_to) AS (
  VALUES
    ('google_gemini'::text,'gemini-2.5-flash'::text,0.30::numeric,2.50::numeric,'2026-10-22 00:00:00+00'::timestamptz,NULL::timestamptz),
    ('google_gemini'::text,'gemini-2.5-flash-lite'::text,0.10::numeric,0.40::numeric,'2026-10-22 00:00:00+00'::timestamptz,NULL::timestamptz),
    ('google_gemini'::text,'gemini-embedding-001'::text,0.15::numeric,NULL::numeric,'2026-10-22 00:00:00+00'::timestamptz,NULL::timestamptz),
    ('google_gemini'::text,'gemini-3.8-flash'::text,0.75::numeric,3.75::numeric,'2026-10-22 00:00:00+00'::timestamptz,'2027-01-01 00:00:00+00'::timestamptz)
)
INSERT INTO public.pooldocai_model_rate_cards
  (provider,model,input_usd_per_million_tokens,output_usd_per_million_tokens,active,valid_from,valid_to)
SELECT d.provider,d.model,d.input_rate,d.output_rate,true,d.valid_from,
       CASE WHEN d.preferred_valid_to IS NOT NULL THEN LEAST(d.preferred_valid_to,future_rates.next_start)
            ELSE future_rates.next_start END
FROM defaults d
LEFT JOIN LATERAL (
  SELECT min(f.valid_from) AS next_start FROM public.pooldocai_model_rate_cards f
  WHERE f.provider=d.provider AND f.model=d.model AND f.active=true AND f.valid_from>d.valid_from
) future_rates ON true
ON CONFLICT (provider,model,valid_from) DO NOTHING;

INSERT INTO public.pooldocai_model_rate_cards
  (provider,model,input_usd_per_million_tokens,output_usd_per_million_tokens,active,valid_from,valid_to)
VALUES ('google_gemini','gemini-3.8-flash',1.50,7.50,true,'2027-01-01 00:00:00+00'::timestamptz,NULL)
ON CONFLICT (provider,model,valid_from) DO NOTHING;

WITH ordered_active_rates AS (
  SELECT id, LEAD(valid_from) OVER (PARTITION BY provider,model ORDER BY valid_from) AS next_start
  FROM public.pooldocai_model_rate_cards
  WHERE provider='google_gemini'
    AND model IN ('gemini-2.5-flash','gemini-2.5-flash-lite','gemini-embedding-001','gemini-3.8-flash')
    AND active=true
)
UPDATE public.pooldocai_model_rate_cards AS rate
SET valid_to=ordered_active_rates.next_start
FROM ordered_active_rates
WHERE rate.id=ordered_active_rates.id
  AND ordered_active_rates.next_start IS NOT NULL
  AND (rate.valid_to IS NULL OR rate.valid_to > ordered_active_rates.next_start);

COMMENT ON TABLE public.pooldocai_model_rate_cards IS
  'Versioned estimate-only provider prices with effective intervals. Do not use estimates as a substitute for the provider billing console.';

COMMIT;
