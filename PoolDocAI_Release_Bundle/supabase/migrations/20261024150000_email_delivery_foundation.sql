-- Migration 043: Email Delivery Outbox, Lease Fencing & Provider Foundation (TASK-007 Part-2)
-- Enables durable, idempotent email outbox claiming, concurrency fencing, exponential retries,
-- dead-letter capping, and privacy-first notification delivery.

-- 1. Extend notification_delivery_queue schema for lease fencing and retry states
ALTER TABLE public.notification_delivery_queue
  DROP CONSTRAINT IF EXISTS notification_delivery_queue_delivery_status_check;

ALTER TABLE public.notification_delivery_queue
  ADD CONSTRAINT notification_delivery_queue_delivery_status_check
  CHECK (delivery_status IN ('pending', 'sending', 'retrying', 'delivered', 'failed', 'dead_letter', 'opted_out', 'deferred'));

ALTER TABLE public.notification_delivery_queue
  ADD COLUMN IF NOT EXISTS lease_token text,
  ADD COLUMN IF NOT EXISTS leased_at timestamptz,
  ADD COLUMN IF NOT EXISTS provider_message_id text,
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE INDEX IF NOT EXISTS notification_delivery_queue_email_pending_idx
  ON public.notification_delivery_queue(channel, delivery_status, next_attempt_at)
  WHERE channel = 'email' AND delivery_status IN ('pending', 'retrying');

