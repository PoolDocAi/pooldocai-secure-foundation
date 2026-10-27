-- RELEASE-CANDIDATE SQL ONLY. NOT APPLIED REMOTELY.
-- Data API roles get only allowlisted RPC EXECUTE. No CMS database LOGIN is used.
BEGIN;
CREATE ROLE resources_cms_command_owner NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
DO $guard$ BEGIN
 IF current_user<>'postgres' OR (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) THEN RAISE EXCEPTION 'Expected hosted Supabase non-superuser postgres executor'; END IF;
 IF (SELECT count(*) FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member JOIN pg_roles g ON g.oid=a.grantor WHERE r.rolname='resources_cms_command_owner' AND m.rolname='postgres' AND g.rolname='supabase_admin' AND a.admin_option AND NOT a.inherit_option AND NOT a.set_option)<>1 THEN RAISE EXCEPTION 'Expected managed PostgreSQL 17 creator membership missing'; END IF;
END $guard$;
-- This is a second, grantor-specific row. It exists only for ownership transfer.
GRANT resources_cms_command_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
DO $guard$ BEGIN
 IF (SELECT count(*) FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member JOIN pg_roles g ON g.oid=a.grantor WHERE r.rolname='resources_cms_command_owner' AND m.rolname='postgres' AND g.rolname='postgres' AND NOT a.admin_option AND NOT a.inherit_option AND a.set_option)<>1 THEN RAISE EXCEPTION 'Temporary SET-only membership missing or unsafe'; END IF;
END $guard$;
ALTER TABLE resources_cms.articles ADD COLUMN published_at timestamptz;
ALTER TABLE resources_cms.taxonomy ADD COLUMN version integer NOT NULL DEFAULT 1;
ALTER TABLE resources_cms.media ADD COLUMN archived boolean NOT NULL DEFAULT false;
ALTER TABLE resources_cms.media ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
-- v1 used a server-supplied custom GUC. Direct database logins can forge custom
-- GUCs, so v2 binds authorization exclusively to PostgREST's verified JWT
-- request context. The role claim check makes non-Data-API SQL sessions fail closed.
CREATE OR REPLACE FUNCTION resources_cms.actor() RETURNS uuid
LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
 SELECT CASE
  WHEN session_user='authenticator' AND claims->>'role'='authenticated'
  THEN nullif(claims->>'sub','')::uuid
  ELSE NULL::uuid
 END FROM (SELECT coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb AS claims) request_context
