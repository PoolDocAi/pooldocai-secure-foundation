-- ============================================================================
-- Migration 046: Supabase Security Advisor Hardening - Explicit Privilege Revocation
-- Resolves anonymous-executable SECURITY DEFINER findings by explicitly revoking
-- PUBLIC and anon execution grants on sensitive RPCs and trigger functions.
-- ============================================================================

-- 1. Explicitly revoke anonymous access to notification read RPCs
REVOKE ALL ON FUNCTION public.pooldocai_get_user_notifications(uuid, integer, integer, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pooldocai_get_user_notifications(uuid, integer, integer, boolean) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.pooldocai_mark_notification_read(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pooldocai_mark_notification_read(uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.pooldocai_mark_all_notifications_read(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pooldocai_mark_all_notifications_read(uuid) TO authenticated, service_role;

-- 2. Explicitly revoke public/anon/authenticated execution on trigger function
REVOKE ALL ON FUNCTION public.pooldocai_touch_updated_at() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_touch_updated_at() TO service_role;
