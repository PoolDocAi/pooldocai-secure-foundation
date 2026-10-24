-- Migration 034: Stripe webhook claim ownership fencing, atomic billing application, and lease governance.
-- Forward-only and additive.
BEGIN;

-- 1. Add claim_token and lease_generation to pooldocai_stripe_webhook_events if they do not exist
ALTER TABLE public.pooldocai_stripe_webhook_events
  ADD COLUMN IF NOT EXISTS claim_token text,
  ADD COLUMN IF NOT EXISTS lease_generation integer NOT NULL DEFAULT 0;

-- Ensure pgcrypto extension is available for secure random token generation
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- 2. Function: pooldocai_claim_stripe_webhook_event (updated with claim token and lease generation)
CREATE OR REPLACE FUNCTION public.pooldocai_claim_stripe_webhook_event(
  p_event_id text,
  p_event_type text,
  p_lock_timeout_seconds integer DEFAULT 60,
  p_max_attempts integer DEFAULT 5
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE
  v_row public.pooldocai_stripe_webhook_events%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_remaining_seconds integer;
  v_new_token text;
  v_new_gen integer;
BEGIN
  IF p_event_id IS NULL OR trim(p_event_id) = '' THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'Event ID cannot be empty');
  END IF;

  -- Insert placeholder row if this is the first delivery of this event ID
  INSERT INTO public.pooldocai_stripe_webhook_events (
    stripe_event_id, event_type, processed, attempts, lease_generation
  ) VALUES (
    p_event_id, p_event_type, false, 0, 0
  )
  ON CONFLICT (stripe_event_id) DO NOTHING;

  -- Exclusively lock the row for atomic inspection and state transition
  SELECT * INTO v_row
  FROM public.pooldocai_stripe_webhook_events
  WHERE stripe_event_id = p_event_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'error', 'message', 'Event row missing after insert');
  END IF;

  -- A. If already fully processed, acknowledge idempotently as duplicate
  IF v_row.processed THEN
    RETURN jsonb_build_object(
      'status', 'already_processed',
      'processed', true,
      'duplicate', true,
      'lease_generation', v_row.lease_generation
    );
  END IF;

  -- B. If currently claimed and the lease has NOT expired, another worker is actively processing it
  IF v_row.claimed_at IS NOT NULL AND v_row.claimed_at > (v_now - (p_lock_timeout_seconds || ' seconds')::interval) THEN
    v_remaining_seconds := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_row.claimed_at + (p_lock_timeout_seconds || ' seconds')::interval - v_now)))::integer);
    RETURN jsonb_build_object(
      'status', 'in_progress',
      'retry_after', v_remaining_seconds,
      'attempts', v_row.attempts,
      'lease_generation', v_row.lease_generation
    );
  END IF;

  -- C. If max retry attempts exceeded, prevent unbounded thrashing
  IF v_row.attempts >= p_max_attempts THEN
    RETURN jsonb_build_object(
      'status', 'max_attempts_exceeded',
      'attempts', v_row.attempts,
      'processing_error', v_row.processing_error,
      'lease_generation', v_row.lease_generation
    );
  END IF;

  -- D. Generate unpredictable ownership token and advance monotonic lease generation
  v_new_token := 'claim_' || encode(gen_random_bytes(24), 'hex');
  v_new_gen := COALESCE(v_row.lease_generation, 0) + 1;

  UPDATE public.pooldocai_stripe_webhook_events
  SET claimed_at = v_now,
      claim_token = v_new_token,
      lease_generation = v_new_gen,
      attempts = attempts + 1,
      event_type = p_event_type,
      processing_error = NULL
  WHERE stripe_event_id = p_event_id;

  RETURN jsonb_build_object(
    'status', 'claimed',
    'claim_token', v_new_token,
    'lease_generation', v_new_gen,
    'attempts', v_row.attempts + 1
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_claim_stripe_webhook_event(text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_claim_stripe_webhook_event(text, text, integer, integer) TO service_role;


-- 3. Function: pooldocai_apply_and_finalize_stripe_webhook
-- Atomically applies company billing updates, logs usage, and finalizes event processing,
-- guarded by claim token fence. Fails closed if the worker's lease expired or claim token does not match.
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
  v_now timestamptz := clock_timestamp();
  v_seat_limit integer;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_trial_ends_at timestamptz;
BEGIN
  -- Strict validation of claim token: empty/unknown tokens are rejected
  IF p_claim_token IS NULL OR trim(p_claim_token) = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'invalid_claim_token',
      'error', 'A non-empty claim ownership token is required to finalize webhook events'
    );
  END IF;

  -- Exclusively lock the webhook event row
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

  -- Ownership confirmed: Apply local database mutations within this transaction

  -- A. Company billing update (if provided and not ignored)
  IF NOT p_ignored AND p_company_id IS NOT NULL AND p_company_updates IS NOT NULL AND jsonb_typeof(p_company_updates) = 'object' THEN
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

    UPDATE public.companies
    SET
      stripe_customer_id = COALESCE(p_company_updates->>'stripe_customer_id', stripe_customer_id),
      billing_customer_ref = COALESCE(p_company_updates->>'billing_customer_ref', billing_customer_ref),
      stripe_subscription_id = COALESCE(p_company_updates->>'stripe_subscription_id', stripe_subscription_id),
      billing_subscription_ref = COALESCE(p_company_updates->>'billing_subscription_ref', billing_subscription_ref),
      billing_status = COALESCE(p_company_updates->>'billing_status', billing_status),
      stripe_price_id = COALESCE(p_company_updates->>'stripe_price_id', stripe_price_id),
      plan_name = COALESCE(p_company_updates->>'plan_name', plan_name),
      seat_limit = COALESCE(v_seat_limit, seat_limit),
      billing_period_start = COALESCE(v_period_start, billing_period_start),
      current_period_end = COALESCE(v_period_end, current_period_end),
      trial_ends_at = COALESCE(v_trial_ends_at, trial_ends_at),
      status = COALESCE(p_company_updates->>'status', status),
      updated_at = v_now
    WHERE id = p_company_id;

    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'success', false,
        'status', 'company_not_found',
        'error', 'Target company not found for billing update'
      );
    END IF;
  END IF;

  -- B. Record usage event in platform_usage_events (if provided and not ignored)
  IF NOT p_ignored AND p_company_id IS NOT NULL AND p_usage_event IS NOT NULL AND jsonb_typeof(p_usage_event) = 'object' THEN
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

  -- C. Mark event processed and clear claim
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


