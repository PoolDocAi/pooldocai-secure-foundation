-- Migration 033: Stripe webhook atomic event claiming, bounded retry/recovery, and concurrency locking.
-- Forward-only and additive.
BEGIN;

-- Add claimed_at and attempts to pooldocai_stripe_webhook_events if they do not exist
ALTER TABLE public.pooldocai_stripe_webhook_events
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

-- Function: pooldocai_claim_stripe_webhook_event
-- Atomically claims a Stripe webhook event with an exclusive row lock and lease expiration.
-- Prevents concurrent workers from simultaneously applying the same event.
CREATE OR REPLACE FUNCTION public.pooldocai_claim_stripe_webhook_event(
  p_event_id text,
  p_event_type text,
  p_lock_timeout_seconds integer DEFAULT 60,
  p_max_attempts integer DEFAULT 5
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_row public.pooldocai_stripe_webhook_events%ROWTYPE;
  v_now timestamptz := clock_timestamp();
  v_remaining_seconds integer;
BEGIN
  -- Insert placeholder row if this is the first delivery of this event ID
  INSERT INTO public.pooldocai_stripe_webhook_events (
    stripe_event_id, event_type, processed, attempts
  ) VALUES (
    p_event_id, p_event_type, false, 0
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

  -- 1. If already fully processed, acknowledge idempotently as duplicate
  IF v_row.processed THEN
    RETURN jsonb_build_object('status', 'already_processed', 'processed', true, 'duplicate', true);
  END IF;

  -- 2. If currently claimed and the lease has NOT expired, another worker is actively processing it
  IF v_row.claimed_at IS NOT NULL AND v_row.claimed_at > (v_now - (p_lock_timeout_seconds || ' seconds')::interval) THEN
    v_remaining_seconds := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_row.claimed_at + (p_lock_timeout_seconds || ' seconds')::interval - v_now)))::integer);
    RETURN jsonb_build_object(
      'status', 'in_progress',
      'retry_after', v_remaining_seconds,
      'attempts', v_row.attempts
    );
  END IF;

  -- 3. If max retry attempts exceeded, prevent unbounded thrashing
  IF v_row.attempts >= p_max_attempts THEN
    RETURN jsonb_build_object(
      'status', 'max_attempts_exceeded',
      'attempts', v_row.attempts,
      'processing_error', v_row.processing_error
    );
  END IF;

  -- 4. Exclusively claim the event!
  UPDATE public.pooldocai_stripe_webhook_events
  SET claimed_at = v_now,
      attempts = attempts + 1,
      event_type = p_event_type,
      processing_error = NULL
  WHERE stripe_event_id = p_event_id;

  RETURN jsonb_build_object(
    'status', 'claimed',
    'attempts', v_row.attempts + 1
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_claim_stripe_webhook_event(text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_claim_stripe_webhook_event(text, text, integer, integer) TO service_role;

COMMIT;