$$;
CREATE TABLE resources_cms.command_receipts(
 command_id uuid PRIMARY KEY,
 actor_id uuid NOT NULL,
 namespace text NOT NULL,
 target_id uuid,
 fingerprint text NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE resources_cms.taxonomy_redirects(
 source_id uuid PRIMARY KEY REFERENCES resources_cms.taxonomy(id),
 target_id uuid NOT NULL REFERENCES resources_cms.taxonomy(id),
 merged_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(source_id<>target_id)
);
ALTER TABLE resources_cms.command_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources_cms.taxonomy_redirects ENABLE ROW LEVEL SECURITY;
CREATE TABLE resources_cms.editorial_holds(
 article_id uuid PRIMARY KEY REFERENCES resources_cms.articles(id) DEFERRABLE INITIALLY DEFERRED,
 resource_number text NOT NULL,source_checksum text NOT NULL CHECK(source_checksum ~ '^[a-f0-9]{64}$'),
 reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE resources_cms.publication_authorizations(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),article_id uuid NOT NULL,
 revision_id uuid NOT NULL,capability text NOT NULL CHECK(capability IN ('publish','schedule')),
 authorized_by uuid NOT NULL,approval_reference text NOT NULL CHECK(length(approval_reference)>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(article_id,revision_id) REFERENCES resources_cms.revisions(article_id,id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE resources_cms.editorial_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources_cms.publication_authorizations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON resources_cms.editorial_holds,resources_cms.publication_authorizations FROM PUBLIC,anon,authenticated,resources_cms_runtime;
GRANT SELECT ON resources_cms.editorial_holds,resources_cms.publication_authorizations TO resources_cms_command_owner;
CREATE POLICY cms_hold_read ON resources_cms.editorial_holds FOR SELECT TO resources_cms_command_owner USING(true);
CREATE POLICY cms_publication_authorization_read ON resources_cms.publication_authorizations FOR SELECT TO resources_cms_command_owner USING(true);
CREATE TRIGGER cms_holds_immutable BEFORE UPDATE OR DELETE ON resources_cms.editorial_holds FOR EACH ROW EXECUTE FUNCTION resources_cms.immutable_record();
CREATE TRIGGER cms_release_immutable BEFORE UPDATE OR DELETE ON resources_cms.publication_authorizations FOR EACH ROW EXECUTE FUNCTION resources_cms.immutable_record();
CREATE FUNCTION resources_cms.enforce_publication_release() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE required_capability text;
BEGIN
 IF NEW.state='scheduled' AND (TG_OP='INSERT' OR OLD.state IS DISTINCT FROM NEW.state OR OLD.working_revision_id IS DISTINCT FROM NEW.working_revision_id) THEN required_capability:='schedule';
 ELSIF NEW.state='published' AND (TG_OP='INSERT' OR OLD.state IS DISTINCT FROM NEW.state OR OLD.published_revision_id IS DISTINCT FROM NEW.published_revision_id) THEN required_capability:='publish';
 END IF;
 IF required_capability IS NOT NULL THEN
  IF EXISTS(SELECT 1 FROM resources_cms.editorial_holds WHERE article_id=NEW.id) THEN RAISE EXCEPTION 'Editorial publication hold'; END IF;
  IF NOT EXISTS(SELECT 1 FROM resources_cms.publication_authorizations WHERE article_id=NEW.id AND revision_id=NEW.working_revision_id AND capability=required_capability) THEN RAISE EXCEPTION 'Separate publication authorization required'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER cms_publication_release BEFORE INSERT OR UPDATE ON resources_cms.articles FOR EACH ROW EXECUTE FUNCTION resources_cms.enforce_publication_release();
-- Retire the v1 direct-Postgres runtime surface. The NOLOGIN role remains so
-- the applied v1 migration is not destructively rewritten, but it owns nothing,
-- has no CMS privileges, and must never be granted to a LOGIN role.
REVOKE ALL ON ALL TABLES IN SCHEMA resources_cms FROM resources_cms_runtime;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA resources_cms FROM resources_cms_runtime;
REVOKE USAGE ON SCHEMA resources_cms FROM resources_cms_runtime;
GRANT USAGE ON SCHEMA resources_cms TO anon,authenticated,resources_cms_command_owner;
GRANT USAGE,CREATE ON SCHEMA resources_cms TO resources_cms_command_owner;
GRANT SELECT ON ALL TABLES IN SCHEMA resources_cms TO resources_cms_command_owner;
GRANT INSERT,UPDATE ON resources_cms.articles,resources_cms.knowledge_grants,resources_cms.media TO resources_cms_command_owner;
GRANT INSERT ON resources_cms.revisions,resources_cms.approval_history,resources_cms.audit,resources_cms.outbox,resources_cms.redirects,resources_cms.command_receipts,resources_cms.taxonomy_redirects TO resources_cms_command_owner;
GRANT INSERT,UPDATE ON resources_cms.taxonomy TO resources_cms_command_owner;
GRANT INSERT,UPDATE ON resources_cms.settings TO resources_cms_command_owner;
GRANT EXECUTE ON FUNCTION resources_cms.actor(),resources_cms.has_role(text[]) TO resources_cms_command_owner;
-- The owner role is NOLOGIN and reachable only through the allowlisted definer
-- routines below. It needs the complete membership set for authorization and
-- owner-only backup; API roles retain no direct table privilege.
CREATE POLICY cms_command_members ON resources_cms.members FOR SELECT TO resources_cms_command_owner USING(true);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['taxonomy','articles','revisions','approval_history','knowledge_grants','outbox','redirects','media','audit','settings','taxonomy_redirects'] LOOP
 EXECUTE format('CREATE POLICY cms_command_access ON resources_cms.%I FOR ALL TO resources_cms_command_owner USING(resources_cms.has_role(ARRAY[''owner'',''editor'',''reviewer''])) WITH CHECK(resources_cms.has_role(ARRAY[''owner'',''editor'',''reviewer'']))',t);
 END LOOP;
END $$;
CREATE POLICY cms_command_receipts ON resources_cms.command_receipts FOR ALL TO resources_cms_command_owner USING(actor_id=resources_cms.actor()) WITH CHECK(actor_id=resources_cms.actor());
-- Only trusted administrative sessions can run the internal scheduler. No
-- Data API role has EXECUTE on publish_due, and no CMS database LOGIN exists.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['articles','approval_history','knowledge_grants','outbox','audit'] LOOP
 EXECUTE format('CREATE POLICY cms_scheduler_access ON resources_cms.%I FOR ALL TO resources_cms_command_owner USING(session_user=''postgres'') WITH CHECK(session_user=''postgres'')',t);
 END LOOP;
END $$;
-- The server runtime may read only rows that are already public when no actor
-- GUC is present. Draft/member reads continue through the v1 membership policy.
CREATE POLICY cms_public_articles ON resources_cms.articles FOR SELECT TO resources_cms_command_owner USING(state='published' AND published_revision_id IS NOT NULL);
CREATE POLICY cms_public_revisions ON resources_cms.revisions FOR SELECT TO resources_cms_command_owner USING(EXISTS(SELECT 1 FROM resources_cms.articles a WHERE a.state='published' AND a.published_revision_id=revisions.id));
CREATE POLICY cms_public_taxonomy ON resources_cms.taxonomy FOR SELECT TO resources_cms_command_owner USING(NOT archived);
CREATE POLICY cms_public_taxonomy_redirects ON resources_cms.taxonomy_redirects FOR SELECT TO resources_cms_command_owner USING(true);
CREATE POLICY cms_public_redirects ON resources_cms.redirects FOR SELECT TO resources_cms_command_owner USING(EXISTS(SELECT 1 FROM resources_cms.articles a WHERE a.id=redirects.article_id AND a.state='published'));
CREATE POLICY cms_public_media ON resources_cms.media FOR SELECT TO resources_cms_command_owner USING(NOT archived AND EXISTS(SELECT 1 FROM resources_cms.articles a JOIN resources_cms.revisions r ON r.id=a.published_revision_id WHERE a.state='published' AND (r.rendered_html LIKE '%/media/'||media.id::text||'%' OR r.editable->>'featuredImage'='/media/'||media.id::text OR r.editable#>>'{seo,image}'='/media/'||media.id::text)));
CREATE OR REPLACE FUNCTION resources_cms.revoke_on_article_change() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE withdrawn resources_cms.knowledge_grants;
BEGIN
 IF OLD.working_revision_id IS DISTINCT FROM NEW.working_revision_id OR NEW.state IN ('archived','deleted') OR OLD.published_revision_id IS DISTINCT FROM NEW.published_revision_id THEN
  FOR withdrawn IN UPDATE resources_cms.knowledge_grants SET active=false WHERE article_id=NEW.id AND active RETURNING * LOOP
   INSERT INTO resources_cms.outbox(approval_id,article_id,revision_id,event) VALUES(withdrawn.approval_id,withdrawn.article_id,withdrawn.revision_id,'revoke') ON CONFLICT(approval_id,event) DO NOTHING;
   INSERT INTO resources_cms.approval_history(id,article_id,revision_id,approval_kind,decision,reviewer_id,verification,created_at)
   VALUES(gen_random_uuid(),withdrawn.article_id,withdrawn.revision_id,'knowledge','revoked',coalesce(resources_cms.actor(),withdrawn.reviewer_id),jsonb_build_object('reason','article_state_or_revision_changed'),now());
   INSERT INTO resources_cms.audit(actor_id,action,article_id,detail) VALUES(resources_cms.actor(),'knowledge_auto_revoke',NEW.id,jsonb_build_object('approvalId',withdrawn.approval_id,'revisionId',withdrawn.revision_id));
  END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION resources_cms.command(p_id uuid,p_version integer,p_action text,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE a resources_cms.articles; r resources_cms.revisions; actor uuid:=resources_cms.actor(); rid uuid; grantid uuid; target uuid; payload jsonb;
BEGIN
 IF actor IS NULL OR NOT resources_cms.has_role(ARRAY['owner','editor','reviewer']) THEN RAISE EXCEPTION 'CMS authorization denied'; END IF;
 IF p_action IN ('publish','unpublish','archive','delete','schedule','cancel-schedule') AND NOT resources_cms.has_role(ARRAY['owner']) THEN RAISE EXCEPTION 'Owner required'; END IF;
 IF p_action IN ('approve','knowledge-approve','knowledge-revoke') AND NOT resources_cms.has_role(ARRAY['owner','reviewer']) THEN RAISE EXCEPTION 'Reviewer required'; END IF;
 IF p_action IN ('create','save','restore','rollback','review','knowledge-submit') AND NOT resources_cms.has_role(ARRAY['owner','editor']) THEN RAISE EXCEPTION 'Editor required'; END IF;
 IF p_action='create' THEN
  IF p_version<>0 THEN RAISE EXCEPTION 'Create requires version zero'; END IF;
  INSERT INTO resources_cms.articles(id,slug,version) VALUES(p_id,p_payload->>'slug',0);
 END IF;
 SELECT * INTO a FROM resources_cms.articles WHERE id=p_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Article not found'; END IF;
 IF p_action<>'create' AND a.version<>p_version THEN RAISE EXCEPTION 'Revision conflict'; END IF;
 SELECT * INTO r FROM resources_cms.revisions WHERE id=a.working_revision_id;
 IF p_action IN ('create','save','rollback') THEN
  IF p_action<>'create' AND a.state IN ('scheduled','archived','deleted') THEN RAISE EXCEPTION 'Restore or cancel schedule first'; END IF;
  payload:=p_payload;
  IF p_action='rollback' THEN SELECT editable INTO payload FROM resources_cms.revisions WHERE article_id=p_id AND id=(p_payload->>'revisionId')::uuid; IF payload IS NULL THEN RAISE EXCEPTION 'Unknown revision'; END IF; END IF;
  IF length(coalesce(payload->>'title','')) NOT BETWEEN 1 AND 180 OR length(coalesce(payload->>'body',''))>200000 THEN RAISE EXCEPTION 'Invalid content'; END IF;
  IF NOT EXISTS(SELECT 1 FROM resources_cms.taxonomy WHERE id=(payload->>'categoryId')::uuid AND kind='category' AND NOT archived) THEN RAISE EXCEPTION 'Active category required'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(payload->'tagIds','[]')) x WHERE NOT EXISTS(SELECT 1 FROM resources_cms.taxonomy t WHERE t.id=x::uuid AND kind='tag' AND NOT archived)) THEN RAISE EXCEPTION 'Invalid tag'; END IF;
  IF (payload->>'slug') !~ '^[a-z0-9]+(-[a-z0-9]+)*$' THEN RAISE EXCEPTION 'Invalid slug'; END IF;
  IF EXISTS(SELECT 1 FROM resources_cms.redirects WHERE old_slug=payload->>'slug' AND article_id<>p_id) THEN RAISE EXCEPTION 'Reserved slug'; END IF;
  rid:=gen_random_uuid();
  INSERT INTO resources_cms.revisions(id,article_id,revision_number,editable,rendered_html,content_checksum,primary_category_id,tag_ids,sources,audience,created_by)
  VALUES(rid,p_id,a.version+1,payload,payload->>'body',encode(sha256(convert_to(payload::text,'UTF8')),'hex'),(payload->>'categoryId')::uuid,ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(coalesce(payload->'tagIds','[]'))),coalesce(payload->'sources','[]'),coalesce(payload->>'audience','homeowners'),actor);
  UPDATE resources_cms.articles SET working_revision_id=rid,state='draft' WHERE id=p_id;
 ELSIF p_action='review' AND a.state='draft' THEN UPDATE resources_cms.articles SET state='review' WHERE id=p_id;
 ELSIF p_action='approve' AND a.state='review' THEN
  IF coalesce(r.editable->>'summary','')='' OR coalesce(r.editable#>>'{seo,title}','')='' OR coalesce(r.editable#>>'{seo,description}','')='' OR jsonb_array_length(r.sources)=0 OR coalesce(r.rendered_html,'')='' THEN RAISE EXCEPTION 'Publication metadata missing'; END IF;
  IF coalesce(r.editable->>'featuredImage','')<>'' AND coalesce(r.editable->>'featuredImageAlt','')='' THEN RAISE EXCEPTION 'Featured image alt text missing'; END IF;
  IF EXISTS(SELECT 1 FROM regexp_matches(r.rendered_html,'<img\b[^>]*>','gi') image_tag WHERE image_tag[1] !~* '\salt="[^"]+"') THEN RAISE EXCEPTION 'Body image alt text missing'; END IF;
  IF EXISTS(SELECT 1 FROM regexp_matches(r.rendered_html,'href="/resources/([a-z0-9-]+)/?"','gi') link_slug WHERE NOT EXISTS(SELECT 1 FROM resources_cms.articles linked WHERE linked.slug=link_slug[1] AND linked.state='published') AND link_slug[1]<>r.editable->>'slug') THEN RAISE EXCEPTION 'Broken or unpublished internal resource link'; END IF;
  INSERT INTO resources_cms.approval_history VALUES(gen_random_uuid(),p_id,r.id,'publication','approved',actor,'{}',now());
  UPDATE resources_cms.articles SET state='approved' WHERE id=p_id;
 ELSIF p_action='publish' AND a.state='approved' THEN
  IF a.slug<>r.editable->>'slug' THEN INSERT INTO resources_cms.redirects(old_slug,article_id) VALUES(a.slug,p_id) ON CONFLICT DO NOTHING; END IF;
  UPDATE resources_cms.articles SET state='published',published_revision_id=working_revision_id,slug=r.editable->>'slug',scheduled_at=NULL,published_at=coalesce(published_at,now()) WHERE id=p_id;
 ELSIF p_action='schedule' AND a.state='approved' THEN
  IF (p_payload->>'scheduledAt')::timestamptz<=now() OR p_payload->>'scheduledAt' IS NULL THEN RAISE EXCEPTION 'Future date required'; END IF;
  UPDATE resources_cms.articles SET state='scheduled',scheduled_at=(p_payload->>'scheduledAt')::timestamptz WHERE id=p_id;
 ELSIF p_action='cancel-schedule' AND a.state='scheduled' THEN UPDATE resources_cms.articles SET state='approved',scheduled_at=NULL WHERE id=p_id;
 ELSIF p_action IN ('unpublish','archive','delete') THEN
  IF p_action='delete' AND a.state<>'archived' THEN RAISE EXCEPTION 'Archive first'; END IF;
  UPDATE resources_cms.articles SET state=CASE p_action WHEN 'archive' THEN 'archived' WHEN 'delete' THEN 'deleted' ELSE 'draft' END,published_revision_id=NULL,scheduled_at=NULL WHERE id=p_id;
 ELSIF p_action='restore' AND a.state IN ('archived','deleted') THEN UPDATE resources_cms.articles SET state='draft',published_revision_id=NULL WHERE id=p_id;
 ELSIF p_action='knowledge-submit' AND a.state='published' AND a.working_revision_id=a.published_revision_id THEN
  INSERT INTO resources_cms.approval_history VALUES(gen_random_uuid(),p_id,r.id,'knowledge','submitted',actor,'{}',now());
 ELSIF p_action='knowledge-revoke' THEN
  FOR target IN SELECT approval_id FROM resources_cms.knowledge_grants WHERE article_id=p_id AND active FOR UPDATE LOOP
   UPDATE resources_cms.knowledge_grants SET active=false WHERE approval_id=target;
   INSERT INTO resources_cms.outbox(approval_id,article_id,revision_id,event)
    SELECT approval_id,article_id,revision_id,'revoke' FROM resources_cms.knowledge_grants WHERE approval_id=target ON CONFLICT DO NOTHING;
   INSERT INTO resources_cms.approval_history(id,article_id,revision_id,approval_kind,decision,reviewer_id,verification,created_at)
    SELECT gen_random_uuid(),article_id,revision_id,'knowledge','revoked',actor,jsonb_build_object('reason',coalesce(p_payload->>'reason','manual_revocation')),now() FROM resources_cms.knowledge_grants WHERE approval_id=target;
  END LOOP;
 ELSIF p_action='knowledge-approve' THEN
  -- Technical classes deliberately remain disabled until evidence validation is implemented.
  IF a.state<>'published' OR a.working_revision_id<>a.published_revision_id OR p_payload->>'classification' NOT IN ('general_education','homeowner_safe_observation') OR p_payload->>'classification' IS NULL OR jsonb_array_length(coalesce(p_payload->'evidence','[]'))=0 THEN RAISE EXCEPTION 'Knowledge approval rejected'; END IF;
  IF NOT EXISTS(SELECT 1 FROM resources_cms.approval_history WHERE article_id=p_id AND revision_id=r.id AND approval_kind='knowledge' AND decision='submitted') THEN RAISE EXCEPTION 'Knowledge review required'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_payload->'evidence') e WHERE coalesce(e->>'excerpt','')='' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.sources) s WHERE s->>'url'=e->>'url')) THEN RAISE EXCEPTION 'Evidence must reference article sources'; END IF;
  grantid:=gen_random_uuid();INSERT INTO resources_cms.knowledge_grants(approval_id,article_id,revision_id,classification,verification_status,reviewer_id,evidence,active) VALUES(grantid,p_id,r.id,p_payload->>'classification','evidence_reviewed',actor,p_payload->'evidence',true);
  INSERT INTO resources_cms.outbox(approval_id,article_id,revision_id,event) VALUES(grantid,p_id,r.id,'upsert');
  INSERT INTO resources_cms.approval_history VALUES(gen_random_uuid(),p_id,r.id,'knowledge','approved',actor,p_payload,now());
 ELSE RAISE EXCEPTION 'Unsupported or invalid transition'; END IF;
 UPDATE resources_cms.articles SET version=version+1,updated_at=now() WHERE id=p_id RETURNING * INTO a;
 INSERT INTO resources_cms.audit(actor_id,action,article_id,detail) VALUES(actor,p_action,p_id,jsonb_build_object('version',a.version));
 RETURN to_jsonb(a);
END $$;
CREATE FUNCTION resources_cms.dispatch(p_command_id uuid,p_id uuid,p_version integer,p_action text,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=resources_cms.actor(); fp text; prior resources_cms.command_receipts; answer jsonb;
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'CMS authorization denied'; END IF;
 fp:=encode(sha256(convert_to(jsonb_build_array(p_id,p_version,p_action,coalesce(p_payload,'{}'))::text,'UTF8')),'hex');
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_command_id::text,0));
 SELECT * INTO prior FROM resources_cms.command_receipts WHERE command_id=p_command_id;
 IF FOUND THEN
  IF prior.actor_id<>actor OR prior.namespace<>'article' OR prior.target_id IS DISTINCT FROM p_id OR prior.fingerprint<>fp THEN RAISE EXCEPTION 'Idempotency key reuse rejected'; END IF;
  RETURN prior.result;
 END IF;
 answer:=resources_cms.command(p_id,p_version,p_action,coalesce(p_payload,'{}'));
 INSERT INTO resources_cms.command_receipts(command_id,actor_id,namespace,target_id,fingerprint,result) VALUES(p_command_id,actor,'article',p_id,fp,answer);
 RETURN answer;
END $$;
CREATE FUNCTION resources_cms.taxonomy_command(p_command_id uuid,p_version integer,p_action text,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=resources_cms.actor(); fp text; prior resources_cms.command_receipts; item resources_cms.taxonomy; source resources_cms.taxonomy; target resources_cms.taxonomy; withdrawn resources_cms.knowledge_grants; answer jsonb;
BEGIN
 IF actor IS NULL OR NOT resources_cms.has_role(ARRAY['owner','editor']) THEN RAISE EXCEPTION 'Editor required'; END IF;
 IF p_action IN ('archive','merge','restore') AND NOT resources_cms.has_role(ARRAY['owner']) THEN RAISE EXCEPTION 'Owner required'; END IF;
 fp:=encode(sha256(convert_to(jsonb_build_array(p_version,p_action,coalesce(p_payload,'{}'))::text,'UTF8')),'hex');
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_command_id::text,0));
 SELECT * INTO prior FROM resources_cms.command_receipts WHERE command_id=p_command_id;
 IF FOUND THEN IF prior.actor_id<>actor OR prior.namespace<>'taxonomy' OR prior.fingerprint<>fp THEN RAISE EXCEPTION 'Idempotency key reuse rejected'; END IF; RETURN prior.result; END IF;
 IF p_action='create' THEN
  IF p_version<>0 OR p_payload->>'kind' NOT IN ('category','tag') OR length(coalesce(p_payload->>'name','')) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'Invalid taxonomy create'; END IF;
  INSERT INTO resources_cms.taxonomy(kind,name,position) VALUES(p_payload->>'kind',p_payload->>'name',coalesce((p_payload->>'position')::int,0)) RETURNING * INTO item;
 ELSE
  SELECT * INTO item FROM resources_cms.taxonomy WHERE id=(p_payload->>'id')::uuid FOR UPDATE;
  IF NOT FOUND OR p_version<>item.version THEN RAISE EXCEPTION 'Taxonomy conflict'; END IF;
  IF p_action='rename' AND length(coalesce(p_payload->>'name','')) BETWEEN 1 AND 100 THEN UPDATE resources_cms.taxonomy SET name=p_payload->>'name',version=version+1 WHERE id=item.id RETURNING * INTO item;
  ELSIF p_action='reorder' THEN UPDATE resources_cms.taxonomy SET position=(p_payload->>'position')::int,version=version+1 WHERE id=item.id RETURNING * INTO item;
  ELSIF p_action='archive' THEN
   IF item.kind='category' AND EXISTS(SELECT 1 FROM resources_cms.articles a JOIN resources_cms.revisions r ON r.id=a.published_revision_id WHERE a.state='published' AND r.primary_category_id=item.id) THEN RAISE EXCEPTION 'Published category cannot be archived'; END IF;
   FOR withdrawn IN UPDATE resources_cms.knowledge_grants k SET active=false WHERE k.active AND EXISTS(SELECT 1 FROM resources_cms.revisions r WHERE r.id=k.revision_id AND (r.primary_category_id=item.id OR item.id=ANY(r.tag_ids))) RETURNING k.* LOOP
    INSERT INTO resources_cms.outbox(approval_id,article_id,revision_id,event) VALUES(withdrawn.approval_id,withdrawn.article_id,withdrawn.revision_id,'revoke') ON CONFLICT DO NOTHING;
    INSERT INTO resources_cms.approval_history VALUES(gen_random_uuid(),withdrawn.article_id,withdrawn.revision_id,'knowledge','revoked',actor,jsonb_build_object('reason','taxonomy_archived'),now());
   END LOOP;
   UPDATE resources_cms.taxonomy SET archived=true,version=version+1 WHERE id=item.id RETURNING * INTO item;
  ELSIF p_action='restore' THEN UPDATE resources_cms.taxonomy SET archived=false,version=version+1 WHERE id=item.id RETURNING * INTO item;
  ELSIF p_action='merge' THEN
   SELECT * INTO source FROM resources_cms.taxonomy WHERE id=item.id;
   SELECT * INTO target FROM resources_cms.taxonomy WHERE id=(p_payload->>'targetId')::uuid AND NOT archived FOR UPDATE;
   IF NOT FOUND OR source.archived OR source.kind<>target.kind THEN RAISE EXCEPTION 'Compatible active target required'; END IF;
   FOR withdrawn IN UPDATE resources_cms.knowledge_grants k SET active=false WHERE k.active AND EXISTS(SELECT 1 FROM resources_cms.revisions r WHERE r.id=k.revision_id AND (r.primary_category_id=source.id OR source.id=ANY(r.tag_ids))) RETURNING k.* LOOP
    INSERT INTO resources_cms.outbox(approval_id,article_id,revision_id,event) VALUES(withdrawn.approval_id,withdrawn.article_id,withdrawn.revision_id,'revoke') ON CONFLICT DO NOTHING;
    INSERT INTO resources_cms.approval_history VALUES(gen_random_uuid(),withdrawn.article_id,withdrawn.revision_id,'knowledge','revoked',actor,jsonb_build_object('reason','taxonomy_merged','targetId',target.id),now());
   END LOOP;
   INSERT INTO resources_cms.taxonomy_redirects(source_id,target_id,merged_by) VALUES(source.id,target.id,actor);
   UPDATE resources_cms.taxonomy SET archived=true,version=version+1 WHERE id=source.id RETURNING * INTO item;
  ELSE RAISE EXCEPTION 'Unsupported taxonomy action'; END IF;
 END IF;
 answer:=to_jsonb(item);
 INSERT INTO resources_cms.command_receipts(command_id,actor_id,namespace,target_id,fingerprint,result) VALUES(p_command_id,actor,'taxonomy',item.id,fp,answer);
 INSERT INTO resources_cms.audit(actor_id,action,detail) VALUES(actor,'taxonomy_'||p_action,jsonb_build_object('taxonomyId',item.id));
 RETURN answer;