-- 4. Function: pooldocai_release_stripe_webhook_event
-- Releases a claimed event on worker failure so it can be retried.
-- Fails closed if the caller does not possess the active claim token.
CREATE OR REPLACE FUNCTION public.pooldocai_release_stripe_webhook_event(
  p_event_id text,
  p_claim_token text,
  p_error text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,extensions,pg_temp AS $$
DECLARE
  v_row public.pooldocai_stripe_webhook_events%ROWTYPE;
BEGIN
  IF p_claim_token IS NULL OR trim(p_claim_token) = '' THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'invalid_claim_token',
      'error', 'A non-empty claim token is required to release an event'
    );
  END IF;

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

  IF v_row.processed THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'already_processed',
      'fenced', true,
      'error', 'Cannot release: event was already finalized'
    );
  END IF;

  IF v_row.claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object(
      'success', false,
      'status', 'fenced_out',
      'fenced', true,
      'error', 'Cannot release: claim token does not match active lease'
    );
  END IF;

  -- Release the claim so it can be retried
  UPDATE public.pooldocai_stripe_webhook_events
  SET claimed_at = NULL,
      claim_token = NULL,
      processing_error = p_error
  WHERE stripe_event_id = p_event_id;

  RETURN jsonb_build_object(
    'success', true,
    'status', 'released',
    'attempts', v_row.attempts,
    'lease_generation', v_row.lease_generation
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_release_stripe_webhook_event(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_release_stripe_webhook_event(text, text, text) TO service_role;

COMMIT;
