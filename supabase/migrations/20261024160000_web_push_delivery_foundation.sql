-- Migration 044: Web Push Delivery Foundation & Device Subscription Management (TASK-007 Part-3)
-- Enables durable, idempotent Web Push outbox claiming, device subscription lifecycle,
-- tenant isolation, lease fencing, privacy minimization, and 404/410 auto-revocation.

-- 1. Create user_push_subscriptions table
CREATE TABLE IF NOT EXISTS public.user_push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  user_agent text NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  last_used_at timestamptz NULL,
  CONSTRAINT user_push_subscriptions_user_endpoint_key UNIQUE (user_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_user_push_subscriptions_lookup
  ON public.user_push_subscriptions(company_id, user_id, status);

CREATE INDEX IF NOT EXISTS idx_user_push_subscriptions_endpoint
  ON public.user_push_subscriptions(endpoint);

-- 2. Row Level Security for user_push_subscriptions
ALTER TABLE public.user_push_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_push_subscriptions_select_own
  ON public.user_push_subscriptions
  FOR SELECT
  TO authenticated
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.company_members cm
      WHERE cm.company_id = user_push_subscriptions.company_id
        AND cm.user_id = auth.uid()
        AND cm.status = 'active'
    )
  );

CREATE POLICY user_push_subscriptions_insert_own
  ON public.user_push_subscriptions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.company_members cm
      WHERE cm.company_id = user_push_subscriptions.company_id
        AND cm.user_id = auth.uid()
        AND cm.status = 'active'
    )
  );

CREATE POLICY user_push_subscriptions_update_own
  ON public.user_push_subscriptions
  FOR UPDATE
  TO authenticated
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.company_members cm
      WHERE cm.company_id = user_push_subscriptions.company_id
        AND cm.user_id = auth.uid()
        AND cm.status = 'active'
    )
  );

CREATE POLICY user_push_subscriptions_delete_own
  ON public.user_push_subscriptions
  FOR DELETE
  TO authenticated
  USING (
    auth.uid() = user_id
  );