END $$;
CREATE FUNCTION resources_cms.media_command(p_command_id uuid,p_action text,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=resources_cms.actor(); fp text; prior resources_cms.command_receipts; item resources_cms.media; answer jsonb;
BEGIN
 IF actor IS NULL OR NOT resources_cms.has_role(ARRAY['owner','editor']) THEN RAISE EXCEPTION 'Editor required'; END IF;
 fp:=encode(sha256(convert_to(jsonb_build_array(p_action,coalesce(p_payload,'{}'))::text,'UTF8')),'hex');
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_command_id::text,0));
 SELECT * INTO prior FROM resources_cms.command_receipts WHERE command_id=p_command_id;
 IF FOUND THEN IF prior.actor_id<>actor OR prior.namespace<>'media' OR prior.fingerprint<>fp THEN RAISE EXCEPTION 'Idempotency key reuse rejected'; END IF; RETURN prior.result; END IF;
 IF p_action='register' THEN
  IF p_payload->>'mime'<>'image/webp' OR (p_payload->>'sizeBytes')::bigint NOT BETWEEN 1 AND 4194304 OR (p_payload->>'objectKey') !~ '^images/[0-9a-f-]{36}\\.webp$' OR (p_payload->>'checksum') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'Invalid canonical media'; END IF;
  INSERT INTO resources_cms.media(id,name,mime,size_bytes,object_key,checksum,alt,created_by) VALUES((p_payload->>'id')::uuid,p_payload->>'name','image/webp',(p_payload->>'sizeBytes')::bigint,p_payload->>'objectKey',p_payload->>'checksum',coalesce(p_payload->>'alt',''),actor) RETURNING * INTO item;
 ELSIF p_action='archive' THEN
  IF EXISTS(SELECT 1 FROM resources_cms.articles a JOIN resources_cms.revisions r ON r.id=a.published_revision_id WHERE a.state='published' AND (r.rendered_html LIKE '%/media/'||(p_payload->>'id')||'%' OR r.editable->>'featuredImage'='/media/'||(p_payload->>'id') OR r.editable#>>'{seo,image}'='/media/'||(p_payload->>'id'))) THEN RAISE EXCEPTION 'Published media cannot be archived'; END IF;
  UPDATE resources_cms.media SET archived=true,updated_at=now() WHERE id=(p_payload->>'id')::uuid AND NOT archived RETURNING * INTO item;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active media not found'; END IF;
 ELSIF p_action='update-alt' THEN
  IF length(coalesce(p_payload->>'alt',''))>300 THEN RAISE EXCEPTION 'Invalid alt text'; END IF;
  UPDATE resources_cms.media SET alt=coalesce(p_payload->>'alt',''),updated_at=now() WHERE id=(p_payload->>'id')::uuid AND NOT archived RETURNING * INTO item;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active media not found'; END IF;
 ELSE RAISE EXCEPTION 'Unsupported media action'; END IF;
 answer:=to_jsonb(item);
 INSERT INTO resources_cms.command_receipts(command_id,actor_id,namespace,target_id,fingerprint,result) VALUES(p_command_id,actor,'media',item.id,fp,answer);
 INSERT INTO resources_cms.audit(actor_id,action,detail) VALUES(actor,'media_'||p_action,jsonb_build_object('mediaId',item.id));
 RETURN answer;
END $$;
INSERT INTO resources_cms.settings(id,data) VALUES(1,'{"defaultAudience":"homeowners","requireSources":true,"publicationTimezone":"America/New_York","integrationIssuer":"","indexNowEnabled":false}') ON CONFLICT(id) DO NOTHING;
CREATE FUNCTION resources_cms.settings_command(p_command_id uuid,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=resources_cms.actor(); fp text; prior resources_cms.command_receipts; answer jsonb;
BEGIN
 IF actor IS NULL OR NOT resources_cms.has_role(ARRAY['owner']) THEN RAISE EXCEPTION 'Owner required'; END IF;
 IF p_payload->>'defaultAudience' NOT IN ('homeowners','professionals','both') OR length(coalesce(p_payload->>'integrationIssuer',''))>500 THEN RAISE EXCEPTION 'Invalid settings'; END IF;
 fp:=encode(sha256(convert_to(coalesce(p_payload,'{}')::text,'UTF8')),'hex');
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_command_id::text,0));
 SELECT * INTO prior FROM resources_cms.command_receipts WHERE command_id=p_command_id;
 IF FOUND THEN IF prior.actor_id<>actor OR prior.namespace<>'settings' OR prior.fingerprint<>fp THEN RAISE EXCEPTION 'Idempotency key reuse rejected'; END IF; RETURN prior.result; END IF;
 UPDATE resources_cms.settings SET data=jsonb_build_object('defaultAudience',p_payload->>'defaultAudience','requireSources',true,'publicationTimezone','America/New_York','integrationIssuer',coalesce(p_payload->>'integrationIssuer',''),'indexNowEnabled',false) WHERE id=1 RETURNING data INTO answer;
 INSERT INTO resources_cms.command_receipts(command_id,actor_id,namespace,fingerprint,result) VALUES(p_command_id,actor,'settings',fp,answer);
 INSERT INTO resources_cms.audit(actor_id,action,detail) VALUES(actor,'settings_update','{}');
 RETURN answer;
END $$;
CREATE FUNCTION resources_cms.bulk_archive(p_command_id uuid,p_items jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=resources_cms.actor(); fp text; prior resources_cms.command_receipts; entry jsonb; item resources_cms.articles; answer jsonb:='[]';
BEGIN
 IF actor IS NULL OR NOT resources_cms.has_role(ARRAY['owner']) THEN RAISE EXCEPTION 'Owner required'; END IF;
 IF jsonb_typeof(p_items)<>'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'Invalid bulk selection'; END IF;
 fp:=encode(sha256(convert_to(p_items::text,'UTF8')),'hex');
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_command_id::text,0));
 SELECT * INTO prior FROM resources_cms.command_receipts WHERE command_id=p_command_id;
 IF FOUND THEN IF prior.actor_id<>actor OR prior.namespace<>'bulk_archive' OR prior.fingerprint<>fp THEN RAISE EXCEPTION 'Idempotency key reuse rejected'; END IF; RETURN prior.result; END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(p_items) LOOP
  SELECT * INTO item FROM resources_cms.articles WHERE id=(entry->>'id')::uuid FOR UPDATE;
  IF NOT FOUND OR item.version<>(entry->>'version')::integer OR item.state IN ('archived','deleted') THEN RAISE EXCEPTION 'Bulk archive conflict'; END IF;
  UPDATE resources_cms.articles SET state='archived',published_revision_id=NULL,scheduled_at=NULL,version=version+1,updated_at=now() WHERE id=item.id RETURNING * INTO item;
  INSERT INTO resources_cms.audit(actor_id,action,article_id,detail) VALUES(actor,'bulk_archive',item.id,jsonb_build_object('version',item.version));
  answer:=answer||to_jsonb(item);
 END LOOP;
 INSERT INTO resources_cms.command_receipts(command_id,actor_id,namespace,fingerprint,result) VALUES(p_command_id,actor,'bulk_archive',fp,answer);
 RETURN answer;