-- 2. Update pooldocai_publish_company_notification to enqueue email as 'pending' for immediate delivery
CREATE OR REPLACE FUNCTION public.pooldocai_publish_company_notification(
  p_company_id uuid,
  p_event_type text,
  p_title text,
  p_body text,
  p_data jsonb DEFAULT '{}'::jsonb,
  p_dedupe_key text DEFAULT NULL,
  p_target_role text DEFAULT 'all',
  p_target_user_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_notification_id uuid;
  v_rec record;
  v_pref_in_app boolean;
  v_pref_email boolean;
  v_pref_push boolean;
  v_idempotency_key text;
BEGIN
  -- Verify active company
  IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = p_company_id AND status = 'active') THEN
    RAISE EXCEPTION 'COMPANY_NOT_ACTIVE_OR_FOUND';
  END IF;

  -- Insert event (idempotent if dedupe_key matches)
  INSERT INTO public.company_notifications (company_id, event_type, title, body, data, dedupe_key)
  VALUES (p_company_id, p_event_type, p_title, p_body, coalesce(p_data, '{}'::jsonb), p_dedupe_key)
  ON CONFLICT (company_id, dedupe_key) DO UPDATE
    SET title = EXCLUDED.title, body = EXCLUDED.body, data = EXCLUDED.data
  RETURNING id INTO v_notification_id;

  -- Determine recipients
  FOR v_rec IN
    SELECT m.user_id, m.role
    FROM public.company_members m
    WHERE m.company_id = p_company_id
      AND m.status = 'active'
      AND (
        (p_target_user_id IS NOT NULL AND m.user_id = p_target_user_id)
        OR (
          p_target_user_id IS NULL AND (
            p_target_role = 'all'
            OR (p_target_role = 'admin' AND m.role = 'company_admin')
            OR (p_target_role = 'technician' AND m.role IN ('technician', 'company_admin'))
          )
        )
      )
  LOOP
    -- Insert user notification
    INSERT INTO public.user_notifications (notification_id, company_id, user_id, recipient_role)
    VALUES (v_notification_id, p_company_id, v_rec.user_id, v_rec.role)
    ON CONFLICT (notification_id, user_id) DO NOTHING;

    -- Consult recipient preferences per channel
    SELECT enabled INTO v_pref_in_app FROM public.user_notification_preferences
    WHERE user_id = v_rec.user_id AND company_id = p_company_id AND channel = 'in_app';

    SELECT enabled INTO v_pref_email FROM public.user_notification_preferences
    WHERE user_id = v_rec.user_id AND company_id = p_company_id AND channel = 'email';

    SELECT enabled INTO v_pref_push FROM public.user_notification_preferences
    WHERE user_id = v_rec.user_id AND company_id = p_company_id AND channel = 'web_push';

    -- Enqueue in_app delivery (delivered immediately if not opted out)
    IF v_pref_in_app IS NOT FALSE THEN
      INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status, delivered_at)
      VALUES (v_notification_id, p_company_id, v_rec.user_id, 'in_app', 'delivered', now())
      ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
    ELSE
      INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status)
      VALUES (v_notification_id, p_company_id, v_rec.user_id, 'in_app', 'opted_out')
      ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
    END IF;

    -- Enqueue email adapter (pending for email delivery worker, or opted_out)
    v_idempotency_key := 'email-' || v_notification_id::text || '-' || v_rec.user_id::text;
    IF v_pref_email IS NOT FALSE THEN
      INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status, idempotency_key)
      VALUES (v_notification_id, p_company_id, v_rec.user_id, 'email', 'pending', v_idempotency_key)
      ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
    ELSE
      INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status, idempotency_key)
      VALUES (v_notification_id, p_company_id, v_rec.user_id, 'email', 'opted_out', v_idempotency_key)
      ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
    END IF;

    -- Enqueue web_push adapter (deferred pending Part-3 configuration, or opted_out)
    IF v_pref_push IS NOT FALSE THEN
      INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status)
      VALUES (v_notification_id, p_company_id, v_rec.user_id, 'web_push', 'deferred')
      ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
    ELSE
      INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status)
      VALUES (v_notification_id, p_company_id, v_rec.user_id, 'web_push', 'opted_out')
      ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
    END IF;
  END LOOP;

  RETURN v_notification_id;
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_publish_company_notification(uuid, text, text, text, jsonb, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_publish_company_notification(uuid, text, text, text, jsonb, text, text, uuid) TO service_role;

-- 3. Atomic Outbox Batch Claiming with Concurrency Fencing (FOR UPDATE SKIP LOCKED)
CREATE OR REPLACE FUNCTION public.pooldocai_claim_email_delivery_batch(
  p_worker_id text,
  p_batch_size integer DEFAULT 10,
  p_lease_seconds integer DEFAULT 120
)
RETURNS TABLE (
  queue_id uuid,
  notification_id uuid,
  company_id uuid,
  company_name text,
  user_id uuid,
  recipient_email text,
  recipient_role text,
  event_type text,
  title text,
  body text,
  event_data jsonb,
  attempts integer,
  idempotency_key text,
  lease_token text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_rec record;
  v_lease_interval interval := (least(greatest(p_lease_seconds, 15), 600) * interval '1 second');
  v_claim_lease_token text;
  v_opted_out boolean;
  v_company_active boolean;
  v_member_active boolean;
  v_user_email text;
  v_member_role text;
BEGIN
  -- Recover stale/abandoned worker leases
  UPDATE public.notification_delivery_queue q_stale
  SET delivery_status = 'dead_letter',
      last_error = 'worker_lease_expired_max_attempts',
      updated_at = now()
  WHERE q_stale.channel = 'email'
    AND q_stale.delivery_status = 'sending'
    AND q_stale.leased_at < now() - v_lease_interval
    AND q_stale.attempts >= 5;

  UPDATE public.notification_delivery_queue q_retry
  SET delivery_status = 'retrying',
      next_attempt_at = now(),
      updated_at = now()
  WHERE q_retry.channel = 'email'
    AND q_retry.delivery_status = 'sending'
    AND q_retry.leased_at < now() - v_lease_interval
    AND q_retry.attempts < 5;

  -- Select and lock candidate queue rows using SKIP LOCKED
  FOR v_rec IN
    SELECT
      q.id AS q_id,
      q.notification_id AS q_notif_id,
      q.company_id AS q_co_id,
      q.user_id AS q_user_id,
      q.attempts AS q_attempts,
      coalesce(q.idempotency_key, 'email-' || q.notification_id::text || '-' || q.user_id::text) AS q_idem_key,
      cn.event_type AS q_event_type,
      cn.title AS q_title,
      cn.body AS q_body,
      cn.data AS q_data,
      c.name AS q_co_name,
      c.status AS q_co_status
    FROM public.notification_delivery_queue q
    JOIN public.company_notifications cn ON cn.id = q.notification_id AND cn.company_id = q.company_id
    JOIN public.companies c ON c.id = q.company_id
    WHERE q.channel = 'email'
      AND q.delivery_status IN ('pending', 'retrying')
      AND q.next_attempt_at <= now()
    ORDER BY q.next_attempt_at ASC, q.created_at ASC
    LIMIT p_batch_size
    FOR UPDATE OF q SKIP LOCKED
  LOOP
    -- 1. Check company status
    IF v_rec.q_co_status <> 'active' THEN
      UPDATE public.notification_delivery_queue q_fail
      SET delivery_status = 'failed',
          last_error = 'company_inactive_or_suspended',
          updated_at = now()
      WHERE q_fail.id = v_rec.q_id;
      CONTINUE;
    END IF;

    -- 2. Check active membership in the specified company
    SELECT m.role, (m.status = 'active') INTO v_member_role, v_member_active
    FROM public.company_members m
    WHERE m.company_id = v_rec.q_co_id AND m.user_id = v_rec.q_user_id;

    IF v_member_active IS NOT TRUE THEN
      UPDATE public.notification_delivery_queue q_mem
      SET delivery_status = 'failed',
          last_error = 'recipient_not_active_member',
          updated_at = now()
      WHERE q_mem.id = v_rec.q_id;
      CONTINUE;
    END IF;

    -- 3. Check delivery-time email opt-out preferences
    SELECT (enabled = false) INTO v_opted_out
    FROM public.user_notification_preferences
    WHERE user_id = v_rec.q_user_id AND company_id = v_rec.q_co_id AND channel = 'email';

    IF v_opted_out IS TRUE THEN
      UPDATE public.notification_delivery_queue q_opt
      SET delivery_status = 'opted_out',
          updated_at = now()
      WHERE q_opt.id = v_rec.q_id;
      CONTINUE;
    END IF;

    -- 4. Lookup auth user email
    SELECT u.email INTO v_user_email
    FROM auth.users u
    WHERE u.id = v_rec.q_user_id;

    IF v_user_email IS NULL OR v_user_email = '' THEN
      UPDATE public.notification_delivery_queue q_no_email
      SET delivery_status = 'failed',
          last_error = 'recipient_email_missing',
          updated_at = now()
      WHERE q_no_email.id = v_rec.q_id;
      CONTINUE;
    END IF;

    -- 5. Atomically transition row to 'sending' with distinct unguessable per-claim lease token (ABA safe)
    v_claim_lease_token := 'claim_' || gen_random_uuid()::text;

    UPDATE public.notification_delivery_queue q_send
    SET delivery_status = 'sending',
        lease_token = v_claim_lease_token,
        leased_at = now(),
        attempts = q_send.attempts + 1,
        idempotency_key = v_rec.q_idem_key,
        updated_at = now()
    WHERE q_send.id = v_rec.q_id;

    -- Emit row to result set
    queue_id := v_rec.q_id;
    notification_id := v_rec.q_notif_id;
    company_id := v_rec.q_co_id;
    company_name := v_rec.q_co_name;
    user_id := v_rec.q_user_id;
    recipient_email := v_user_email;
    recipient_role := coalesce(v_member_role, 'technician');
    event_type := v_rec.q_event_type;
    title := v_rec.q_title;
    body := v_rec.q_body;
    event_data := v_rec.q_data;
    attempts := v_rec.q_attempts + 1;
    idempotency_key := v_rec.q_idem_key;
    lease_token := v_claim_lease_token;

    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_claim_email_delivery_batch(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_claim_email_delivery_batch(text, integer, integer) TO service_role;

-- 4. Atomic Delivery Finalization RPC with Strict Lease Fencing
CREATE OR REPLACE FUNCTION public.pooldocai_finish_email_delivery(
  p_queue_id uuid,
  p_lease_token text,
  p_success boolean,
  p_provider_message_id text DEFAULT NULL,
  p_error text DEFAULT NULL,
  p_retryable boolean DEFAULT false
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.notification_delivery_queue;
  v_backoff_secs integer;
BEGIN
  -- Strict lease fencing: verify row is currently in 'sending' state with matching lease_token
  SELECT * INTO v_row
  FROM public.notification_delivery_queue
  WHERE id = p_queue_id
    AND lease_token = p_lease_token
    AND delivery_status = 'sending'
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Stale worker fenced out: row was reclaimed by another worker or aborted
    RETURN false;
  END IF;

  IF p_success THEN
    UPDATE public.notification_delivery_queue
    SET delivery_status = 'delivered',
        delivered_at = now(),
        provider_message_id = p_provider_message_id,
        last_error = NULL,
        lease_token = NULL,
        leased_at = NULL,
        updated_at = now()
    WHERE id = p_queue_id;
    RETURN true;
  END IF;

  -- Handle failure
  IF p_retryable AND v_row.attempts < 5 THEN
    -- Exponential backoff: 30s, 60s, 120s, 240s capped at 1 hour
    v_backoff_secs := least(3600, 30 * power(2, greatest(v_row.attempts - 1, 0))::integer);
    UPDATE public.notification_delivery_queue
    SET delivery_status = 'retrying',
        next_attempt_at = now() + (v_backoff_secs * interval '1 second'),
        last_error = left(coalesce(p_error, 'retryable_delivery_error'), 255),
        lease_token = NULL,
        leased_at = NULL,
        updated_at = now()
    WHERE id = p_queue_id;
    RETURN true;
  ELSE
    -- Non-retryable or max attempts exhausted -> dead_letter
    UPDATE public.notification_delivery_queue
    SET delivery_status = 'dead_letter',
        last_error = left(coalesce(p_error, 'terminal_delivery_failure'), 255),
        lease_token = NULL,
        leased_at = NULL,
        updated_at = now()
    WHERE id = p_queue_id;
    RETURN true;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_finish_email_delivery(uuid, text, boolean, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_finish_email_delivery(uuid, text, boolean, text, text, boolean) TO service_role;
