-- REVIEW CANDIDATE ONLY. NOT APPLIED REMOTELY.
-- Requires separate approval because it creates a Storage bucket and policies.
BEGIN;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES('resources-cms-media','resources-cms-media',false,4194304,ARRAY['image/webp'])
ON CONFLICT(id) DO NOTHING;
DO $guard$ BEGIN
 IF (SELECT count(*) FROM storage.buckets WHERE id='resources-cms-media' AND name='resources-cms-media' AND public=false AND file_size_limit=4194304 AND allowed_mime_types=ARRAY['image/webp'])<>1 THEN
  RAISE EXCEPTION 'Existing resources-cms-media bucket configuration is unsafe or unexpected';
 END IF;
END $guard$;

CREATE FUNCTION resources_cms.storage_member(p_roles text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM resources_cms.members WHERE user_id=auth.uid() AND active AND role=ANY(p_roles))
$$;
CREATE FUNCTION resources_cms.storage_public_object(p_name text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT p_name ~ '^images/[0-9a-f-]{36}\.webp$' AND EXISTS(
  SELECT 1 FROM resources_cms.articles a JOIN resources_cms.revisions r ON r.id=a.published_revision_id
  WHERE a.state='published' AND a.published_revision_id IS NOT NULL
    AND (r.rendered_html LIKE '%/media/'||split_part(split_part(p_name,'/',2),'.',1)||'%'
      OR r.editable->>'featuredImage'='/media/'||split_part(split_part(p_name,'/',2),'.',1)
      OR r.editable#>>'{seo,image}'='/media/'||split_part(split_part(p_name,'/',2),'.',1))
 )
$$;
REVOKE ALL ON FUNCTION resources_cms.storage_member(text[]),resources_cms.storage_public_object(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resources_cms.storage_member(text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION resources_cms.storage_public_object(text) TO anon,authenticated;

CREATE POLICY resources_cms_media_insert ON storage.objects FOR INSERT TO authenticated
 WITH CHECK(bucket_id='resources-cms-media' AND resources_cms.storage_member(ARRAY['owner','editor']) AND name ~ '^images/[0-9a-f-]{36}\.webp$');
CREATE POLICY resources_cms_media_member_select ON storage.objects FOR SELECT TO authenticated
 USING(bucket_id='resources-cms-media' AND resources_cms.storage_member(ARRAY['owner','editor','reviewer','viewer']));
CREATE POLICY resources_cms_media_public_select ON storage.objects FOR SELECT TO anon,authenticated
 USING(bucket_id='resources-cms-media' AND resources_cms.storage_public_object(name));
CREATE POLICY resources_cms_media_delete ON storage.objects FOR DELETE TO authenticated
 USING(bucket_id='resources-cms-media' AND resources_cms.storage_member(ARRAY['owner','editor']));
COMMIT;
