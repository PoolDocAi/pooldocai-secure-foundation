-- PRODUCTION REVIEW CANDIDATE. Requires verified recoverable backup, explicit migration authorization, and reviewed Gate 1/commands-v2 prerequisites.
-- Do not apply this to the existing live application before independent rehearsal. Initial owner policy intentionally DISABLED.
BEGIN;
DO $preflight$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='resources_cms' AND f.proname='command' AND encode(sha256(convert_to(pg_get_functiondef(f.oid),'UTF8')),'hex')='0a47014e040d095e9212156ecbff8776c8ab135074a7974eafe99a4064d89efc') THEN RAISE EXCEPTION 'Baseline function mismatch: command'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='resources_cms' AND f.proname='enforce_publication_release' AND encode(sha256(convert_to(pg_get_functiondef(f.oid),'UTF8')),'hex')='b628b9122fe2e8006ee0ae73fba8a65bd435d65efc0c1be045c53bcd078be3d1') THEN RAISE EXCEPTION 'Baseline function mismatch: enforce_publication_release'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='resources_cms' AND f.proname='media_command' AND encode(sha256(convert_to(pg_get_functiondef(f.oid),'UTF8')),'hex')='db04a20305e0c905db4693c1a2293a73e4e81792bc921f761f7f2213f4ff3d5e') THEN RAISE EXCEPTION 'Baseline function mismatch: media_command'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='resources_cms' AND f.proname='public_article' AND encode(sha256(convert_to(pg_get_functiondef(f.oid),'UTF8')),'hex')='a62c5885cb9cef6f1bfac338cf513b826d663d009abe3bbdf03062bccf275cb4') THEN RAISE EXCEPTION 'Baseline function mismatch: public_article'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='resources_cms' AND f.proname='public_index' AND encode(sha256(convert_to(pg_get_functiondef(f.oid),'UTF8')),'hex')='92192ec1d74908d0688e0dcfd516a16733053a75a2eeb298f42c667f2465bb49') THEN RAISE EXCEPTION 'Baseline function mismatch: public_index'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='resources_cms' AND f.proname='public_media' AND encode(sha256(convert_to(pg_get_functiondef(f.oid),'UTF8')),'hex')='31eeb41ef6e848ff8c126b6049ede4486c12f3cc2e6930af98ca0f11f92fdada') THEN RAISE EXCEPTION 'Baseline function mismatch: public_media'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='resources_cms' AND f.proname='public_redirect' AND encode(sha256(convert_to(pg_get_functiondef(f.oid),'UTF8')),'hex')='64eb690740b10ef49df1012588743827ac7db355482c79162b7ba8da9e1f24a7') THEN RAISE EXCEPTION 'Baseline function mismatch: public_redirect'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid=f.pronamespace WHERE n.nspname='resources_cms' AND f.proname='taxonomy_command' AND encode(sha256(convert_to(pg_get_functiondef(f.oid),'UTF8')),'hex')='b7ba05d1ffbc43df667bf308dce6ea4281a1e51ec099172a4116a207c43f8987') THEN RAISE EXCEPTION 'Baseline function mismatch: taxonomy_command'; END IF;
 IF (SELECT count(*) FROM resources_cms.articles)<>0 OR (SELECT count(*) FROM resources_cms.revisions)<>0 OR (SELECT count(*) FROM resources_cms.publication_authorizations)<>0 OR (SELECT count(*) FROM resources_cms.knowledge_grants)<>0
  OR (SELECT count(*) FROM resources_cms.members)<>1
  OR NOT EXISTS (
    SELECT 1 FROM resources_cms.members m
    JOIN auth.users u ON u.id=m.user_id
    WHERE m.role='owner' AND m.active AND u.email_confirmed_at IS NOT NULL
      AND u.deleted_at IS NULL AND coalesce(u.banned_until,'-infinity'::timestamptz) < now()
  ) THEN RAISE EXCEPTION 'Production CMS empty baseline or verified owner missing'; END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='resources_cms_command_owner' AND NOT rolcanlogin AND NOT rolsuper AND NOT rolbypassrls) THEN RAISE EXCEPTION 'Command owner precondition failed'; END IF;
 IF pg_has_role('postgres','resources_cms_command_owner','SET') OR pg_has_role('postgres','resources_cms_command_owner','USAGE') THEN RAISE EXCEPTION 'Unexpected preexisting effective membership'; END IF;