END $$;
CREATE FUNCTION resources_cms.publish_due(p_limit integer DEFAULT 100) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE item resources_cms.articles; published_ids uuid[]:='{}';
BEGIN
 -- Not exposed through the Data API. A separately approved Supabase Cron job
 -- may call this routine after the owner-authorized schedule transition.
 FOR item IN SELECT * FROM resources_cms.articles a
  WHERE a.state='scheduled' AND a.scheduled_at<=now() AND a.working_revision_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM resources_cms.approval_history h WHERE h.article_id=a.id AND h.revision_id=a.working_revision_id AND h.approval_kind='publication' AND h.decision='approved')
  ORDER BY a.scheduled_at,a.id LIMIT least(greatest(p_limit,1),100) FOR UPDATE SKIP LOCKED LOOP
  UPDATE resources_cms.articles SET state='published',published_revision_id=working_revision_id,scheduled_at=NULL,published_at=coalesce(published_at,now()),version=version+1,updated_at=now() WHERE id=item.id;
  INSERT INTO resources_cms.audit(actor_id,action,article_id,detail) VALUES(NULL,'scheduled_publish',item.id,jsonb_build_object('previousVersion',item.version,'executor','supabase_cron'));
  published_ids:=array_append(published_ids,item.id);
 END LOOP;
 RETURN jsonb_build_object('published',coalesce(array_length(published_ids,1),0),'articleIds',published_ids);
