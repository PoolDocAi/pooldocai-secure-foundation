-- Migration 042: Company Notifications and Delivery Foundation
-- Implements durable, company-scoped notification events, per-recipient read states,
-- channel delivery queue (in_app, email, web_push), and strict tenant-isolated RLS.

-- 1. Company-level notification events
CREATE TABLE IF NOT EXISTS public.company_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_notifications_dedupe_uniq UNIQUE(company_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS company_notifications_company_created_idx
  ON public.company_notifications(company_id, created_at DESC);

ALTER TABLE public.company_notifications ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.company_notifications FROM public, anon;
GRANT SELECT ON public.company_notifications TO authenticated, service_role;
GRANT ALL ON public.company_notifications TO service_role;

DROP POLICY IF EXISTS company_notifications_select_policy ON public.company_notifications;
CREATE POLICY company_notifications_select_policy ON public.company_notifications
  FOR SELECT TO authenticated
  USING (
    public.is_platform_admin() OR EXISTS (
      SELECT 1 FROM public.company_members m
      JOIN public.companies c ON c.id = m.company_id
      WHERE m.company_id = company_notifications.company_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
        AND c.status = 'active'
    )
  );

-- 2. Per-recipient delivery & read state
CREATE TABLE IF NOT EXISTS public.user_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES public.company_notifications(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_role text NOT NULL DEFAULT 'all',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_notifications_uniq_user_notif UNIQUE(notification_id, user_id)
);

CREATE INDEX IF NOT EXISTS user_notifications_user_company_unread_idx
  ON public.user_notifications(user_id, company_id, read_at, created_at DESC);

ALTER TABLE public.user_notifications ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.user_notifications FROM public, anon;
GRANT SELECT, UPDATE ON public.user_notifications TO authenticated;
GRANT ALL ON public.user_notifications TO service_role;

DROP POLICY IF EXISTS user_notifications_select_policy ON public.user_notifications;
CREATE POLICY user_notifications_select_policy ON public.user_notifications
  FOR SELECT TO authenticated
  USING (
    public.is_platform_admin() OR (
      user_id = auth.uid() AND EXISTS (
        SELECT 1 FROM public.company_members m
        JOIN public.companies c ON c.id = m.company_id
        WHERE m.company_id = user_notifications.company_id
          AND m.user_id = auth.uid()
          AND m.status = 'active'
          AND c.status = 'active'
      )
    )
  );

DROP POLICY IF EXISTS user_notifications_update_policy ON public.user_notifications;
CREATE POLICY user_notifications_update_policy ON public.user_notifications
  FOR UPDATE TO authenticated
  USING (
    user_id = auth.uid() AND EXISTS (
      SELECT 1 FROM public.company_members m
      JOIN public.companies c ON c.id = m.company_id
      WHERE m.company_id = user_notifications.company_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
        AND c.status = 'active'
    )
  )
  WITH CHECK (
    user_id = auth.uid() AND EXISTS (
      SELECT 1 FROM public.company_members m
      JOIN public.companies c ON c.id = m.company_id
      WHERE m.company_id = user_notifications.company_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
        AND c.status = 'active'
    )
  );

-- 3. Notification delivery queue (for in_app, email, and web_push adapters)
CREATE TABLE IF NOT EXISTS public.notification_delivery_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id uuid NOT NULL REFERENCES public.company_notifications(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('in_app', 'email', 'web_push')),
  delivery_status text NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'delivered', 'failed', 'opted_out', 'deferred')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  delivered_at timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_delivery_queue_uniq UNIQUE(notification_id, user_id, channel)
);

CREATE INDEX IF NOT EXISTS notification_delivery_queue_status_idx
  ON public.notification_delivery_queue(delivery_status, next_attempt_at)
  WHERE delivery_status = 'pending';

ALTER TABLE public.notification_delivery_queue ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.notification_delivery_queue FROM public, anon;
GRANT SELECT ON public.notification_delivery_queue TO authenticated;
GRANT ALL ON public.notification_delivery_queue TO service_role;

DROP POLICY IF EXISTS notification_delivery_queue_select_policy ON public.notification_delivery_queue;
CREATE POLICY notification_delivery_queue_select_policy ON public.notification_delivery_queue
  FOR SELECT TO authenticated
  USING (
    public.is_platform_admin() OR public.is_company_admin(company_id)
  );

-- 4. User notification preferences per channel
CREATE TABLE IF NOT EXISTS public.user_notification_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('in_app', 'email', 'web_push')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_notification_preferences_uniq UNIQUE(user_id, company_id, channel)
);

ALTER TABLE public.user_notification_preferences ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.user_notification_preferences FROM public, anon;
GRANT SELECT, INSERT, UPDATE ON public.user_notification_preferences TO authenticated;
GRANT ALL ON public.user_notification_preferences TO service_role;

DROP POLICY IF EXISTS user_notification_preferences_select ON public.user_notification_preferences;
CREATE POLICY user_notification_preferences_select ON public.user_notification_preferences
  FOR SELECT TO authenticated
  USING (
    public.is_platform_admin() OR (
      user_id = auth.uid() AND EXISTS (
        SELECT 1 FROM public.company_members m
        JOIN public.companies c ON c.id = m.company_id
        WHERE m.company_id = user_notification_preferences.company_id
          AND m.user_id = auth.uid()
          AND m.status = 'active'
          AND c.status = 'active'
      )
    )
  );