END $preflight$;
GRANT resources_cms_command_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
CREATE TABLE resources_cms.owner_release_policy(id boolean PRIMARY KEY DEFAULT true CHECK(id),destination text NOT NULL CHECK(destination IN ('staging','production')),enabled boolean NOT NULL DEFAULT false);
INSERT INTO resources_cms.owner_release_policy VALUES(true,'production',false);
CREATE TABLE resources_cms.publication_blocks(article_id uuid NOT NULL REFERENCES resources_cms.articles(id) DEFERRABLE INITIALLY DEFERRED,block_key text NOT NULL,reason text NOT NULL,PRIMARY KEY(article_id,block_key));
CREATE TABLE resources_cms.owner_releases(
 command_id uuid PRIMARY KEY,article_id uuid NOT NULL,revision_id uuid NOT NULL,content_checksum text NOT NULL,article_version integer NOT NULL,
 destination text NOT NULL CHECK(destination IN ('staging','production')),hold_checksum text,authorized_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),result jsonb,
 FOREIGN KEY(article_id,revision_id) REFERENCES resources_cms.revisions(article_id,id) DEFERRABLE INITIALLY DEFERRED);
-- Owner releases are append-only. A command receipt stores the replay result separately.
CREATE TRIGGER cms_owner_release_immutable BEFORE UPDATE OR DELETE ON resources_cms.owner_releases FOR EACH ROW EXECUTE FUNCTION resources_cms.immutable_record();
CREATE TRIGGER cms_publication_blocks_immutable BEFORE UPDATE OR DELETE ON resources_cms.publication_blocks FOR EACH ROW EXECUTE FUNCTION resources_cms.immutable_record();
ALTER TABLE resources_cms.owner_release_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources_cms.publication_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources_cms.owner_releases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON resources_cms.owner_release_policy,resources_cms.publication_blocks,resources_cms.owner_releases FROM PUBLIC,anon,authenticated,resources_cms_runtime;
GRANT SELECT ON resources_cms.owner_release_policy,resources_cms.publication_blocks,resources_cms.owner_releases TO resources_cms_command_owner;
GRANT INSERT ON resources_cms.owner_releases,resources_cms.publication_authorizations,resources_cms.publication_blocks,resources_cms.editorial_holds TO resources_cms_command_owner;
CREATE POLICY cms_owner_hold_insert ON resources_cms.editorial_holds FOR INSERT TO resources_cms_command_owner WITH CHECK(resources_cms.has_role(ARRAY['owner']));
CREATE POLICY cms_release_policy_read ON resources_cms.owner_release_policy FOR SELECT TO resources_cms_command_owner USING(true);
CREATE POLICY cms_publication_block_read ON resources_cms.publication_blocks FOR SELECT TO resources_cms_command_owner USING(true);
CREATE POLICY cms_publication_block_insert ON resources_cms.publication_blocks FOR INSERT TO resources_cms_command_owner WITH CHECK(resources_cms.has_role(ARRAY['owner']));
CREATE POLICY cms_owner_release_read ON resources_cms.owner_releases FOR SELECT TO resources_cms_command_owner USING(true);
CREATE POLICY cms_owner_release_insert ON resources_cms.owner_releases FOR INSERT TO resources_cms_command_owner WITH CHECK(resources_cms.has_role(ARRAY['owner']) AND authorized_by=resources_cms.actor());
CREATE POLICY cms_release_authorization_insert ON resources_cms.publication_authorizations FOR INSERT TO resources_cms_command_owner WITH CHECK(resources_cms.has_role(ARRAY['owner']) AND authorized_by=resources_cms.actor());
-- Public visibility follows the immutable published pointer, never a working draft.
ALTER POLICY cms_public_articles ON resources_cms.articles USING(published_revision_id IS NOT NULL AND state NOT IN ('archived','deleted'));
ALTER POLICY cms_public_revisions ON resources_cms.revisions USING(EXISTS(SELECT 1 FROM resources_cms.articles a WHERE a.published_revision_id=revisions.id AND a.state NOT IN ('archived','deleted')));
ALTER POLICY cms_public_redirects ON resources_cms.redirects USING(EXISTS(SELECT 1 FROM resources_cms.articles a WHERE a.id=redirects.article_id AND a.published_revision_id IS NOT NULL AND a.state NOT IN ('archived','deleted')));
ALTER POLICY cms_public_media ON resources_cms.media USING(NOT archived AND EXISTS(SELECT 1 FROM resources_cms.articles a JOIN resources_cms.revisions r ON r.id=a.published_revision_id WHERE a.state NOT IN ('archived','deleted') AND (r.rendered_html LIKE '%/media/'||media.id::text||'%' OR r.editable->>'featuredImage'='/media/'||media.id::text OR r.editable#>>'{seo,image}'='/media/'||media.id::text)));
GRANT CREATE ON SCHEMA resources_cms TO resources_cms_command_owner;
SET ROLE resources_cms_command_owner;
CREATE FUNCTION resources_cms.guard_revision_body() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF NEW.rendered_html IS DISTINCT FROM NEW.editable->>'body' OR NOT resources_cms.safe_public_html(NEW.rendered_html) THEN RAISE EXCEPTION 'Unsafe revision HTML rejected'; END IF;
 IF NEW.editable ? 'legacyHtml' AND NOT ((encode(sha256(convert_to(NEW.editable->>'legacyHtml','UTF8')),'hex')='3592015d9b1fc87d0584eff67e45fc82c54541571579f51dad0b49e2fcafc228' AND encode(sha256(convert_to(NEW.rendered_html,'UTF8')),'hex')='2a8c62210370656eab638f397177bdb9d9df46f47163d8a5bef0bb8a59ff968c') OR (encode(sha256(convert_to(NEW.editable->>'legacyHtml','UTF8')),'hex')='50a14dd25511821e7893d32b5d16f38f060909bd59891f8dbcaf2eb5d25e4207' AND encode(sha256(convert_to(NEW.rendered_html,'UTF8')),'hex')='f44ba16340ded8a2e64af9872ac14c69246adca402952a89e3f80fbf6f3f6735')) THEN RAISE EXCEPTION 'Unrecognized legacy snapshot'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION resources_cms.guard_revision_body() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION resources_cms.guard_revision_body(),resources_cms.safe_public_html(text) TO postgres;
CREATE FUNCTION resources_cms.owner_publish(p_command_id uuid,p_id uuid,p_version integer,p_revision_id uuid,p_checksum text,p_destination text,p_confirm boolean,p_hold_checksum text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=resources_cms.actor(); a resources_cms.articles; r resources_cms.revisions; hold_record resources_cms.editorial_holds; fp text; prior resources_cms.command_receipts; answer jsonb;
BEGIN
 IF actor IS NULL OR NOT resources_cms.has_role(ARRAY['owner']) THEN RAISE EXCEPTION 'Owner required'; END IF;
 IF p_confirm IS DISTINCT FROM true OR p_command_id IS NULL OR p_revision_id IS NULL OR p_checksum IS NULL OR p_version IS NULL OR p_version<1 THEN RAISE EXCEPTION 'Explicit revision confirmation required'; END IF;
 IF NOT EXISTS(SELECT 1 FROM resources_cms.owner_release_policy WHERE id AND enabled AND destination=p_destination) THEN RAISE EXCEPTION 'Publication destination disabled'; END IF;
 fp:=encode(sha256(convert_to(jsonb_build_array(p_id,p_version,p_revision_id,p_checksum,p_destination,p_hold_checksum)::text,'UTF8')),'hex');
 PERFORM pg_advisory_xact_lock(hashtextextended(p_command_id::text,0));
 SELECT * INTO prior FROM resources_cms.command_receipts WHERE command_id=p_command_id;
 IF FOUND THEN
  IF prior.actor_id<>actor OR prior.namespace<>'owner-publish' OR prior.target_id IS DISTINCT FROM p_id OR prior.fingerprint<>fp THEN RAISE EXCEPTION 'Idempotency key reuse rejected'; END IF;
  RETURN prior.result;
 END IF;
 SELECT * INTO a FROM resources_cms.articles WHERE id=p_id FOR UPDATE;
 IF NOT FOUND OR a.version<>p_version OR a.working_revision_id<>p_revision_id OR a.state<>'approved' THEN RAISE EXCEPTION 'Approved revision conflict'; END IF;
 SELECT * INTO r FROM resources_cms.revisions WHERE article_id=p_id AND id=p_revision_id;
 IF (a.published_at IS NOT NULL OR EXISTS(SELECT 1 FROM resources_cms.owner_import_sources s WHERE s.article_id=p_id AND s.approval_status='historical-live-snapshot')) AND a.slug<>r.editable->>'slug' THEN RAISE EXCEPTION 'Published URL change requires separate authorization'; END IF;
 IF coalesce(r.editable#>>'{seo,canonical}','')<>'' AND regexp_replace(r.editable#>>'{seo,canonical}','/$','')<>'https://pooldocai.com/resources/'||(r.editable->>'slug') THEN RAISE EXCEPTION 'Canonical URL must match the resource'; END IF;
 IF EXISTS(SELECT 1 FROM regexp_matches(r.rendered_html,'(<img(?:[[:space:]][^>]*)?>)','gi') img WHERE img[1] !~ 'alt="[^"]+"' OR img[1] !~ 'src="/media/[a-f0-9-]{36}"') THEN RAISE EXCEPTION 'Canonical image and alternative text required'; END IF;

 IF r.editable->>'slug' IN ('collections','discover') THEN RAISE EXCEPTION 'Reserved resource route'; END IF;
 IF r.content_checksum<>p_checksum OR NOT resources_cms.safe_public_html(r.rendered_html) THEN RAISE EXCEPTION 'Revision checksum or HTML rejected'; END IF;
 IF EXISTS(SELECT 1 FROM resources_cms.publication_blocks WHERE article_id=p_id) THEN RAISE EXCEPTION 'Unresolved publication dependency'; END IF;
 IF EXISTS(SELECT 1 FROM resources_cms.knowledge_grants WHERE article_id=p_id AND active) THEN
  -- The normal publication transition revokes old grants atomically. It never creates one.
  NULL;
 END IF;
 SELECT * INTO hold_record FROM resources_cms.editorial_holds WHERE article_id=p_id;
 IF FOUND AND (hold_record.resource_number='30' OR p_hold_checksum IS DISTINCT FROM hold_record.source_checksum) THEN RAISE EXCEPTION 'Editorial hold confirmation required'; END IF;
 IF NOT FOUND AND p_hold_checksum IS NOT NULL THEN RAISE EXCEPTION 'Unexpected hold confirmation'; END IF;
 -- No images are released without an independently reviewed rights/delivery gate.
 IF EXISTS(SELECT 1 FROM regexp_matches(r.rendered_html,'/media/([a-f0-9-]{36})','g') refs WHERE NOT resources_cms.media_release_ready(refs[1]::uuid)) THEN RAISE EXCEPTION 'Image rights and relevance review required'; END IF;
 IF coalesce(r.editable->>'featuredImage','')<>'' AND (r.editable->>'featuredImage' !~ '^/media/[a-f0-9-]{36}$' OR NOT resources_cms.media_release_ready(substring(r.editable->>'featuredImage' FROM 8)::uuid)) THEN RAISE EXCEPTION 'Featured image rights and relevance review required'; END IF;
 IF coalesce(r.editable#>>'{seo,image}','')<>'' AND NOT ((r.editable#>>'{seo,image}' ~ '^/media/[a-f0-9-]{36}$' AND resources_cms.media_release_ready(substring(r.editable#>>'{seo,image}' FROM 8)::uuid)) OR (
  r.editable#>>'{seo,image}'='/assets/day-1536.webp' AND EXISTS(
   SELECT 1 FROM resources_cms.owner_import_sources s, jsonb_array_elements(s.envelope->'history') h
   WHERE s.article_id=p_id AND s.approval_status='historical-live-snapshot' AND h#>>'{editable,seo,image}'=r.editable#>>'{seo,image}'
  ))) THEN RAISE EXCEPTION 'Image publication review is not enabled'; END IF;
 INSERT INTO resources_cms.owner_releases(command_id,article_id,revision_id,content_checksum,article_version,destination,hold_checksum,authorized_by) VALUES(p_command_id,p_id,r.id,r.content_checksum,a.version,p_destination,p_hold_checksum,actor);
 INSERT INTO resources_cms.publication_authorizations(article_id,revision_id,capability,authorized_by,approval_reference) VALUES(p_id,r.id,'publish',actor,'owner-release:'||p_command_id::text);
 IF a.published_at IS NULL AND coalesce(r.editable->>'publishedAt','')<>'' THEN
  IF (r.editable->>'publishedAt')::timestamptz>now() THEN RAISE EXCEPTION 'Future original publication date rejected'; END IF;
  UPDATE resources_cms.articles SET published_at=(r.editable->>'publishedAt')::timestamptz WHERE id=p_id;
 END IF;
 answer:=resources_cms.command(p_id,p_version,'publish','{}');
 INSERT INTO resources_cms.audit(actor_id,action,article_id,detail) VALUES(actor,'owner_revision_release',p_id,jsonb_build_object('revisionId',r.id,'checksum',r.content_checksum,'destination',p_destination,'commandId',p_command_id));
 INSERT INTO resources_cms.command_receipts(command_id,actor_id,namespace,target_id,fingerprint,result) VALUES(p_command_id,actor,'owner-publish',p_id,fp,answer);
 RETURN answer;
END $$;
RESET ROLE;
CREATE OR REPLACE FUNCTION resources_cms.enforce_publication_release() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE needed_capability text; target uuid; hold_record resources_cms.editorial_holds;
BEGIN
 IF NEW.state='scheduled' AND (TG_OP='INSERT' OR OLD.state IS DISTINCT FROM NEW.state OR OLD.working_revision_id IS DISTINCT FROM NEW.working_revision_id) THEN needed_capability:='schedule';target:=NEW.working_revision_id;
 ELSIF NEW.published_revision_id IS NOT NULL AND (TG_OP='INSERT' OR OLD.published_revision_id IS DISTINCT FROM NEW.published_revision_id OR NEW.state='published' AND OLD.state IS DISTINCT FROM NEW.state) THEN needed_capability:='publish';target:=NEW.published_revision_id;
 END IF;
 IF needed_capability IS NOT NULL THEN
  IF needed_capability='publish' AND NOT EXISTS(SELECT 1 FROM resources_cms.owner_releases o JOIN resources_cms.revisions r ON r.id=o.revision_id WHERE o.article_id=NEW.id AND o.revision_id=target AND o.article_version=OLD.version AND o.content_checksum=r.content_checksum) THEN RAISE EXCEPTION 'Fresh owner revision authorization required'; END IF;
  IF EXISTS(SELECT 1 FROM resources_cms.publication_blocks WHERE article_id=NEW.id) THEN RAISE EXCEPTION 'Unresolved publication dependency'; END IF;
  SELECT * INTO hold_record FROM resources_cms.editorial_holds WHERE article_id=NEW.id;
  IF FOUND AND NOT EXISTS(SELECT 1 FROM resources_cms.owner_releases o JOIN resources_cms.revisions r ON r.article_id=o.article_id AND r.id=o.revision_id WHERE o.article_id=NEW.id AND o.revision_id=target AND o.hold_checksum=hold_record.source_checksum AND o.content_checksum=r.content_checksum AND hold_record.resource_number<>'30' AND needed_capability='publish') THEN RAISE EXCEPTION 'Editorial publication hold'; END IF;
  IF NOT EXISTS(SELECT 1 FROM resources_cms.publication_authorizations WHERE article_id=NEW.id AND revision_id=target AND publication_authorizations.capability=needed_capability) THEN RAISE EXCEPTION 'Separate publication authorization required'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION resources_cms.enforce_publication_release() FROM PUBLIC,anon,authenticated,service_role;
SET ROLE resources_cms_command_owner;
CREATE OR REPLACE FUNCTION resources_cms.public_article(p_slug text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('id',a.id,'slug',a.slug,'state','published','version',r.revision_number,'publishedAt',a.published_at,'updatedAt',r.created_at,'revisionId',r.id,'content',r.editable,'renderedHtml',r.rendered_html,'sources',r.sources,'categoryId',coalesce(tr.target_id,r.primary_category_id),'categoryName',c.name,'tagIds',r.tag_ids,'audience',r.audience)
 FROM resources_cms.articles a JOIN resources_cms.revisions r ON r.id=a.published_revision_id
 LEFT JOIN resources_cms.taxonomy_redirects tr ON tr.source_id=r.primary_category_id
 LEFT JOIN resources_cms.taxonomy c ON c.id=coalesce(tr.target_id,r.primary_category_id)
 WHERE a.slug=p_slug AND a.published_revision_id IS NOT NULL AND a.state NOT IN ('archived','deleted') AND EXISTS(SELECT 1 FROM resources_cms.publication_authorizations pa WHERE pa.article_id=a.id AND pa.revision_id=a.published_revision_id AND pa.capability='publish') AND NOT EXISTS(SELECT 1 FROM resources_cms.publication_blocks b WHERE b.article_id=a.id) AND (NOT EXISTS(SELECT 1 FROM resources_cms.editorial_holds h WHERE h.article_id=a.id) OR EXISTS(SELECT 1 FROM resources_cms.editorial_holds h JOIN resources_cms.owner_releases o ON o.article_id=h.article_id AND o.hold_checksum=h.source_checksum WHERE h.article_id=a.id AND o.revision_id=a.published_revision_id))
$$;
CREATE OR REPLACE FUNCTION resources_cms.public_index() RETURNS TABLE(article_id uuid,slug text,published_at timestamptz,updated_at timestamptz,revision_id uuid,content jsonb,rendered_html text,category_id uuid,category_name text,tag_ids uuid[],tag_names text[],audience text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT a.id,a.slug,a.published_at,r.created_at,r.id,r.editable,r.rendered_html,coalesce(tr.target_id,r.primary_category_id),c.name,
   ARRAY(SELECT coalesce(ttr.target_id,tag_id) FROM unnest(r.tag_ids) tag_id LEFT JOIN resources_cms.taxonomy_redirects ttr ON ttr.source_id=tag_id),
   ARRAY(SELECT tt.name FROM unnest(r.tag_ids) tag_id LEFT JOIN resources_cms.taxonomy_redirects ttr ON ttr.source_id=tag_id JOIN resources_cms.taxonomy tt ON tt.id=coalesce(ttr.target_id,tag_id)),r.audience
 FROM resources_cms.articles a JOIN resources_cms.revisions r ON r.id=a.published_revision_id
 LEFT JOIN resources_cms.taxonomy_redirects tr ON tr.source_id=r.primary_category_id
 LEFT JOIN resources_cms.taxonomy c ON c.id=coalesce(tr.target_id,r.primary_category_id)
 WHERE a.published_revision_id IS NOT NULL AND a.state NOT IN ('archived','deleted') AND EXISTS(SELECT 1 FROM resources_cms.publication_authorizations pa WHERE pa.article_id=a.id AND pa.revision_id=a.published_revision_id AND pa.capability='publish') AND NOT EXISTS(SELECT 1 FROM resources_cms.publication_blocks b WHERE b.article_id=a.id) AND (NOT EXISTS(SELECT 1 FROM resources_cms.editorial_holds h WHERE h.article_id=a.id) OR EXISTS(SELECT 1 FROM resources_cms.editorial_holds h JOIN resources_cms.owner_releases o ON o.article_id=h.article_id AND o.hold_checksum=h.source_checksum WHERE h.article_id=a.id AND o.revision_id=a.published_revision_id)) ORDER BY a.published_at DESC,a.id
$$;
CREATE OR REPLACE FUNCTION resources_cms.public_media(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('id',m.id,'name',m.name,'mime',m.mime,'sizeBytes',m.size_bytes,'objectKey',m.object_key,'checksum',m.checksum,'alt',m.alt)
 FROM resources_cms.media m
 WHERE m.id=p_id AND NOT m.archived AND resources_cms.media_release_ready(m.id) AND EXISTS(
  SELECT 1 FROM resources_cms.articles a JOIN resources_cms.revisions r ON r.id=a.published_revision_id
  WHERE a.published_revision_id IS NOT NULL AND a.state NOT IN ('archived','deleted') AND EXISTS(SELECT 1 FROM resources_cms.publication_authorizations pa WHERE pa.article_id=a.id AND pa.revision_id=a.published_revision_id AND pa.capability='publish') AND NOT EXISTS(SELECT 1 FROM resources_cms.publication_blocks b WHERE b.article_id=a.id) AND (NOT EXISTS(SELECT 1 FROM resources_cms.editorial_holds h WHERE h.article_id=a.id) OR EXISTS(SELECT 1 FROM resources_cms.editorial_holds h JOIN resources_cms.owner_releases o ON o.article_id=h.article_id AND o.hold_checksum=h.source_checksum WHERE h.article_id=a.id AND o.revision_id=a.published_revision_id))
    AND (r.rendered_html LIKE '%/media/'||p_id::text||'%' OR r.editable->>'featuredImage'='/media/'||p_id::text OR r.editable#>>'{seo,image}'='/media/'||p_id::text)
 )
$$;
CREATE OR REPLACE FUNCTION resources_cms.public_redirect(p_slug text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT a.slug FROM resources_cms.redirects r JOIN resources_cms.articles a ON a.id=r.article_id
 WHERE r.old_slug=p_slug AND a.published_revision_id IS NOT NULL AND a.state NOT IN ('archived','deleted') AND EXISTS(SELECT 1 FROM resources_cms.publication_authorizations pa WHERE pa.article_id=a.id AND pa.revision_id=a.published_revision_id AND pa.capability='publish') AND NOT EXISTS(SELECT 1 FROM resources_cms.publication_blocks b WHERE b.article_id=a.id) AND (NOT EXISTS(SELECT 1 FROM resources_cms.editorial_holds h WHERE h.article_id=a.id) OR EXISTS(SELECT 1 FROM resources_cms.editorial_holds h JOIN resources_cms.owner_releases o ON o.article_id=h.article_id AND o.hold_checksum=h.source_checksum WHERE h.article_id=a.id AND o.revision_id=a.published_revision_id))
$$;
-- One fixed, allowlisted read gateway keeps tables private from the Data API.
-- Every administrative branch rechecks immutable JWT identity against CMS membership.

CREATE FUNCTION resources_cms.release_info(p_id uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE answer jsonb;
BEGIN
 IF resources_cms.actor() IS NULL OR NOT resources_cms.has_role(ARRAY['owner']) THEN RAISE EXCEPTION 'Owner required'; END IF;
 SELECT jsonb_build_object('articleId',a.id,'version',a.version,'revisionId',r.id,'checksum',r.content_checksum,'state',a.state,'holdChecksum',h.source_checksum,'holdReason',h.reason,'destination',p.destination,'enabled',p.enabled,'blocks',(SELECT coalesce(jsonb_agg(jsonb_build_object('key',b.block_key,'reason',b.reason)),'[]') FROM resources_cms.publication_blocks b WHERE b.article_id=a.id)) INTO answer
 FROM resources_cms.articles a JOIN resources_cms.revisions r ON r.id=a.working_revision_id LEFT JOIN resources_cms.editorial_holds h ON h.article_id=a.id CROSS JOIN resources_cms.owner_release_policy p WHERE a.id=p_id;
 RETURN answer;
END $$;
CREATE FUNCTION resources_cms.owner_backup() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE base jsonb;
BEGIN
 IF resources_cms.actor() IS NULL OR NOT resources_cms.has_role(ARRAY['owner']) THEN RAISE EXCEPTION 'Owner required'; END IF;
 base:=resources_cms.query('export-all','{}');
 RETURN base||jsonb_build_object('ownerRecovery',jsonb_build_object('format','resources-owner-recovery-v1','data',jsonb_build_object(
 'owner_release_policy',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM resources_cms.owner_release_policy t),
 'publication_blocks',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM resources_cms.publication_blocks t),
 'owner_releases',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM resources_cms.owner_releases t),
 'media_rights_reviews',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM resources_cms.media_rights_reviews t),
 'approved_import_allowlist',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM resources_cms.approved_import_allowlist t),
 'owner_import_sources',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM resources_cms.owner_import_sources t))));
END $$;
REVOKE ALL ON FUNCTION resources_cms.owner_backup() FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION resources_cms.owner_backup() TO authenticated;
REVOKE ALL ON FUNCTION resources_cms.owner_publish(uuid,uuid,integer,uuid,text,text,boolean,text),resources_cms.release_info(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION resources_cms.owner_publish(uuid,uuid,integer,uuid,text,text,boolean,text),resources_cms.release_info(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION resources_cms.public_article(text),resources_cms.public_index(),resources_cms.public_media(uuid),resources_cms.public_redirect(text) TO anon,authenticated;
RESET ROLE;
CREATE TRIGGER cms_safe_revision BEFORE INSERT ON resources_cms.revisions FOR EACH ROW EXECUTE FUNCTION resources_cms.guard_revision_body();
REVOKE CREATE ON SCHEMA resources_cms FROM resources_cms_command_owner;
REVOKE resources_cms_command_owner FROM postgres GRANTED BY postgres RESTRICT;
DO $postflight$ BEGIN
 IF pg_has_role('postgres','resources_cms_command_owner','SET') OR pg_has_role('postgres','resources_cms_command_owner','USAGE') OR has_schema_privilege('resources_cms_command_owner','resources_cms','CREATE') THEN RAISE EXCEPTION 'Temporary privilege remains'; END IF;
END $postflight$;
COMMIT;