END $$;
CREATE FUNCTION resources_cms.public_article(p_slug text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('id',a.id,'slug',a.slug,'state',a.state,'version',a.version,'publishedAt',a.published_at,'updatedAt',a.updated_at,'revisionId',r.id,'content',r.editable,'renderedHtml',r.rendered_html,'sources',r.sources,'categoryId',coalesce(tr.target_id,r.primary_category_id),'categoryName',c.name,'tagIds',r.tag_ids,'audience',r.audience)
 FROM resources_cms.articles a JOIN resources_cms.revisions r ON r.id=a.published_revision_id
 LEFT JOIN resources_cms.taxonomy_redirects tr ON tr.source_id=r.primary_category_id
 LEFT JOIN resources_cms.taxonomy c ON c.id=coalesce(tr.target_id,r.primary_category_id)
 WHERE a.slug=p_slug AND a.state='published' AND a.published_revision_id IS NOT NULL
$$;
CREATE FUNCTION resources_cms.public_index() RETURNS TABLE(article_id uuid,slug text,published_at timestamptz,updated_at timestamptz,revision_id uuid,content jsonb,rendered_html text,category_id uuid,category_name text,tag_ids uuid[],tag_names text[],audience text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT a.id,a.slug,a.published_at,a.updated_at,r.id,r.editable,r.rendered_html,coalesce(tr.target_id,r.primary_category_id),c.name,
   ARRAY(SELECT coalesce(ttr.target_id,tag_id) FROM unnest(r.tag_ids) tag_id LEFT JOIN resources_cms.taxonomy_redirects ttr ON ttr.source_id=tag_id),
   ARRAY(SELECT tt.name FROM unnest(r.tag_ids) tag_id LEFT JOIN resources_cms.taxonomy_redirects ttr ON ttr.source_id=tag_id JOIN resources_cms.taxonomy tt ON tt.id=coalesce(ttr.target_id,tag_id)),r.audience
 FROM resources_cms.articles a JOIN resources_cms.revisions r ON r.id=a.published_revision_id
 LEFT JOIN resources_cms.taxonomy_redirects tr ON tr.source_id=r.primary_category_id
 LEFT JOIN resources_cms.taxonomy c ON c.id=coalesce(tr.target_id,r.primary_category_id)
 WHERE a.state='published' AND a.published_revision_id IS NOT NULL ORDER BY a.published_at DESC,a.id
$$;
CREATE FUNCTION resources_cms.public_media(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('id',m.id,'name',m.name,'mime',m.mime,'sizeBytes',m.size_bytes,'objectKey',m.object_key,'checksum',m.checksum,'alt',m.alt)
 FROM resources_cms.media m
 WHERE m.id=p_id AND NOT m.archived AND EXISTS(
  SELECT 1 FROM resources_cms.articles a JOIN resources_cms.revisions r ON r.id=a.published_revision_id
  WHERE a.state='published' AND a.published_revision_id IS NOT NULL
    AND (r.rendered_html LIKE '%/media/'||p_id::text||'%' OR r.editable->>'featuredImage'='/media/'||p_id::text OR r.editable#>>'{seo,image}'='/media/'||p_id::text)
 )
$$;
CREATE FUNCTION resources_cms.public_redirect(p_slug text) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT a.slug FROM resources_cms.redirects r JOIN resources_cms.articles a ON a.id=r.article_id
 WHERE r.old_slug=p_slug AND a.state='published' AND a.published_revision_id IS NOT NULL
$$;
-- One fixed, allowlisted read gateway keeps tables private from the Data API.
-- Every administrative branch rechecks immutable JWT identity against CMS membership.
CREATE FUNCTION resources_cms.query(p_operation text,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=resources_cms.actor(); member_role text; answer jsonb;
BEGIN
 IF actor IS NULL THEN RAISE EXCEPTION 'CMS authorization denied'; END IF;
 SELECT role INTO member_role FROM resources_cms.members WHERE user_id=actor AND active;
 IF member_role IS NULL THEN RAISE EXCEPTION 'CMS membership denied'; END IF;
 IF p_operation='member-role' THEN RETURN to_jsonb(member_role); END IF;
 IF p_operation='article-read' THEN
  SELECT to_jsonb(x) INTO answer FROM (
   SELECT a.*,r.editable,r.rendered_html,r.sources,r.tag_ids,r.primary_category_id,r.audience,
          (SELECT reason FROM resources_cms.editorial_holds h WHERE h.article_id=a.id) AS editorial_hold,
          r.created_by AS revision_created_by,r.created_at AS revision_created_at
   FROM resources_cms.articles a JOIN resources_cms.revisions r ON r.id=a.working_revision_id
   WHERE a.id=(p_payload->>'id')::uuid
  ) x;
 ELSIF p_operation='article-list' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO answer FROM (
   SELECT a.*,r.editable,r.primary_category_id,r.tag_ids,r.audience,
          (SELECT reason FROM resources_cms.editorial_holds h WHERE h.article_id=a.id) AS editorial_hold
   FROM resources_cms.articles a JOIN resources_cms.revisions r ON r.id=a.working_revision_id
   WHERE (nullif(p_payload->>'status','') IS NULL OR a.state=p_payload->>'status')
    AND (nullif(p_payload->>'categoryId','') IS NULL OR r.primary_category_id=(p_payload->>'categoryId')::uuid)
    AND (nullif(p_payload->>'tagId','') IS NULL OR (p_payload->>'tagId')::uuid=ANY(r.tag_ids))
    AND (coalesce(p_payload->>'query','')='' OR r.editable->>'title' ILIKE '%'||(p_payload->>'query')||'%' OR a.slug ILIKE '%'||(p_payload->>'query')||'%')
   ORDER BY a.updated_at DESC,a.id LIMIT least(greatest(coalesce((p_payload->>'limit')::int,100),1),200)
   OFFSET greatest(coalesce((p_payload->>'offset')::int,0),0)
  ) x;
 ELSIF p_operation='revision-list' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO answer FROM (
   SELECT id,revision_number AS version,editable AS data,created_by,created_at
   FROM resources_cms.revisions WHERE article_id=(p_payload->>'articleId')::uuid ORDER BY revision_number DESC
  ) x;
 ELSIF p_operation='taxonomy-list' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO answer FROM (SELECT id,kind,name,position,archived,version FROM resources_cms.taxonomy ORDER BY kind,position,name) x;
 ELSIF p_operation='media-read' THEN
  SELECT to_jsonb(x) INTO answer FROM (SELECT id,name,mime,size_bytes,object_key,checksum,alt,archived,created_at,updated_at FROM resources_cms.media WHERE id=(p_payload->>'id')::uuid AND NOT archived) x;
 ELSIF p_operation='media-list' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO answer FROM (SELECT id,name,mime,size_bytes AS size,object_key,checksum,alt,archived,created_at,updated_at FROM resources_cms.media WHERE NOT archived ORDER BY created_at DESC) x;
 ELSIF p_operation='settings-read' THEN
  SELECT data INTO answer FROM resources_cms.settings WHERE id=1;
 ELSIF p_operation='knowledge-statuses' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO answer FROM (
   SELECT a.id AS article_id,CASE WHEN k.active THEN 'approved' WHEN EXISTS(SELECT 1 FROM resources_cms.approval_history h WHERE h.article_id=a.id AND h.approval_kind='knowledge' AND h.decision='submitted') THEN 'submitted' ELSE 'not_submitted' END AS status,
          coalesce(k.classification,'unverified_hypothesis') AS classification,k.verification_status,k.reviewer_id,k.verified_at AS reviewed_at,k.revision_id
   FROM resources_cms.articles a LEFT JOIN resources_cms.knowledge_grants k ON k.article_id=a.id AND k.active ORDER BY a.id
  ) x;
 ELSIF p_operation='recent-audit' THEN
  SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]') INTO answer FROM (SELECT id,actor_id,action,article_id AS resource_id,detail,created_at FROM resources_cms.audit ORDER BY created_at DESC LIMIT least(greatest(coalesce((p_payload->>'limit')::int,25),1),100)) x;
 ELSIF p_operation='export-all' THEN
  IF member_role<>'owner' THEN RAISE EXCEPTION 'Owner required'; END IF;
  SELECT jsonb_build_object('format','resources-cms-postgres-v2','createdAt',now(),'mediaBytesIncluded',false,'data',jsonb_build_object(
   'members',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM resources_cms.members t),
   'taxonomy',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM resources_cms.taxonomy t),
   'articles',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM resources_cms.articles t),
   'revisions',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM resources_cms.revisions t),
   'approval_history',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM resources_cms.approval_history t),
   'knowledge_grants',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM resources_cms.knowledge_grants t),
   'outbox',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM resources_cms.outbox t),
   'redirects',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM resources_cms.redirects t),
   'media',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM resources_cms.media t),
   'audit',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM resources_cms.audit t),
   'settings',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM resources_cms.settings t),
   'taxonomy_redirects',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM resources_cms.taxonomy_redirects t),
   'command_receipts',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM resources_cms.command_receipts t),
   'editorial_holds',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM resources_cms.editorial_holds t),
   'publication_authorizations',(SELECT coalesce(jsonb_agg(to_jsonb(t)),'[]') FROM resources_cms.publication_authorizations t))) INTO answer;
 ELSIF p_operation='knowledge-export' THEN
  IF member_role<>'owner' THEN RAISE EXCEPTION 'Owner required'; END IF;
  SELECT jsonb_build_object('format','pooldocai-knowledge-export-v1','generatedAt',now(),'indexingConnected',false,'records',coalesce(jsonb_agg(to_jsonb(x)),'[]')) INTO answer FROM (
   SELECT a.id AS article_id,a.slug,r.id AS revision_id,r.revision_number,r.editable,r.rendered_html,r.content_checksum,r.sources,r.audience,g.approval_id,g.classification,g.verification_status,g.reviewer_id,g.verified_at,g.evidence,g.section_ids
   FROM resources_cms.knowledge_grants g JOIN resources_cms.articles a ON a.id=g.article_id JOIN resources_cms.revisions r ON r.id=g.revision_id
   WHERE g.active AND a.state='published' AND a.published_revision_id=g.revision_id ORDER BY a.id
  ) x;
 ELSE RAISE EXCEPTION 'Unsupported query operation'; END IF;
 RETURN coalesce(answer,'null'::jsonb);
