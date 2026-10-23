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
-- Extend restrictive temporary-account expiry policy to storage.objects so expired/revoked temporary credentials cannot read or upload files.
DO $
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'storage' AND tablename = 'objects') THEN
    DROP POLICY IF EXISTS temporary_access_storage_expiry_guard ON storage.objects;
    CREATE POLICY temporary_access_storage_expiry_guard ON storage.objects
      AS RESTRICTIVE FOR ALL TO authenticated
      USING (public.temporary_access_is_valid(auth.uid()))
      WITH CHECK (public.temporary_access_is_valid(auth.uid()));
  END IF;
END $;

COMMIT;
