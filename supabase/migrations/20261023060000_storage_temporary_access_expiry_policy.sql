-- Migration 030: Extend restrictive temporary-account expiry policy to storage.objects.
-- Ensures expired or revoked temporary trial credentials cannot read or upload files in Supabase Storage.
BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname = 'storage' AND tablename = 'objects') THEN
    DROP POLICY IF EXISTS temporary_access_storage_expiry_guard ON storage.objects;
    CREATE POLICY temporary_access_storage_expiry_guard ON storage.objects
      AS RESTRICTIVE FOR ALL TO authenticated
      USING (public.temporary_access_is_valid(auth.uid()))
      WITH CHECK (public.temporary_access_is_valid(auth.uid()));
  END IF;
END $$;

COMMIT;
