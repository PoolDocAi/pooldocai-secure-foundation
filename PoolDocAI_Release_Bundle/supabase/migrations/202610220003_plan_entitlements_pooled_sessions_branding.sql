-- Migration 021: canonical three-plan entitlement model, pooled monthly troubleshooting sessions, and onboarding brand data.
-- Run on the active PoolDocAI Secure Foundation Supabase project. The Edge Function uses service_role only for RPC access.
BEGIN;

ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS monthly_session_allowance integer NOT NULL DEFAULT 200;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS widget_access_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_monthly_session_allowance_check;
ALTER TABLE public.companies ADD CONSTRAINT companies_monthly_session_allowance_check CHECK (monthly_session_allowance BETWEEN 0 AND 1000000);

-- Preserve the original platform-admin guard for browser sessions, while allowing the verified
-- Supabase service-role Stripe webhook to update subscription-derived plan/status fields.
CREATE OR REPLACE FUNCTION public.protect_company_plan_fields()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  request_role text := coalesce(auth.role(), current_setting('request.jwt.claim.role', true), '');
BEGIN
  IF request_role NOT IN ('service_role','supabase_admin') AND NOT public.is_platform_admin()
     AND (NEW.status IS DISTINCT FROM OLD.status
       OR NEW.plan_name IS DISTINCT FROM OLD.plan_name
       OR NEW.seat_limit IS DISTINCT FROM OLD.seat_limit
       OR NEW.billing_status IS DISTINCT FROM OLD.billing_status
       OR NEW.billing_customer_ref IS DISTINCT FROM OLD.billing_customer_ref
       OR NEW.billing_subscription_ref IS DISTINCT FROM OLD.billing_subscription_ref
       OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
       OR NEW.stripe_subscription_id IS DISTINCT FROM OLD.stripe_subscription_id
       OR NEW.stripe_price_id IS DISTINCT FROM OLD.stripe_price_id
       OR NEW.billing_period_start IS DISTINCT FROM OLD.billing_period_start
       OR NEW.current_period_end IS DISTINCT FROM OLD.current_period_end
       OR NEW.trial_ends_at IS DISTINCT FROM OLD.trial_ends_at
       OR NEW.monthly_session_allowance IS DISTINCT FROM OLD.monthly_session_allowance
       OR NEW.widget_access_enabled IS DISTINCT FROM OLD.widget_access_enabled) THEN
    RAISE EXCEPTION 'Only PoolDocAI platform administrators or trusted billing services can change plan, status, seat limits, or billing state.';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.protect_company_plan_fields() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.protect_company_plan_fields() TO service_role;

ALTER TABLE public.company_widget_configs ADD COLUMN IF NOT EXISTS logo_url text;
ALTER TABLE public.company_widget_configs ADD COLUMN IF NOT EXISTS brand_source_url text;
ALTER TABLE public.company_widget_configs ADD COLUMN IF NOT EXISTS brand_fetched_at timestamptz;
ALTER TABLE public.company_widget_configs ADD COLUMN IF NOT EXISTS brand_provider text;
ALTER TABLE public.company_widget_configs ADD COLUMN IF NOT EXISTS brand_setup_state text NOT NULL DEFAULT 'manual' CHECK (brand_setup_state IN ('manual','suggested','applied','unavailable'));
ALTER TABLE public.company_widget_configs DROP CONSTRAINT IF EXISTS company_widget_logo_url_https_check;
ALTER TABLE public.company_widget_configs ADD CONSTRAINT company_widget_logo_url_https_check CHECK (logo_url IS NULL OR (length(logo_url) <= 1200 AND logo_url ~ '^https://'));
ALTER TABLE public.company_widget_configs DROP CONSTRAINT IF EXISTS company_widget_brand_source_url_https_check;
ALTER TABLE public.company_widget_configs ADD CONSTRAINT company_widget_brand_source_url_https_check CHECK (brand_source_url IS NULL OR (length(brand_source_url) <= 400 AND brand_source_url ~ '^https://'));

