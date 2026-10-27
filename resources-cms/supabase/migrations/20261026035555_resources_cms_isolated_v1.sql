-- REVIEW CANDIDATE ONLY. Not applied to any Supabase project.
-- Run the generated migration against an authorized disposable Supabase environment first.
-- Deliberately no changes to public, auth, storage.objects, tenant policies, or core functions.
BEGIN;
CREATE SCHEMA resources_cms;
REVOKE ALL ON SCHEMA resources_cms FROM PUBLIC, anon, authenticated;
-- Provision a scoped LOGIN which inherits this role separately, with owner authorization.
CREATE ROLE resources_cms_runtime NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
GRANT USAGE ON SCHEMA resources_cms TO resources_cms_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA resources_cms REVOKE ALL ON TABLES FROM PUBLIC,anon,authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA resources_cms REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC,anon,authenticated;
CREATE TABLE resources_cms.members(user_id uuid PRIMARY KEY, role text NOT NULL CHECK(role IN ('owner','editor','reviewer','viewer')),active boolean NOT NULL DEFAULT true);
-- No FK to auth.users: no modifications or cascading dependencies in the core auth schema.
CREATE FUNCTION resources_cms.actor() RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$ SELECT nullif(current_setting('resources_cms.actor_id',true),'')::uuid $$;
CREATE FUNCTION resources_cms.has_role(roles text[]) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$ SELECT EXISTS(SELECT 1 FROM resources_cms.members WHERE user_id=resources_cms.actor() AND active AND role=ANY(roles)) $$;
CREATE TABLE resources_cms.taxonomy(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),kind text NOT NULL CHECK(kind IN ('category','tag')),name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),position int NOT NULL DEFAULT 0,archived boolean NOT NULL DEFAULT false,UNIQUE(kind,name));
CREATE TABLE resources_cms.articles(id uuid PRIMARY KEY,slug text NOT NULL UNIQUE CHECK(slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),state text NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','review','approved','scheduled','published','archived','deleted')),version int NOT NULL DEFAULT 1,working_revision_id uuid,published_revision_id uuid,scheduled_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE resources_cms.revisions(id uuid PRIMARY KEY,article_id uuid NOT NULL REFERENCES resources_cms.articles(id),revision_number int NOT NULL,editable jsonb NOT NULL,rendered_html text NOT NULL,content_checksum text NOT NULL,primary_category_id uuid NOT NULL REFERENCES resources_cms.taxonomy(id),tag_ids uuid[] NOT NULL DEFAULT '{}',sources jsonb NOT NULL DEFAULT '[]',audience text NOT NULL CHECK(audience IN ('homeowners','professionals','both')),created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(article_id,revision_number),UNIQUE(article_id,id));
ALTER TABLE resources_cms.articles ADD CONSTRAINT cms_working_revision FOREIGN KEY(id,working_revision_id) REFERENCES resources_cms.revisions(article_id,id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE resources_cms.articles ADD CONSTRAINT cms_public_revision FOREIGN KEY(id,published_revision_id) REFERENCES resources_cms.revisions(article_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE resources_cms.approval_history(id uuid PRIMARY KEY,article_id uuid NOT NULL REFERENCES resources_cms.articles(id),revision_id uuid NOT NULL,approval_kind text NOT NULL CHECK(approval_kind IN ('publication','knowledge')),decision text NOT NULL CHECK(decision IN ('submitted','approved','revoked')),reviewer_id uuid NOT NULL,verification jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(article_id,revision_id) REFERENCES resources_cms.revisions(article_id,id));
CREATE TABLE resources_cms.knowledge_grants(approval_id uuid PRIMARY KEY,article_id uuid NOT NULL REFERENCES resources_cms.articles(id),revision_id uuid NOT NULL,classification text NOT NULL CHECK(classification IN ('general_education','homeowner_safe_observation','manufacturer_supported_diagnostic','technician_reviewed_diagnostic','verified_repair_procedure','unverified_hypothesis')),verification_status text NOT NULL,reviewer_id uuid NOT NULL,verified_at timestamptz NOT NULL DEFAULT now(),evidence jsonb NOT NULL,section_ids text[] NOT NULL DEFAULT '{}',active boolean NOT NULL DEFAULT false,FOREIGN KEY(article_id,revision_id) REFERENCES resources_cms.revisions(article_id,id),CHECK(NOT active OR classification <> 'unverified_hypothesis'));
CREATE UNIQUE INDEX cms_one_active_grant ON resources_cms.knowledge_grants(article_id) WHERE active;
CREATE TABLE resources_cms.outbox(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),approval_id uuid NOT NULL REFERENCES resources_cms.knowledge_grants(approval_id),article_id uuid NOT NULL REFERENCES resources_cms.articles(id),revision_id uuid NOT NULL,event text NOT NULL CHECK(event IN ('upsert','revoke')),state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','failed','acknowledged')),error text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(approval_id,event));
CREATE TABLE resources_cms.redirects(old_slug text PRIMARY KEY,article_id uuid NOT NULL REFERENCES resources_cms.articles(id),created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE resources_cms.media(id uuid PRIMARY KEY,name text NOT NULL,mime text NOT NULL,size_bytes bigint NOT NULL CHECK(size_bytes BETWEEN 1 AND 10485760),object_key text UNIQUE NOT NULL,checksum text NOT NULL,alt text NOT NULL DEFAULT '',created_by uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE resources_cms.audit(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid,action text NOT NULL,article_id uuid,detail jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE resources_cms.settings(id int PRIMARY KEY CHECK(id=1),data jsonb NOT NULL);
-- Membership lookup itself is scoped to the authenticated actor, avoiding policy recursion.
ALTER TABLE resources_cms.members ENABLE ROW LEVEL SECURITY;
CREATE POLICY cms_member_self ON resources_cms.members FOR SELECT TO resources_cms_runtime USING(user_id=resources_cms.actor() AND active);
GRANT SELECT ON resources_cms.members TO resources_cms_runtime;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['taxonomy','articles','revisions','approval_history','knowledge_grants','outbox','redirects','media','audit','settings'] LOOP
 EXECUTE format('ALTER TABLE resources_cms.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('CREATE POLICY cms_read ON resources_cms.%I FOR SELECT TO resources_cms_runtime USING(resources_cms.has_role(ARRAY[''owner'',''editor'',''reviewer'',''viewer'']))',t);
 END LOOP;
END $$;
-- Fail closed first phase: no runtime writes. Add reviewed command procedures and role-specific
-- write policies as a SEPARATE migration after testing the complete Supabase adapter.
GRANT SELECT ON ALL TABLES IN SCHEMA resources_cms TO resources_cms_runtime;
GRANT EXECUTE ON FUNCTION resources_cms.actor(),resources_cms.has_role(text[]) TO resources_cms_runtime;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA resources_cms FROM PUBLIC,anon,authenticated;
CREATE FUNCTION resources_cms.immutable_record() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$ BEGIN RAISE EXCEPTION 'CMS historical records are immutable'; END $$;
CREATE TRIGGER cms_revision_immutable BEFORE UPDATE OR DELETE ON resources_cms.revisions FOR EACH ROW EXECUTE FUNCTION resources_cms.immutable_record();
CREATE TRIGGER cms_approval_immutable BEFORE UPDATE OR DELETE ON resources_cms.approval_history FOR EACH ROW EXECUTE FUNCTION resources_cms.immutable_record();
CREATE TRIGGER cms_audit_immutable BEFORE UPDATE OR DELETE ON resources_cms.audit FOR EACH ROW EXECUTE FUNCTION resources_cms.immutable_record();
CREATE FUNCTION resources_cms.revoke_on_article_change() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
 IF OLD.working_revision_id IS DISTINCT FROM NEW.working_revision_id OR NEW.state IN ('archived','deleted') OR OLD.published_revision_id IS DISTINCT FROM NEW.published_revision_id THEN
 WITH withdrawn AS (UPDATE resources_cms.knowledge_grants SET active=false WHERE article_id=NEW.id AND active RETURNING *)
 INSERT INTO resources_cms.outbox(approval_id,article_id,revision_id,event) SELECT approval_id,article_id,revision_id,'revoke' FROM withdrawn ON CONFLICT(approval_id,event) DO NOTHING;
 END IF; RETURN NEW;
END $$;
CREATE TRIGGER cms_withdraw_changed_content BEFORE UPDATE ON resources_cms.articles FOR EACH ROW EXECUTE FUNCTION resources_cms.revoke_on_article_change();
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA resources_cms FROM PUBLIC,anon,authenticated;
COMMIT;
