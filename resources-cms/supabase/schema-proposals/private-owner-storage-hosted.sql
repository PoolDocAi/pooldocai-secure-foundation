BEGIN;
DO $$ BEGIN
 IF to_regclass('resources_cms.owner_releases') IS NULL OR to_regprocedure('resources_cms.media_release_ready(uuid)') IS NULL THEN RAISE EXCEPTION 'Owner release prerequisites missing'; END IF;
 IF EXISTS(SELECT 1 FROM storage.buckets WHERE id='resources-cms-media') THEN RAISE EXCEPTION 'CMS bucket already exists; inspect before migration'; END IF;
END $$;
GRANT resources_cms_command_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
GRANT CREATE ON SCHEMA resources_cms TO resources_cms_command_owner;
-- Private Staging media only. No anonymous object reads or public release.
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('resources-cms-media','resources-cms-media',false,4194304,ARRAY['image/webp']) ON CONFLICT(id) DO NOTHING;
DO $$ BEGIN IF(SELECT count(*) FROM storage.buckets WHERE id='resources-cms-media' AND name='resources-cms-media' AND NOT public AND file_size_limit=4194304 AND allowed_mime_types=ARRAY['image/webp'])<>1 THEN RAISE EXCEPTION 'Unexpected CMS bucket settings';END IF;END $$;

-- Storage validates its caller JWT. Its trusted database connection is not the
-- Data API authenticator session; use the managed auth.uid() for bucket RLS.
CREATE FUNCTION resources_cms.owner_storage_member(p_roles text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM resources_cms.members WHERE user_id=auth.uid() AND active AND role=ANY(p_roles))
$$;
-- Only the internal function-owner role gains this conditional SELECT policy;
-- no API role receives a direct CMS table grant. Required so orphan checks can
-- see registered draft/archived metadata in managed Storage sessions.
CREATE POLICY cms_storage_registered_media ON resources_cms.media FOR SELECT TO resources_cms_command_owner
 USING(resources_cms.owner_storage_member(ARRAY['owner','editor','reviewer','viewer']));

CREATE FUNCTION resources_cms.owner_storage_public_object(p_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT p_name ~ '^images/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$'
 AND EXISTS(SELECT 1 FROM resources_cms.media m WHERE m.object_key=p_name AND NOT m.archived
  AND resources_cms.media_release_ready(m.id) AND resources_cms.public_media(m.id) IS NOT NULL)
$$;
CREATE FUNCTION resources_cms.owner_storage_orphan_object(p_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT resources_cms.owner_storage_member(ARRAY['owner','editor'])
 AND p_name ~ '^images/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$'
 AND NOT EXISTS(SELECT 1 FROM resources_cms.media WHERE object_key=p_name)
$$;
ALTER FUNCTION resources_cms.owner_storage_member(text[]) OWNER TO resources_cms_command_owner;
ALTER FUNCTION resources_cms.owner_storage_public_object(text) OWNER TO resources_cms_command_owner;
ALTER FUNCTION resources_cms.owner_storage_orphan_object(text) OWNER TO resources_cms_command_owner;
REVOKE ALL ON FUNCTION resources_cms.owner_storage_member(text[]),resources_cms.owner_storage_public_object(text),resources_cms.owner_storage_orphan_object(text) FROM PUBLIC,anon,authenticated,resources_cms_runtime;
GRANT EXECUTE ON FUNCTION resources_cms.owner_storage_member(text[]) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION resources_cms.owner_storage_orphan_object(text) TO authenticated;
GRANT EXECUTE ON FUNCTION resources_cms.owner_storage_public_object(text) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION resources_cms.owner_storage_member(text[]),resources_cms.owner_storage_public_object(text),resources_cms.owner_storage_orphan_object(text) TO resources_cms_command_owner;
CREATE POLICY resources_cms_media_insert ON storage.objects FOR INSERT TO authenticated
 WITH CHECK(bucket_id='resources-cms-media' AND owner_id=auth.uid()::text AND resources_cms.owner_storage_orphan_object(name));
CREATE POLICY resources_cms_media_member_select ON storage.objects FOR SELECT TO authenticated
 USING(bucket_id='resources-cms-media' AND resources_cms.owner_storage_member(ARRAY['owner','editor','reviewer','viewer']));
CREATE POLICY resources_cms_media_delete ON storage.objects FOR DELETE TO authenticated
 USING(bucket_id='resources-cms-media' AND owner_id=auth.uid()::text AND resources_cms.owner_storage_orphan_object(name));
-- Deliberately no UPDATE policy: even owner/editor cannot delete/re-upload or
-- upsert behind any registered media UUID. Archive metadata; retain old bytes
-- for immutable revision recovery. Only failed-upload orphans are deletable.

-- Existing project policies are permissive and can include bucket-independent
-- expiry guards. These additive RESTRICTIVE boundaries apply only to this bucket;
-- every unrelated bucket continues through its existing policies unchanged.
CREATE POLICY resources_cms_boundary_select ON storage.objects AS RESTRICTIVE FOR SELECT TO anon,authenticated
 USING(bucket_id<>'resources-cms-media' OR resources_cms.owner_storage_member(ARRAY['owner','editor','reviewer','viewer']));
CREATE POLICY resources_cms_boundary_insert ON storage.objects AS RESTRICTIVE FOR INSERT TO anon,authenticated
 WITH CHECK(bucket_id<>'resources-cms-media' OR (owner_id=auth.uid()::text AND resources_cms.owner_storage_orphan_object(name)));
CREATE POLICY resources_cms_boundary_update ON storage.objects AS RESTRICTIVE FOR UPDATE TO anon,authenticated
 USING(bucket_id<>'resources-cms-media') WITH CHECK(bucket_id<>'resources-cms-media');
CREATE POLICY resources_cms_boundary_delete ON storage.objects AS RESTRICTIVE FOR DELETE TO anon,authenticated
 USING(bucket_id<>'resources-cms-media' OR (owner_id=auth.uid()::text AND resources_cms.owner_storage_orphan_object(name)));


REVOKE CREATE ON SCHEMA resources_cms FROM resources_cms_command_owner;
REVOKE resources_cms_command_owner FROM postgres GRANTED BY postgres;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member WHERE r.rolname='resources_cms_command_owner' AND m.rolname='postgres' AND (a.set_option OR a.inherit_option)) THEN RAISE EXCEPTION 'Temporary role membership not removed'; END IF;
 IF (SELECT md5(string_agg(policyname||coalesce(qual,'')||coalesce(with_check,''),'' ORDER BY policyname)) FROM pg_policies WHERE schemaname='storage' AND policyname NOT LIKE 'resources_cms_%')<>'659886da728d17092583126673510f43' THEN RAISE EXCEPTION 'Existing Storage policies changed'; END IF;
END $$;
COMMIT;
