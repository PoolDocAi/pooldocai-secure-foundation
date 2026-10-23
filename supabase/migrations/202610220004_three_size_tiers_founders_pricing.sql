-- Migration 022: three company-size tiers, Tech-Only/Complete access modes,
-- distinct pooled-session allowances, and explicit single-use Founders offer eligibility.
BEGIN;

ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS company_size_tier text NOT NULL DEFAULT 'solo_route';
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS subscription_access_mode text NOT NULL DEFAULT 'tech_only';
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS founders_eligible boolean NOT NULL DEFAULT false;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS founders_offer_expires_at timestamptz;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS founders_rate_active boolean NOT NULL DEFAULT false;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS founders_used_at timestamptz;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS founders_checkout_reserved_until timestamptz;
ALTER TABLE public.companies ADD COLUMN IF NOT EXISTS founders_checkout_session_id text;

ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_company_size_tier_check;
ALTER TABLE public.companies ADD CONSTRAINT companies_company_size_tier_check
  CHECK (company_size_tier IN ('solo_route','pro_team','fleet'));
ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_subscription_access_mode_check;
ALTER TABLE public.companies ADD CONSTRAINT companies_subscription_access_mode_check
  CHECK (subscription_access_mode IN ('tech_only','complete'));
ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_founders_eligibility_expiry_check;
ALTER TABLE public.companies ADD CONSTRAINT companies_founders_eligibility_expiry_check
  CHECK (NOT founders_eligible OR founders_offer_expires_at IS NOT NULL);
ALTER TABLE public.companies DROP CONSTRAINT IF EXISTS companies_founders_redemption_check;
ALTER TABLE public.companies ADD CONSTRAINT companies_founders_redemption_check
  CHECK (NOT founders_rate_active OR founders_used_at IS NOT NULL);

-- Extend the existing plan-field guard. Only trusted billing services (service_role)
-- or an explicitly registered platform administrator can change plan or Founders fields.
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
       OR NEW.widget_access_enabled IS DISTINCT FROM OLD.widget_access_enabled
       OR NEW.company_size_tier IS DISTINCT FROM OLD.company_size_tier
       OR NEW.subscription_access_mode IS DISTINCT FROM OLD.subscription_access_mode
       OR NEW.founders_eligible IS DISTINCT FROM OLD.founders_eligible
       OR NEW.founders_offer_expires_at IS DISTINCT FROM OLD.founders_offer_expires_at
       OR NEW.founders_rate_active IS DISTINCT FROM OLD.founders_rate_active
       OR NEW.founders_used_at IS DISTINCT FROM OLD.founders_used_at
       OR NEW.founders_checkout_reserved_until IS DISTINCT FROM OLD.founders_checkout_reserved_until
       OR NEW.founders_checkout_session_id IS DISTINCT FROM OLD.founders_checkout_session_id) THEN
    RAISE EXCEPTION 'Only PoolDocAI platform administrators or trusted billing services can change subscription entitlements or Founders offer fields.';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.protect_company_plan_fields() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.protect_company_plan_fields() TO service_role;