-- 3. Device Registration and Revocation Client RPCs
CREATE OR REPLACE FUNCTION public.pooldocai_register_push_subscription(
  p_company_id uuid,
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_user_agent text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_sub_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  -- Validate endpoint
  IF p_endpoint IS NULL OR NOT (p_endpoint LIKE 'https://%') THEN
    RAISE EXCEPTION 'INVALID_PUSH_ENDPOINT';
  END IF;

  -- Validate keys
  IF p_p256dh IS NULL OR length(trim(p_p256dh)) = 0 OR p_auth IS NULL OR length(trim(p_auth)) = 0 THEN
    RAISE EXCEPTION 'INVALID_PUSH_KEYS';
  END IF;

  -- Check company and active membership
  IF NOT EXISTS (
    SELECT 1 FROM public.company_members cm
    JOIN public.companies c ON c.id = cm.company_id
    WHERE cm.company_id = p_company_id
      AND cm.user_id = v_user_id
      AND cm.status = 'active'
      AND c.status = 'active'
  ) THEN
    RAISE EXCEPTION 'ACTIVE_COMPANY_MEMBERSHIP_REQUIRED';
  END IF;

  -- Upsert subscription
  INSERT INTO public.user_push_subscriptions (
    user_id, company_id, endpoint, p256dh, auth, user_agent, status, updated_at
  )
  VALUES (
    v_user_id, p_company_id, p_endpoint, p_p256dh, p_auth, p_user_agent, 'active', now()
  )
  ON CONFLICT (user_id, endpoint) DO UPDATE
    SET company_id = EXCLUDED.company_id,
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        user_agent = coalesce(EXCLUDED.user_agent, public.user_push_subscriptions.user_agent),
        status = 'active',
        updated_at = now()
  RETURNING id INTO v_sub_id;

  -- Ensure user preference for web_push is enabled
  INSERT INTO public.user_notification_preferences (user_id, company_id, channel, enabled, updated_at)
  VALUES (v_user_id, p_company_id, 'web_push', true, now())
  ON CONFLICT (user_id, company_id, channel) DO UPDATE
    SET enabled = true, updated_at = now();

  RETURN v_sub_id;
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_register_push_subscription(uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pooldocai_register_push_subscription(uuid, text, text, text, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.pooldocai_unregister_push_subscription(
  p_endpoint text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_count integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'AUTH_REQUIRED';
  END IF;

  UPDATE public.user_push_subscriptions
  SET status = 'revoked',
      updated_at = now()
  WHERE user_id = v_user_id
    AND endpoint = p_endpoint
    AND status = 'active';

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_unregister_push_subscription(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pooldocai_unregister_push_subscription(text) TO authenticated, service_role;

-- 4. Update pooldocai_publish_company_notification to enqueue web_push as pending when active subscriptions exist
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

    -- Enqueue web_push adapter (pending if recipient has active subscription and pref enabled, or opted_out, or deferred)
    v_idempotency_key := 'push-' || v_notification_id::text || '-' || v_rec.user_id::text;
    IF v_pref_push IS NOT FALSE THEN
      IF EXISTS (
        SELECT 1 FROM public.user_push_subscriptions ups
        WHERE ups.user_id = v_rec.user_id
          AND ups.company_id = p_company_id
          AND ups.status = 'active'
      ) THEN
        INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status, idempotency_key)
        VALUES (v_notification_id, p_company_id, v_rec.user_id, 'web_push', 'pending', v_idempotency_key)
        ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
      ELSE
        INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status, idempotency_key)
        VALUES (v_notification_id, p_company_id, v_rec.user_id, 'web_push', 'deferred', v_idempotency_key)
        ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
      END IF;
    ELSE
      INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status, idempotency_key)
      VALUES (v_notification_id, p_company_id, v_rec.user_id, 'web_push', 'opted_out', v_idempotency_key)
      ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
    END IF;
  END LOOP;

  RETURN v_notification_id;
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_publish_company_notification(uuid, text, text, text, jsonb, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_publish_company_notification(uuid, text, text, text, jsonb, text, text, uuid) TO service_role;

-- 5. Outbox Batch Claim RPC for Web Push
CREATE INDEX IF NOT EXISTS notification_delivery_queue_push_pending_idx
  ON public.notification_delivery_queue(channel, delivery_status, next_attempt_at)
  WHERE channel = 'web_push' AND delivery_status IN ('pending', 'retrying');

CREATE OR REPLACE FUNCTION public.pooldocai_claim_push_delivery_batch(
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
  recipient_role text,
  event_type text,
  title text,
  body text,
  event_data jsonb,
  subscriptions jsonb,
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
  v_member_role text;
  v_subs jsonb;
BEGIN
  -- 1. Recover stale/abandoned worker leases
  UPDATE public.notification_delivery_queue q_stale
  SET delivery_status = 'dead_letter',
      last_error = 'worker_lease_expired_max_attempts',
      updated_at = now()
  WHERE q_stale.channel = 'web_push'
    AND q_stale.delivery_status = 'sending'
    AND q_stale.leased_at < now() - v_lease_interval
    AND q_stale.attempts >= 5;

  UPDATE public.notification_delivery_queue q_retry
  SET delivery_status = 'retrying',
      next_attempt_at = now(),
      updated_at = now()
  WHERE q_retry.channel = 'web_push'
    AND q_retry.delivery_status = 'sending'
    AND q_retry.leased_at < now() - v_lease_interval
    AND q_retry.attempts < 5;

  -- 2. Select and lock candidate queue rows using SKIP LOCKED
  FOR v_rec IN
    SELECT
      q.id AS q_id,
      q.notification_id AS q_notif_id,
      q.company_id AS q_co_id,
      q.user_id AS q_user_id,
      q.attempts AS q_attempts,
      coalesce(q.idempotency_key, 'push-' || q.notification_id::text || '-' || q.user_id::text) AS q_idem_key,
      cn.event_type AS q_event_type,
      cn.title AS q_title,
      cn.body AS q_body,
      cn.data AS q_data,
      c.name AS q_co_name,
      c.status AS q_co_status
    FROM public.notification_delivery_queue q
    JOIN public.company_notifications cn ON cn.id = q.notification_id AND cn.company_id = q.company_id
    JOIN public.companies c ON c.id = q.company_id
    WHERE q.channel = 'web_push'
      AND q.delivery_status IN ('pending', 'retrying')
      AND q.next_attempt_at <= now()
    ORDER BY q.next_attempt_at ASC, q.created_at ASC
    LIMIT p_batch_size
    FOR UPDATE OF q SKIP LOCKED
  LOOP
    -- Check company status
    IF v_rec.q_co_status <> 'active' THEN
      UPDATE public.notification_delivery_queue q_fail
      SET delivery_status = 'failed',
          last_error = 'company_inactive_or_suspended',
          updated_at = now()
      WHERE q_fail.id = v_rec.q_id;
      CONTINUE;
    END IF;

    -- Check active membership
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

    -- Check opt-out
    SELECT (enabled = false) INTO v_opted_out
    FROM public.user_notification_preferences
    WHERE user_id = v_rec.q_user_id AND company_id = v_rec.q_co_id AND channel = 'web_push';

    IF v_opted_out IS TRUE THEN
      UPDATE public.notification_delivery_queue q_opt
      SET delivery_status = 'opted_out',
          updated_at = now()
      WHERE q_opt.id = v_rec.q_id;
      CONTINUE;
    END IF;

    -- Query active device subscriptions for this user and company
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', ups.id,
      'endpoint', ups.endpoint,
      'p256dh', ups.p256dh,
      'auth', ups.auth
    )), '[]'::jsonb) INTO v_subs
    FROM public.user_push_subscriptions ups
    WHERE ups.user_id = v_rec.q_user_id
      AND ups.company_id = v_rec.q_co_id
      AND ups.status = 'active';

    IF v_subs IS NULL OR jsonb_array_length(v_subs) = 0 THEN
      UPDATE public.notification_delivery_queue q_no_sub
      SET delivery_status = 'failed',
          last_error = 'no_active_push_subscriptions',
          updated_at = now()
      WHERE q_no_sub.id = v_rec.q_id;
      CONTINUE;
    END IF;

    -- Atomically transition row to 'sending' with distinct unguessable per-claim lease token
    v_claim_lease_token := 'claim_' || gen_random_uuid()::text;

    UPDATE public.notification_delivery_queue q_send
    SET delivery_status = 'sending',
        lease_token = v_claim_lease_token,
        leased_at = now(),
        attempts = q_send.attempts + 1,
        idempotency_key = v_rec.q_idem_key,
        updated_at = now()
    WHERE q_send.id = v_rec.q_id;

    queue_id := v_rec.q_id;
    notification_id := v_rec.q_notif_id;
    company_id := v_rec.q_co_id;
    company_name := v_rec.q_co_name;
    user_id := v_rec.q_user_id;
    recipient_role := coalesce(v_member_role, 'technician');
    event_type := v_rec.q_event_type;
    title := v_rec.q_title;
    body := v_rec.q_body;
    event_data := v_rec.q_data;
    subscriptions := v_subs;
    attempts := v_rec.q_attempts + 1;
    idempotency_key := v_rec.q_idem_key;
    lease_token := v_claim_lease_token;

    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_claim_push_delivery_batch(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_claim_push_delivery_batch(text, integer, integer) TO service_role;

-- 6. Atomic Push Delivery Finalization RPC
CREATE OR REPLACE FUNCTION public.pooldocai_finish_push_delivery(
  p_queue_id uuid,
  p_lease_token text,
  p_success boolean,
  p_provider_message_id text DEFAULT NULL,
  p_error text DEFAULT NULL,
  p_retryable boolean DEFAULT false,
  p_revoked_endpoints text[] DEFAULT '{}'::text[]
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.notification_delivery_queue;
  v_backoff_secs integer;
  v_ep text;
BEGIN
  -- Lease fencing: verify row is currently in 'sending' state with matching lease_token
  SELECT * INTO v_row
  FROM public.notification_delivery_queue
  WHERE id = p_queue_id
    AND lease_token = p_lease_token
    AND delivery_status = 'sending'
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Stale worker fenced out
    RETURN false;
  END IF;

  -- Auto-revoke dead endpoints (404/410 returned by push service)
  IF p_revoked_endpoints IS NOT NULL AND array_length(p_revoked_endpoints, 1) > 0 THEN
    FOREACH v_ep IN ARRAY p_revoked_endpoints LOOP
      UPDATE public.user_push_subscriptions
      SET status = 'revoked',
          updated_at = now()
      WHERE endpoint = v_ep;
    END LOOP;
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

  -- Failure handling
  IF p_retryable AND v_row.attempts < 5 THEN
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

REVOKE ALL ON FUNCTION public.pooldocai_finish_push_delivery(uuid, text, boolean, text, text, boolean, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_finish_push_delivery(uuid, text, boolean, text, text, boolean, text[]) TO service_role;