END $$;
ALTER FUNCTION resources_cms.command(uuid,integer,text,jsonb) OWNER TO resources_cms_command_owner;
ALTER FUNCTION resources_cms.dispatch(uuid,uuid,integer,text,jsonb) OWNER TO resources_cms_command_owner;
ALTER FUNCTION resources_cms.taxonomy_command(uuid,integer,text,jsonb) OWNER TO resources_cms_command_owner;
ALTER FUNCTION resources_cms.media_command(uuid,text,jsonb) OWNER TO resources_cms_command_owner;
ALTER FUNCTION resources_cms.settings_command(uuid,jsonb) OWNER TO resources_cms_command_owner;
ALTER FUNCTION resources_cms.bulk_archive(uuid,jsonb) OWNER TO resources_cms_command_owner;
ALTER FUNCTION resources_cms.publish_due(integer) OWNER TO resources_cms_command_owner;
ALTER FUNCTION resources_cms.public_article(text) OWNER TO resources_cms_command_owner;
ALTER FUNCTION resources_cms.public_index() OWNER TO resources_cms_command_owner;
ALTER FUNCTION resources_cms.public_media(uuid) OWNER TO resources_cms_command_owner;
ALTER FUNCTION resources_cms.public_redirect(text) OWNER TO resources_cms_command_owner;
ALTER FUNCTION resources_cms.query(text,jsonb) OWNER TO resources_cms_command_owner;
REVOKE CREATE ON SCHEMA resources_cms FROM resources_cms_command_owner;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA resources_cms FROM PUBLIC,anon,authenticated,resources_cms_runtime;
GRANT EXECUTE ON FUNCTION resources_cms.dispatch(uuid,uuid,integer,text,jsonb),resources_cms.taxonomy_command(uuid,integer,text,jsonb),resources_cms.media_command(uuid,text,jsonb),resources_cms.settings_command(uuid,jsonb),resources_cms.bulk_archive(uuid,jsonb),resources_cms.query(text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION resources_cms.public_article(text),resources_cms.public_index(),resources_cms.public_media(uuid),resources_cms.public_redirect(text) TO anon,authenticated;
GRANT EXECUTE ON FUNCTION resources_cms.publish_due(integer) TO postgres;
GRANT EXECUTE ON FUNCTION resources_cms.actor(),resources_cms.has_role(text[]) TO resources_cms_command_owner;
-- Remove only the temporary row granted by postgres. The expected managed
-- supabase_admin ADMIN-only row remains.
REVOKE resources_cms_command_owner FROM postgres GRANTED BY postgres RESTRICT;
DO $guard$ BEGIN
 IF pg_has_role('postgres','resources_cms_command_owner','SET') OR pg_has_role('postgres','resources_cms_command_owner','USAGE') THEN RAISE EXCEPTION 'Temporary effective membership persists'; END IF;
 IF (SELECT count(*) FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member JOIN pg_roles g ON g.oid=a.grantor WHERE r.rolname='resources_cms_command_owner' AND m.rolname='postgres' AND g.rolname='supabase_admin' AND a.admin_option AND NOT a.inherit_option AND NOT a.set_option)<>1 OR (SELECT count(*) FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member WHERE r.rolname='resources_cms_command_owner' AND m.rolname='postgres')<>1 THEN RAISE EXCEPTION 'Unexpected final command-owner membership state'; END IF;
 IF has_schema_privilege('resources_cms_runtime','resources_cms','USAGE') THEN RAISE EXCEPTION 'Retired runtime still has CMS schema access'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='resources_cms_runtime' AND (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls)) THEN RAISE EXCEPTION 'Retired runtime role attributes are unsafe'; END IF;
 IF (SELECT count(*) FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member JOIN pg_roles g ON g.oid=a.grantor WHERE r.rolname='resources_cms_runtime')<>1
  OR (SELECT count(*) FROM pg_auth_members a JOIN pg_roles r ON r.oid=a.roleid JOIN pg_roles m ON m.oid=a.member JOIN pg_roles g ON g.oid=a.grantor WHERE r.rolname='resources_cms_runtime' AND m.rolname='postgres' AND g.rolname='supabase_admin' AND a.admin_option AND NOT a.inherit_option AND NOT a.set_option)<>1
 THEN RAISE EXCEPTION 'Unexpected retired runtime membership'; END IF;
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='resources_cms' AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege('resources_cms_runtime',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) THEN RAISE EXCEPTION 'Retired runtime still has CMS relation privileges'; END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='resources_cms' AND has_function_privilege('resources_cms_runtime',p.oid,'EXECUTE')) THEN RAISE EXCEPTION 'Retired runtime still has CMS function execution'; END IF;
 IF has_table_privilege('authenticated','resources_cms.articles','SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege('anon','resources_cms.articles','SELECT,INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'Data API role received direct CMS table access'; END IF;
 IF has_function_privilege('anon','resources_cms.dispatch(uuid,uuid,integer,text,jsonb)','EXECUTE') OR NOT has_function_privilege('authenticated','resources_cms.dispatch(uuid,uuid,integer,text,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Command RPC ACL mismatch'; END IF;
 IF NOT has_function_privilege('anon','resources_cms.public_article(text)','EXECUTE') OR NOT has_function_privilege('authenticated','resources_cms.query(text,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Read RPC ACL mismatch'; END IF;
END $guard$;
COMMIT;