CREATE OR REPLACE FUNCTION public.pooldocai_set_plan_entitlements()
RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  CASE lower(coalesce(NEW.plan_name,''))
    WHEN 'solo_tech_only' THEN NEW.plan_name := 'solo_tech_only'; NEW.company_size_tier := 'solo_route'; NEW.subscription_access_mode := 'tech_only'; NEW.seat_limit := 2; NEW.monthly_session_allowance := 250; NEW.widget_access_enabled := false;
    WHEN 'solo_complete' THEN NEW.plan_name := 'solo_complete'; NEW.company_size_tier := 'solo_route'; NEW.subscription_access_mode := 'complete'; NEW.seat_limit := 2; NEW.monthly_session_allowance := 350; NEW.widget_access_enabled := true;
    WHEN 'pro_team_tech_only' THEN NEW.plan_name := 'pro_team_tech_only'; NEW.company_size_tier := 'pro_team'; NEW.subscription_access_mode := 'tech_only'; NEW.seat_limit := 6; NEW.monthly_session_allowance := 750; NEW.widget_access_enabled := false;
    WHEN 'pro_team_complete' THEN NEW.plan_name := 'pro_team_complete'; NEW.company_size_tier := 'pro_team'; NEW.subscription_access_mode := 'complete'; NEW.seat_limit := 6; NEW.monthly_session_allowance := 1000; NEW.widget_access_enabled := true;
    WHEN 'fleet_tech_only' THEN NEW.plan_name := 'fleet_tech_only'; NEW.company_size_tier := 'fleet'; NEW.subscription_access_mode := 'tech_only'; NEW.seat_limit := 15; NEW.monthly_session_allowance := 2000; NEW.widget_access_enabled := false;
    WHEN 'fleet_complete' THEN NEW.plan_name := 'fleet_complete'; NEW.company_size_tier := 'fleet'; NEW.subscription_access_mode := 'complete'; NEW.seat_limit := 15; NEW.monthly_session_allowance := 2500; NEW.widget_access_enabled := true;
    WHEN 'legacy_tech_only' THEN NEW.plan_name := 'legacy_tech_only'; NEW.company_size_tier := 'solo_route'; NEW.subscription_access_mode := 'tech_only'; NEW.seat_limit := 1; NEW.monthly_session_allowance := 200; NEW.widget_access_enabled := false;
    WHEN 'legacy_complete_team' THEN NEW.plan_name := 'legacy_complete_team'; NEW.company_size_tier := 'pro_team'; NEW.subscription_access_mode := 'complete'; NEW.seat_limit := 6; NEW.monthly_session_allowance := 1300; NEW.widget_access_enabled := true;
    WHEN 'legacy_complete_fleet' THEN NEW.plan_name := 'legacy_complete_fleet'; NEW.company_size_tier := 'fleet'; NEW.subscription_access_mode := 'complete'; NEW.seat_limit := 15; NEW.monthly_session_allowance := 2800; NEW.widget_access_enabled := true;
    WHEN 'pilot' THEN NEW.plan_name := 'pilot'; NEW.company_size_tier := coalesce(NEW.company_size_tier,'solo_route'); NEW.subscription_access_mode := 'complete'; NEW.seat_limit := greatest(coalesce(NEW.seat_limit,1),1); NEW.monthly_session_allowance := 5000; NEW.widget_access_enabled := true;
    ELSE NEW.monthly_session_allowance := 0; NEW.widget_access_enabled := false;
  END CASE;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pooldocai_set_plan_entitlements_trigger ON public.companies;
CREATE TRIGGER pooldocai_set_plan_entitlements_trigger BEFORE INSERT OR UPDATE OF plan_name ON public.companies
FOR EACH ROW EXECUTE FUNCTION public.pooldocai_set_plan_entitlements();

ALTER TABLE public.companies DISABLE TRIGGER protect_company_plan_fields;
UPDATE public.companies
SET plan_name = CASE lower(coalesce(plan_name,''))
  WHEN 'pilot' THEN 'pilot'
  WHEN 'tech_only' THEN CASE WHEN stripe_subscription_id IS NOT NULL OR billing_subscription_ref IS NOT NULL THEN 'legacy_tech_only' ELSE 'solo_tech_only' END
  WHEN 'starter' THEN 'solo_tech_only'
  WHEN 'tech_solo_route' THEN 'solo_tech_only'
  WHEN 'tech_pro_team' THEN 'pro_team_tech_only'
  WHEN 'tech_fleet' THEN 'fleet_tech_only'
  WHEN 'complete_solo' THEN 'solo_complete'
  WHEN 'complete_team' THEN CASE WHEN stripe_subscription_id IS NOT NULL OR billing_subscription_ref IS NOT NULL THEN 'legacy_complete_team' ELSE 'pro_team_complete' END
  WHEN 'professional' THEN 'pro_team_complete'
  WHEN 'complete_pro_team' THEN 'pro_team_complete'
  WHEN 'complete_fleet' THEN CASE WHEN stripe_subscription_id IS NOT NULL OR billing_subscription_ref IS NOT NULL THEN 'legacy_complete_fleet' ELSE 'fleet_complete' END
  WHEN 'enterprise' THEN 'fleet_complete'
  WHEN 'solo_tech_only' THEN 'solo_tech_only'
  WHEN 'solo_complete' THEN 'solo_complete'
  WHEN 'pro_team_tech_only' THEN 'pro_team_tech_only'
  WHEN 'pro_team_complete' THEN 'pro_team_complete'
  WHEN 'fleet_tech_only' THEN 'fleet_tech_only'
  WHEN 'fleet_complete' THEN 'fleet_complete'
  WHEN 'legacy_tech_only' THEN 'legacy_tech_only'
  WHEN 'legacy_complete_team' THEN 'legacy_complete_team'
  WHEN 'legacy_complete_fleet' THEN 'legacy_complete_fleet'
  ELSE 'solo_tech_only'
