-- Migration 026: keep the temporary-trial validity RPC bound to the caller's own identity.
-- The same function remains usable by restrictive RLS policies, which always pass auth.uid().
BEGIN;
CREATE OR REPLACE FUNCTION public.temporary_access_is_valid(p_user_id uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
  SELECT CASE
    WHEN p_user_id IS DISTINCT FROM (SELECT auth.uid()) THEN false
    ELSE
      NOT EXISTS (
        SELECT 1 FROM public.temporary_access_grants g WHERE g.user_id=p_user_id
      )
      OR EXISTS (
        SELECT 1 FROM public.temporary_access_grants g
        WHERE g.user_id=p_user_id AND g.revoked_at IS NULL AND g.expires_at > now()
      )
  END;
$$;
REVOKE ALL ON FUNCTION public.temporary_access_is_valid(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.temporary_access_is_valid(uuid) TO authenticated, service_role;
COMMENT ON FUNCTION public.temporary_access_is_valid(uuid) IS
  'Restrictive RLS expiry gate that only answers for the invoking authenticated user; arbitrary cross-user validity probes return false.';
COMMIT;