DROP POLICY IF EXISTS user_notification_preferences_manage ON public.user_notification_preferences;
CREATE POLICY user_notification_preferences_manage ON public.user_notification_preferences
  FOR ALL TO authenticated
  USING (
    user_id = auth.uid() AND EXISTS (
      SELECT 1 FROM public.company_members m
      JOIN public.companies c ON c.id = m.company_id
      WHERE m.company_id = user_notification_preferences.company_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
        AND c.status = 'active'
    )
  )
  WITH CHECK (
    user_id = auth.uid() AND EXISTS (
      SELECT 1 FROM public.company_members m
      JOIN public.companies c ON c.id = m.company_id
      WHERE m.company_id = user_notification_preferences.company_id
        AND m.user_id = auth.uid()
        AND m.status = 'active'
        AND c.status = 'active'
    )
  );

-- 5. Database RPC Functions

-- 5a. Publish notification (service role only)
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

    -- Enqueue in_app delivery (delivered immediately)
    INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status, delivered_at)
    VALUES (v_notification_id, p_company_id, v_rec.user_id, 'in_app', 'delivered', now())
    ON CONFLICT (notification_id, user_id, channel) DO NOTHING;

    -- Enqueue email adapter (deferred pending Part-2 configuration)
    INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status)
    VALUES (v_notification_id, p_company_id, v_rec.user_id, 'email', 'deferred')
    ON CONFLICT (notification_id, user_id, channel) DO NOTHING;

    -- Enqueue web_push adapter (deferred pending Part-3 configuration)
    INSERT INTO public.notification_delivery_queue (notification_id, company_id, user_id, channel, delivery_status)
    VALUES (v_notification_id, p_company_id, v_rec.user_id, 'web_push', 'deferred')
    ON CONFLICT (notification_id, user_id, channel) DO NOTHING;
  END LOOP;

  RETURN v_notification_id;
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_publish_company_notification(uuid, text, text, text, jsonb, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_publish_company_notification(uuid, text, text, text, jsonb, text, text, uuid) TO service_role;

-- 5b. Get user notifications
CREATE OR REPLACE FUNCTION public.pooldocai_get_user_notifications(
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0,
  p_unread_only boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_unread_count integer := 0;
  v_total_count integer := 0;
  v_items jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'AUTHENTICATION_REQUIRED';
  END IF;

  -- Resolve caller's active company
  SELECT m.company_id INTO v_company_id
  FROM public.company_members m
  JOIN public.companies c ON c.id = m.company_id
  WHERE m.user_id = v_user_id
    AND m.status = 'active'
    AND c.status = 'active'
  ORDER BY m.created_at ASC
  LIMIT 1;

  IF v_company_id IS NULL THEN
    RETURN jsonb_build_object(
      'notifications', '[]'::jsonb,
      'unread_count', 0,
      'total_count', 0
    );
  END IF;

  -- Count unread
  SELECT count(*) INTO v_unread_count
  FROM public.user_notifications un
  WHERE un.user_id = v_user_id
    AND un.company_id = v_company_id
    AND un.read_at IS NULL;

  -- Count total
  SELECT count(*) INTO v_total_count
  FROM public.user_notifications un
  WHERE un.user_id = v_user_id
    AND un.company_id = v_company_id;

  -- Query rows
  SELECT coalesce(jsonb_agg(item), '[]'::jsonb) INTO v_items
  FROM (
    SELECT
      un.id AS user_notification_id,
      un.notification_id,
      un.company_id,
      un.recipient_role,
      un.read_at,
      un.created_at,
      cn.event_type,
      cn.title,
      cn.body,
      cn.data
    FROM public.user_notifications un
    JOIN public.company_notifications cn ON cn.id = un.notification_id
    WHERE un.user_id = v_user_id
      AND un.company_id = v_company_id
      AND (NOT p_unread_only OR un.read_at IS NULL)
    ORDER BY un.created_at DESC
    LIMIT least(greatest(coalesce(p_limit, 20), 1), 100)
    OFFSET greatest(coalesce(p_offset, 0), 0)
  ) item;

  RETURN jsonb_build_object(
    'notifications', v_items,
    'unread_count', v_unread_count,
    'total_count', v_total_count,
    'company_id', v_company_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.pooldocai_get_user_notifications(integer, integer, boolean) TO authenticated, service_role;

-- 5c. Mark notification read
CREATE OR REPLACE FUNCTION public.pooldocai_mark_notification_read(
  p_user_notification_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_updated integer := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'AUTHENTICATION_REQUIRED';
  END IF;

  UPDATE public.user_notifications
  SET read_at = now()
  WHERE id = p_user_notification_id
    AND user_id = v_user_id
    AND read_at IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

GRANT EXECUTE ON FUNCTION public.pooldocai_mark_notification_read(uuid) TO authenticated, service_role;

-- 5d. Mark all notifications read
CREATE OR REPLACE FUNCTION public.pooldocai_mark_all_notifications_read()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_company_id uuid;
  v_updated integer := 0;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'AUTHENTICATION_REQUIRED';
  END IF;

  SELECT m.company_id INTO v_company_id
  FROM public.company_members m
  JOIN public.companies c ON c.id = m.company_id
  WHERE m.user_id = v_user_id
    AND m.status = 'active'
    AND c.status = 'active'
  LIMIT 1;

  IF v_company_id IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.user_notifications
  SET read_at = now()
  WHERE user_id = v_user_id
    AND company_id = v_company_id
    AND read_at IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

GRANT EXECUTE ON FUNCTION public.pooldocai_mark_all_notifications_read() TO authenticated, service_role;
