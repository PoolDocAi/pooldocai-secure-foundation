-- Migration 024: tenant-scoped, plan-gated outbound service-request webhooks.
-- Delivery runs in the document worker so DNS can be pinned at the socket layer.
BEGIN;

CREATE TABLE IF NOT EXISTS public.company_service_webhook_configs (
  company_id uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  target_url text,
  signing_secret text NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_service_webhook_url_https CHECK (target_url IS NULL OR (target_url ~ '^https://[^[:space:]]+$' AND length(target_url) <= 2000)),
  CONSTRAINT company_service_webhook_secret_len CHECK (length(signing_secret) >= 32)
);

CREATE TABLE IF NOT EXISTS public.service_request_webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  service_request_id uuid NOT NULL REFERENCES public.service_requests(id) ON DELETE CASCADE,
  event_type text NOT NULL DEFAULT 'service_request.created',
  payload jsonb NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','delivered','retrying','failed','skipped')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  response_status integer,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS service_request_webhook_due_idx ON public.service_request_webhook_deliveries(status,next_attempt_at,created_at);
CREATE INDEX IF NOT EXISTS service_request_webhook_tenant_idx ON public.service_request_webhook_deliveries(company_id,created_at DESC);

ALTER TABLE public.company_service_webhook_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.service_request_webhook_deliveries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS company_service_webhook_configs_no_client_access ON public.company_service_webhook_configs;
CREATE POLICY company_service_webhook_configs_no_client_access ON public.company_service_webhook_configs FOR ALL TO anon,authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS service_request_webhook_deliveries_no_client_access ON public.service_request_webhook_deliveries;
CREATE POLICY service_request_webhook_deliveries_no_client_access ON public.service_request_webhook_deliveries FOR ALL TO anon,authenticated USING (false) WITH CHECK (false);
REVOKE ALL ON public.company_service_webhook_configs, public.service_request_webhook_deliveries FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.company_service_webhook_configs, public.service_request_webhook_deliveries TO service_role;

CREATE OR REPLACE FUNCTION public.pooldocai_enqueue_service_request_webhook()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  company_tier text;
  company_plan text;
  config_enabled boolean;
BEGIN
  SELECT coalesce(c.company_size_tier,''), coalesce(c.plan_name,'')
    INTO company_tier, company_plan FROM public.companies c WHERE c.id=NEW.company_id;
  IF NOT (company_tier IN ('pro_team','fleet') OR company_plan LIKE 'pro_team_%' OR company_plan LIKE 'fleet_%') THEN
    RETURN NEW;
  END IF;
  SELECT w.enabled INTO config_enabled FROM public.company_service_webhook_configs w WHERE w.company_id=NEW.company_id;
  IF coalesce(config_enabled,false) IS NOT TRUE THEN RETURN NEW; END IF;
  INSERT INTO public.service_request_webhook_deliveries(company_id,service_request_id,event_type,payload,idempotency_key)
  VALUES (
    NEW.company_id, NEW.id, 'service_request.created',
    jsonb_build_object(
      'id', NEW.id,
      'event', 'service_request.created',
      'created_at', NEW.created_at,
      'status', NEW.status,
      'priority', NEW.priority,
      'source_type', NEW.source_type,
      'diagnostic_case_id', NEW.diagnostic_case_id
    ),
    NEW.company_id::text || ':' || NEW.id::text || ':service_request.created'
  ) ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS service_request_webhook_enqueue ON public.service_requests;
CREATE TRIGGER service_request_webhook_enqueue AFTER INSERT ON public.service_requests
FOR EACH ROW EXECUTE FUNCTION public.pooldocai_enqueue_service_request_webhook();
REVOKE ALL ON FUNCTION public.pooldocai_enqueue_service_request_webhook() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_enqueue_service_request_webhook() TO service_role;

CREATE OR REPLACE FUNCTION public.pooldocai_claim_service_request_webhook()
RETURNS SETOF public.service_request_webhook_deliveries
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE picked public.service_request_webhook_deliveries;
BEGIN
  UPDATE public.service_request_webhook_deliveries
    SET status='failed',last_error_code='worker_lease_expired_max_attempts',updated_at=now()
    WHERE status='sending' AND last_attempt_at < now()-interval '2 minutes' AND attempt_count >= 8;
  SELECT * INTO picked FROM public.service_request_webhook_deliveries
  WHERE ((status IN ('pending','retrying') AND next_attempt_at <= now())
      OR (status='sending' AND last_attempt_at < now()-interval '2 minutes'))
    AND attempt_count < 8
  ORDER BY next_attempt_at,created_at LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.service_request_webhook_deliveries SET status='sending',attempt_count=attempt_count+1,last_attempt_at=now(),updated_at=now()
  WHERE id=picked.id RETURNING * INTO picked;
  RETURN NEXT picked;
END $$;

CREATE OR REPLACE FUNCTION public.pooldocai_finish_service_request_webhook(
  p_delivery_id uuid, p_success boolean, p_response_status integer DEFAULT NULL, p_error_code text DEFAULT NULL, p_retryable boolean DEFAULT false
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE current_attempt integer;
BEGIN
  SELECT attempt_count INTO current_attempt FROM public.service_request_webhook_deliveries WHERE id=p_delivery_id FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  IF p_success THEN
    UPDATE public.service_request_webhook_deliveries SET status='delivered',delivered_at=now(),response_status=p_response_status,last_error_code=NULL,updated_at=now() WHERE id=p_delivery_id;
  ELSIF p_retryable AND current_attempt < 8 THEN
    UPDATE public.service_request_webhook_deliveries SET status='retrying',response_status=p_response_status,last_error_code=left(coalesce(p_error_code,'delivery_failed'),80),next_attempt_at=now()+make_interval(secs => LEAST(3600, 15 * power(2, GREATEST(current_attempt-1,0))::integer)),updated_at=now() WHERE id=p_delivery_id;
  ELSE
    UPDATE public.service_request_webhook_deliveries SET status='failed',response_status=p_response_status,last_error_code=left(coalesce(p_error_code,'delivery_failed'),80),updated_at=now() WHERE id=p_delivery_id;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.pooldocai_claim_service_request_webhook() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.pooldocai_finish_service_request_webhook(uuid,boolean,integer,text,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_claim_service_request_webhook() TO service_role;
GRANT EXECUTE ON FUNCTION public.pooldocai_finish_service_request_webhook(uuid,boolean,integer,text,boolean) TO service_role;

COMMIT;