-- One row per distinct company case per billing period. The session ID itself is never stored; only its SHA-256 digest is.
CREATE TABLE IF NOT EXISTS public.pooldocai_company_monthly_sessions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  session_hash text NOT NULL CHECK (session_hash ~ '^[a-f0-9]{64}$'),
  session_mode text NOT NULL DEFAULT 'unknown' CHECK (session_mode IN ('homeowner','technician','unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pooldocai_company_monthly_sessions_uidx UNIQUE(company_id,period_start,session_hash)
);
CREATE INDEX IF NOT EXISTS pooldocai_company_monthly_sessions_period_idx ON public.pooldocai_company_monthly_sessions(company_id,period_start,created_at DESC);
ALTER TABLE public.pooldocai_company_monthly_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pooldocai_company_monthly_sessions FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.pooldocai_company_monthly_sessions TO service_role;
DO $$
DECLARE sequence_name text;
BEGIN
  sequence_name := pg_get_serial_sequence('public.pooldocai_company_monthly_sessions', 'id');
  IF sequence_name IS NOT NULL THEN
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO service_role', sequence_name);
  END IF;
END $$;

ALTER TABLE public.companies DISABLE TRIGGER protect_company_plan_fields;

UPDATE public.companies SET plan_name = CASE lower(coalesce(plan_name,''))
  WHEN 'starter' THEN 'tech_only'
  WHEN 'tech_solo_route' THEN 'tech_only'
  WHEN 'tech_pro_team' THEN 'tech_only'
  WHEN 'tech_fleet' THEN 'tech_only'
  WHEN 'professional' THEN 'complete_team'
  WHEN 'complete_solo' THEN 'complete_team'
  WHEN 'complete_pro_team' THEN 'complete_team'
  WHEN 'enterprise' THEN 'complete_fleet'
  WHEN 'complete_fleet' THEN 'complete_fleet'
  WHEN 'pilot' THEN 'pilot'
  WHEN 'tech_only' THEN 'tech_only'
  WHEN 'complete_team' THEN 'complete_team'
  ELSE 'tech_only'
END
WHERE lower(coalesce(plan_name,'')) NOT IN ('tech_only','complete_team','complete_fleet','pilot');

CREATE OR REPLACE FUNCTION public.pooldocai_set_plan_entitlements()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  CASE lower(coalesce(NEW.plan_name,''))
    WHEN 'tech_only' THEN NEW.plan_name := 'tech_only'; NEW.seat_limit := 1; NEW.monthly_session_allowance := 200; NEW.widget_access_enabled := false;
    WHEN 'complete_team' THEN NEW.plan_name := 'complete_team'; NEW.seat_limit := 6; NEW.monthly_session_allowance := 1300; NEW.widget_access_enabled := true;
    WHEN 'complete_fleet' THEN NEW.plan_name := 'complete_fleet'; NEW.seat_limit := 15; NEW.monthly_session_allowance := 2800; NEW.widget_access_enabled := true;
    WHEN 'pilot' THEN NEW.plan_name := 'pilot'; NEW.seat_limit := greatest(coalesce(NEW.seat_limit,1),1); NEW.monthly_session_allowance := 5000; NEW.widget_access_enabled := true;
    ELSE NEW.monthly_session_allowance := 0; NEW.widget_access_enabled := false;
  END CASE;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pooldocai_set_plan_entitlements_trigger ON public.companies;
CREATE TRIGGER pooldocai_set_plan_entitlements_trigger BEFORE INSERT OR UPDATE OF plan_name ON public.companies
FOR EACH ROW EXECUTE FUNCTION public.pooldocai_set_plan_entitlements();

UPDATE public.companies SET plan_name = lower(coalesce(plan_name,'tech_only'));
ALTER TABLE public.companies ENABLE TRIGGER protect_company_plan_fields;

CREATE OR REPLACE FUNCTION public.pooldocai_consume_company_monthly_session(
  p_company_id uuid, p_session_hash text, p_session_mode text DEFAULT 'unknown'
)
RETURNS TABLE(allowed boolean, used integer, allowance integer, remaining integer, period_start date, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  c public.companies%ROWTYPE;
  v_period_start date;
  v_used integer;
  v_allowance integer;
  v_mode text;
BEGIN
  IF p_company_id IS NULL OR p_session_hash IS NULL OR p_session_hash !~ '^[a-f0-9]{64}$' THEN
    RETURN QUERY SELECT false,0,0,0,date_trunc('month',now())::date,'invalid_request'::text; RETURN;
  END IF;
  SELECT * INTO c FROM public.companies WHERE id=p_company_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false,0,0,0,date_trunc('month',now())::date,'company_not_found'::text; RETURN; END IF;
  IF coalesce(c.status,'') NOT IN ('active','pilot') THEN
    RETURN QUERY SELECT false,0,coalesce(c.monthly_session_allowance,0),0,date_trunc('month',now())::date,'company_inactive'::text; RETURN;
  END IF;
  v_allowance := greatest(coalesce(c.monthly_session_allowance,0),0);
  IF v_allowance <= 0 THEN
    RETURN QUERY SELECT false,0,v_allowance,0,date_trunc('month',now())::date,'plan_not_entitled'::text; RETURN;
  END IF;
  IF c.billing_period_start IS NOT NULL AND c.current_period_end IS NOT NULL AND now() >= c.billing_period_start AND now() < c.current_period_end THEN
    v_period_start := c.billing_period_start::date;
  ELSE
    v_period_start := date_trunc('month',now())::date;
  END IF;
  v_mode := CASE WHEN p_session_mode IN ('homeowner','technician') THEN p_session_mode ELSE 'unknown' END;
  IF EXISTS (SELECT 1 FROM public.pooldocai_company_monthly_sessions s WHERE s.company_id=p_company_id AND s.period_start=v_period_start AND s.session_hash=p_session_hash) THEN
    SELECT count(*)::integer INTO v_used FROM public.pooldocai_company_monthly_sessions s WHERE s.company_id=p_company_id AND s.period_start=v_period_start;
    RETURN QUERY SELECT true,v_used,v_allowance,greatest(v_allowance-v_used,0),v_period_start,'already_counted'::text; RETURN;
  END IF;
  SELECT count(*)::integer INTO v_used FROM public.pooldocai_company_monthly_sessions s WHERE s.company_id=p_company_id AND s.period_start=v_period_start;
  IF v_used >= v_allowance THEN
    RETURN QUERY SELECT false,v_used,v_allowance,0,v_period_start,'monthly_session_limit_reached'::text; RETURN;
  END IF;
  INSERT INTO public.pooldocai_company_monthly_sessions(company_id,period_start,session_hash,session_mode)
  VALUES(p_company_id,v_period_start,p_session_hash,v_mode)
  ON CONFLICT(company_id,period_start,session_hash) DO NOTHING;
  SELECT count(*)::integer INTO v_used FROM public.pooldocai_company_monthly_sessions s WHERE s.company_id=p_company_id AND s.period_start=v_period_start;
  RETURN QUERY SELECT (v_used<=v_allowance),v_used,v_allowance,greatest(v_allowance-v_used,0),v_period_start,
    CASE WHEN v_used<=v_allowance THEN 'counted' ELSE 'monthly_session_limit_reached' END::text;
END $$;

CREATE OR REPLACE FUNCTION public.pooldocai_get_company_session_usage(p_company_ids uuid[])
RETURNS TABLE(company_id uuid, period_start date, sessions_used integer, sessions_allowance integer, sessions_remaining integer, widget_access_enabled boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH selected AS (
    SELECT c.id,c.monthly_session_allowance,c.widget_access_enabled,
      CASE WHEN c.billing_period_start IS NOT NULL AND c.current_period_end IS NOT NULL AND now() >= c.billing_period_start AND now() < c.current_period_end
        THEN c.billing_period_start::date ELSE date_trunc('month',now())::date END AS pstart
    FROM public.companies c WHERE c.id=ANY(coalesce(p_company_ids,'{}'::uuid[]))
  ), counts AS (
    SELECT s.company_id,s.period_start,count(*)::integer AS used FROM public.pooldocai_company_monthly_sessions s
    JOIN selected c ON c.id=s.company_id AND c.pstart=s.period_start GROUP BY s.company_id,s.period_start
  )
  SELECT c.id,c.pstart,coalesce(n.used,0),coalesce(c.monthly_session_allowance,0),greatest(coalesce(c.monthly_session_allowance,0)-coalesce(n.used,0),0),c.widget_access_enabled
  FROM selected c LEFT JOIN counts n ON n.company_id=c.id AND n.period_start=c.pstart
$$;
REVOKE ALL ON FUNCTION public.pooldocai_set_plan_entitlements() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pooldocai_consume_company_monthly_session(uuid,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pooldocai_get_company_session_usage(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_consume_company_monthly_session(uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.pooldocai_get_company_session_usage(uuid[]) TO service_role;

COMMENT ON COLUMN public.companies.monthly_session_allowance IS 'Server-enforced total distinct diagnostic sessions per billing period, pooled across technician and customer-widget access.';
COMMENT ON COLUMN public.companies.widget_access_enabled IS 'Derived from canonical plan entitlement; tech_only is false and Complete plans/pilot are true.';
COMMENT ON TABLE public.pooldocai_company_monthly_sessions IS 'Privacy-preserving pooled monthly session ledger; only SHA-256 session digests are retained.';
COMMIT;
