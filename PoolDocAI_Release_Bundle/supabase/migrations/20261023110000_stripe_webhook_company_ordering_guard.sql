-- Migration 035: Per-company transactionally serialized ordering check for Stripe webhook processing.
-- Forward-only and additive.
BEGIN;

-- Update pooldocai_apply_and_finalize_stripe_webhook with row-level company locking and conditional state ordering
CREATE OR REPLACE FUNCTION public.pooldocai_apply_and_finalize_stripe_webhook(
  p_event_id text,
  p_claim_token text,
  p_company_id uuid DEFAULT NULL,
  p_company_updates jsonb DEFAULT NULL,
  p_usage_event jsonb DEFAULT NULL,
  p_processing_note text DEFAULT NULL,
  p_ignored boolean DEFAULT false
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE
  v_row public.pooldocai_stripe_webhook_events%ROWTYPE;
  v_company public.companies%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_seat_limit integer;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_trial_ends_at timestamptz;
  v_incoming_sub_id text;
  v_incoming_status text;
  v_incoming_billing_status text;
  v_is_stale_period boolean := false;
  v_is_old_subscription boolean := false;
  v_stale_reason text := NULL;
BEGIN
  -- Set transaction-local claim role to service_role so downstream security triggers recognize trusted billing service
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);

  -- Strict validation of claim token: empty/unknown tokens are rejected
  IF p_claim_token IS NULL OR trim(p_claim_token) = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'invalid_claim_token',
      'error', 'A non-empty claim ownership token is required to finalize webhook events'
    );
  END IF;

  -- 1. Exclusively lock the webhook event row
  SELECT * INTO v_row
  FROM public.pooldocai_stripe_webhook_events
  WHERE stripe_event_id = p_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'not_found',
      'error', 'Webhook event row not found'
    );
  END IF;

  -- Fencing check 1: Event already finalized
  IF v_row.processed THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'already_processed',
      'fenced', true,
      'error', 'Webhook event was already finalized by another worker'
    );
  END IF;

  -- Fencing check 2: Worker claim token must match active lease exactly
  IF v_row.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'fenced_out',
      'fenced', true,
      'error', 'Stale claim token: lease expired or ownership claimed by a newer worker'
    );
  END IF;

  -- 2. Company billing update branch
  IF NOT p_ignored AND p_company_id IS NOT NULL AND p_company_updates IS NOT NULL AND jsonb_typeof(p_company_updates) = 'object' THEN
    -- Exclusively lock the company row to serialize concurrent events targeting the same company
    SELECT * INTO v_company
    FROM public.companies
    WHERE id = p_company_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'success', false,
        'status', 'company_not_found',
        'error', 'Target company not found for billing update'
      );
    END IF;

    -- Extract update values for type casting and ordering comparison
    IF (p_company_updates->>'seat_limit') IS NOT NULL THEN
      v_seat_limit := (p_company_updates->>'seat_limit')::integer;
    END IF;
    IF (p_company_updates->>'billing_period_start') IS NOT NULL THEN
      v_period_start := (p_company_updates->>'billing_period_start')::timestamptz;
    END IF;
    IF (p_company_updates->>'current_period_end') IS NOT NULL THEN
      v_period_end := (p_company_updates->>'current_period_end')::timestamptz;
    END IF;
    IF (p_company_updates->>'trial_ends_at') IS NOT NULL THEN
      v_trial_ends_at := (p_company_updates->>'trial_ends_at')::timestamptz;
    END IF;

    v_incoming_sub_id := p_company_updates->>'stripe_subscription_id';
    v_incoming_status := p_company_updates->>'status';
    v_incoming_billing_status := p_company_updates->>'billing_status';

    -- Database-side conditional ordering guard A: Stale billing period
    -- If company already has a recorded period start, an incoming update with an older period start is stale
    IF v_period_start IS NOT NULL AND v_company.billing_period_start IS NOT NULL AND v_period_start < v_company.billing_period_start THEN
      v_is_stale_period := true;
      v_stale_reason := 'stale_out_of_order_event';
    END IF;

    -- Database-side conditional ordering guard B: Superseded subscription
    -- If company has an active subscription ID and incoming update is from a different subscription
    IF v_company.stripe_subscription_id IS NOT NULL AND v_incoming_sub_id IS NOT NULL AND v_incoming_sub_id <> v_company.stripe_subscription_id THEN
      IF (
        v_row.event_type = 'customer.subscription.deleted'
        OR v_row.event_type LIKE 'invoice.%'
        OR v_incoming_status = 'cancelled'
        OR v_incoming_billing_status = 'cancelled'
        OR v_period_start IS NULL
        OR v_company.billing_period_start IS NULL
        OR v_period_start <= v_company.billing_period_start
      ) THEN
        v_is_old_subscription := true;
        v_stale_reason := CASE WHEN v_row.event_type LIKE 'invoice.%' THEN 'stale_old_subscription_invoice' ELSE 'stale_old_subscription' END;
      END IF;
    END IF;

    -- If the event is determined to be stale under the company lock, safely finalize it as ignored
    IF v_is_stale_period OR v_is_old_subscription THEN
      UPDATE public.pooldocai_stripe_webhook_events
      SET processed = true,
          processed_at = v_now,
          claimed_at = NULL,
          claim_token = NULL,
          processing_error = CASE 
            WHEN v_is_old_subscription THEN 'Stale event from superseded subscription skipped (newer subscription active in database).'
            ELSE 'Stale out-of-order event skipped (newer period already active in database).'
          END
      WHERE stripe_event_id = p_event_id;

      RETURN jsonb_build_object(
        'success', true,
        'status', 'ignored',
        'reason', v_stale_reason,
        'processed', true,
        'lease_generation', v_row.lease_generation
      );
    END IF;

    -- Conditional checks passed: update company billing fields
    UPDATE public.companies
    SET
      stripe_customer_id = COALESCE(p_company_updates->>'stripe_customer_id', stripe_customer_id),
      billing_customer_ref = COALESCE(p_company_updates->>'billing_customer_ref', billing_customer_ref),
      stripe_subscription_id = COALESCE(v_incoming_sub_id, stripe_subscription_id),
      billing_subscription_ref = COALESCE(p_company_updates->>'billing_subscription_ref', billing_subscription_ref),
      billing_status = COALESCE(v_incoming_billing_status, billing_status),
      stripe_price_id = COALESCE(p_company_updates->>'stripe_price_id', stripe_price_id),
      plan_name = COALESCE(p_company_updates->>'plan_name', plan_name),
      seat_limit = COALESCE(v_seat_limit, seat_limit),
      billing_period_start = COALESCE(v_period_start, billing_period_start),
      current_period_end = COALESCE(v_period_end, current_period_end),
      trial_ends_at = COALESCE(v_trial_ends_at, trial_ends_at),
      status = COALESCE(v_incoming_status, status),
      updated_at = v_now
    WHERE id = p_company_id;

    -- Insert into platform_usage_events (if provided)
    IF p_usage_event IS NOT NULL AND jsonb_typeof(p_usage_event) = 'object' THEN
      INSERT INTO public.platform_usage_events (
        company_id, event_type, units, metric_type, quantity, quantity_unit, source_event_key, metadata
      ) VALUES (
        p_company_id,
        COALESCE(p_usage_event->>'event_type', 'stripe_' || v_row.event_type),
        COALESCE((p_usage_event->>'units')::integer, 1),
        COALESCE(p_usage_event->>'metric_type', 'billing_event'),
        COALESCE((p_usage_event->>'quantity')::integer, 1),
        COALESCE(p_usage_event->>'quantity_unit', 'webhook_event'),
        p_event_id,
        COALESCE(p_usage_event->'metadata', '{}'::jsonb)
      );
    END IF;
  END IF;

  -- 3. Mark event processed and clear claim
  UPDATE public.pooldocai_stripe_webhook_events
  SET processed = true,
      processed_at = v_now,
      claimed_at = NULL,
      claim_token = NULL,
      processing_error = p_processing_note
  WHERE stripe_event_id = p_event_id;

  RETURN jsonb_build_object(
    'success', true,
    'status', CASE WHEN p_ignored THEN 'ignored' ELSE 'applied' END,
    'processed', true,
    'lease_generation', v_row.lease_generation
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_apply_and_finalize_stripe_webhook(text, text, uuid, jsonb, jsonb, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_apply_and_finalize_stripe_webhook(text, text, uuid, jsonb, jsonb, text, boolean) TO service_role;

COMMIT;