END;
ALTER TABLE public.companies ENABLE TRIGGER protect_company_plan_fields;

COMMENT ON COLUMN public.companies.plan_name IS 'Canonical billable SKU: one of six company-size/access-mode combinations, or platform-granted pilot.';
COMMENT ON COLUMN public.companies.company_size_tier IS 'Subscription size tier: solo_route, pro_team, or fleet; derived from plan_name.';
COMMENT ON COLUMN public.companies.subscription_access_mode IS 'Subscription access mode: tech_only or complete; derived from plan_name.';
COMMENT ON COLUMN public.companies.monthly_session_allowance IS 'Plan-derived distinct diagnostic cases per monthly billing period, pooled across company users and access channels.';
COMMENT ON COLUMN public.companies.founders_eligible IS 'Platform-admin-controlled eligibility for a single Founders-price checkout before founders_offer_expires_at.';
COMMENT ON COLUMN public.companies.founders_offer_expires_at IS 'Required timestamp deadline for initiating the first Founders-price checkout. Founders checkout must remain disabled until the stated 24-month introductory term and Stripe subscription-price transition are implemented and verified.';
COMMENT ON COLUMN public.companies.founders_rate_active IS 'Set by verified Stripe subscription webhook while a mapped Founders recurring Price is active.';
COMMENT ON COLUMN public.companies.founders_used_at IS 'Permanent first redemption timestamp; a canceled Founders subscription cannot redeem the offer again.';
COMMENT ON COLUMN public.companies.founders_checkout_reserved_until IS 'Short-lived atomic reservation preventing concurrent double redemption; Stripe checkout expires before this reservation.';
COMMENT ON COLUMN public.companies.founders_checkout_session_id IS 'Stripe Checkout Session ID currently reserving the Founders offer, cleared after verified subscription activation or checkout expiration.';

CREATE OR REPLACE FUNCTION public.pooldocai_reserve_founders_checkout(
  p_company_id uuid, p_reservation_until timestamptz
)
RETURNS TABLE(reserved boolean, reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c public.companies%ROWTYPE;
BEGIN
  IF p_company_id IS NULL OR p_reservation_until IS NULL OR p_reservation_until <= now() OR p_reservation_until > now() + interval '40 minutes' THEN
    RETURN QUERY SELECT false, 'invalid_reservation_window'::text; RETURN;
  END IF;
  SELECT * INTO c FROM public.companies WHERE id=p_company_id FOR UPDATE;
  IF NOT FOUND THEN RETURN QUERY SELECT false, 'company_not_found'::text; RETURN; END IF;
  IF c.founders_eligible IS DISTINCT FROM true OR c.founders_offer_expires_at IS NULL OR c.founders_offer_expires_at <= now() THEN
    RETURN QUERY SELECT false, 'founders_offer_not_eligible'::text; RETURN;
  END IF;
  IF c.founders_used_at IS NOT NULL THEN
    RETURN QUERY SELECT false, 'founders_offer_already_redeemed'::text; RETURN;
  END IF;
  IF c.stripe_subscription_id IS NOT NULL AND c.billing_status IN ('active','trialing','past_due') THEN
    RETURN QUERY SELECT false, 'existing_subscription'::text; RETURN;
  END IF;
  IF c.founders_checkout_reserved_until IS NOT NULL AND c.founders_checkout_reserved_until > now() THEN
    RETURN QUERY SELECT false, 'founders_checkout_in_progress'::text; RETURN;
  END IF;
  UPDATE public.companies SET founders_checkout_reserved_until=p_reservation_until, founders_checkout_session_id=NULL
    WHERE id=p_company_id;
  RETURN QUERY SELECT true, 'reserved'::text;
END $$;
REVOKE ALL ON FUNCTION public.pooldocai_reserve_founders_checkout(uuid,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_reserve_founders_checkout(uuid,timestamptz) TO service_role;
COMMIT;
