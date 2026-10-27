-- Versioned proposal, NOT applied. Independent of Gate 3B. No seed/content inserts.
-- PostgreSQL 17; requires committed commands-v2 Auth architecture. Rehearsal defaults to ROLLBACK.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
DO $$ BEGIN
 IF to_regprocedure('resources_cms.actor()') IS NULL OR to_regrole('resources_cms_command_owner') IS NULL OR to_regclass('resources_cms.navigation_versions') IS NOT NULL THEN RAISE EXCEPTION 'Unexpected folder migration baseline'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='resources_cms_command_owner' AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit)) THEN RAISE EXCEPTION 'Unsafe command-owner attributes'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid='resources_cms_command_owner'::regrole AND (inherit_option OR set_option)) THEN RAISE EXCEPTION 'Unexpected effective owner membership'; END IF;
END $$;
-- This grantor-specific temporary row must be independently authorized, verified,
-- and absent after commit. Does NOT attempt to revoke supabase_admin's managed row.
GRANT resources_cms_command_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
GRANT CREATE ON SCHEMA resources_cms TO resources_cms_command_owner;
CREATE TABLE resources_cms.navigation_versions(version integer PRIMARY KEY CHECK(version>0),document jsonb NOT NULL,checksum text NOT NULL,actor_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE resources_cms.navigation_state(id integer PRIMARY KEY CHECK(id=1),version integer NOT NULL DEFAULT 0,published_version integer REFERENCES resources_cms.navigation_versions(version),redirects jsonb NOT NULL DEFAULT '[]');
CREATE TABLE resources_cms.navigation_receipts(command_id uuid PRIMARY KEY,actor_id uuid NOT NULL,fingerprint text NOT NULL,result jsonb NOT NULL);
INSERT INTO resources_cms.navigation_state(id) VALUES(1);
ALTER TABLE resources_cms.navigation_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources_cms.navigation_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources_cms.navigation_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON resources_cms.navigation_versions,resources_cms.navigation_state,resources_cms.navigation_receipts FROM PUBLIC,anon,authenticated,service_role,resources_cms_runtime;
GRANT SELECT,INSERT ON resources_cms.navigation_versions,resources_cms.navigation_receipts TO resources_cms_command_owner;
GRANT SELECT,UPDATE ON resources_cms.navigation_state TO resources_cms_command_owner;
CREATE POLICY navigation_versions_internal ON resources_cms.navigation_versions TO resources_cms_command_owner USING(true) WITH CHECK(true);
CREATE POLICY navigation_state_internal ON resources_cms.navigation_state TO resources_cms_command_owner USING(true) WITH CHECK(true);
CREATE POLICY navigation_receipts_internal ON resources_cms.navigation_receipts TO resources_cms_command_owner USING(true) WITH CHECK(true);
CREATE FUNCTION resources_cms.navigation_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$ BEGIN RAISE EXCEPTION 'Immutable navigation revision'; END $$;
CREATE TRIGGER navigation_immutable BEFORE UPDATE OR DELETE ON resources_cms.navigation_versions FOR EACH ROW EXECUTE FUNCTION resources_cms.navigation_immutable();
CREATE FUNCTION resources_cms.navigation_validate(d jsonb,previous jsonb DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE f jsonb; m jsonb; p jsonb; parent text; seen text[]; depth integer;
BEGIN
 IF d IS NULL OR d->>'format' IS DISTINCT FROM 'pooldocai-navigation-v1' OR jsonb_typeof(d->'folders') IS DISTINCT FROM 'array' OR jsonb_typeof(d->'memberships') IS DISTINCT FROM 'array' OR jsonb_typeof(d->'paths') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Complete navigation document required'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(d) k WHERE k NOT IN('format','paths','folders','memberships')) OR jsonb_array_length(d->'paths')<>3 OR (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(d->'paths') x)<>3 OR EXISTS(SELECT 1 FROM jsonb_array_elements(d->'paths') x WHERE x->>'id' NOT IN('whats-wrong','equipment-and-guides','explore-resources') OR length(coalesce(x->>'name','')) NOT BETWEEN 2 AND 80 OR EXISTS(SELECT 1 FROM jsonb_object_keys(x) k WHERE k NOT IN('id','name'))) THEN RAISE EXCEPTION 'Three valid discovery paths required'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(d->'folders'))<>(SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(d->'folders') x) OR EXISTS(SELECT 1 FROM jsonb_array_elements(d->'folders') x GROUP BY x->>'pathId',coalesce(x->>'parentId',''),x->>'slug' HAVING count(*)>1) THEN RAISE EXCEPTION 'Duplicate folder identity or sibling path'; END IF;
 FOR f IN SELECT value FROM jsonb_array_elements(d->'folders') LOOP
  IF (f->>'id')::uuid IS NULL OR jsonb_typeof(f->'name') IS DISTINCT FROM 'string' OR jsonb_typeof(f->'slug') IS DISTINCT FROM 'string' OR length(coalesce(f->>'name','')) NOT BETWEEN 2 AND 120 OR length(coalesce(f->>'slug','')) NOT BETWEEN 1 AND 100 OR f->>'slug' !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR jsonb_typeof(f->'description') IS DISTINCT FROM 'string' OR length(f->>'description')>1000 OR jsonb_typeof(f->'icon') IS DISTINCT FROM 'string' OR length(f->>'icon')>8 OR coalesce(f->>'pathId','') NOT IN('whats-wrong','equipment-and-guides','explore-resources') OR coalesce((f->>'position')::numeric,-1)<0 OR (f->>'position')::numeric<>trunc((f->>'position')::numeric) OR jsonb_typeof(f->'archived') IS DISTINCT FROM 'boolean' OR jsonb_typeof(f->'visibility') IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(f->'visibility'))<>3 OR jsonb_typeof(f#>'{visibility,hub}') IS DISTINCT FROM 'boolean' OR jsonb_typeof(f#>'{visibility,header}') IS DISTINCT FROM 'boolean' OR jsonb_typeof(f#>'{visibility,assistant}') IS DISTINCT FROM 'boolean' OR EXISTS(SELECT 1 FROM jsonb_object_keys(f) k WHERE k NOT IN('id','name','slug','description','icon','parentId','pathId','position','archived','visibility')) THEN RAISE EXCEPTION 'Invalid folder fields'; END IF;
  parent:=nullif(f->>'parentId','');seen:=ARRAY[f->>'id'];depth:=1;
  WHILE parent IS NOT NULL LOOP
   SELECT value INTO p FROM jsonb_array_elements(d->'folders') WHERE value->>'id'=parent;
   IF p IS NULL OR parent=ANY(seen) OR p->>'pathId'<>f->>'pathId' THEN RAISE EXCEPTION 'Circular, missing or incompatible parent'; END IF;
   depth:=depth+1;IF depth>8 THEN RAISE EXCEPTION 'Navigation exceeds eight levels'; END IF;seen:=array_append(seen,parent);parent:=nullif(p->>'parentId','');
  END LOOP;
  IF (f->>'archived')::boolean AND (EXISTS(SELECT 1 FROM jsonb_array_elements(d->'folders') c WHERE c->>'parentId'=f->>'id' AND NOT(c->>'archived')::boolean) OR EXISTS(SELECT 1 FROM jsonb_array_elements(d->'memberships') assigned WHERE assigned->'folderIds' ? (f->>'id'))) THEN RAISE EXCEPTION 'Reassign articles and children before archiving'; END IF;
 END LOOP;
 IF previous IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(previous->'folders') o WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'folders') n WHERE n->>'id'=o->>'id')) THEN RAISE EXCEPTION 'Archive folders instead of deleting stable identities'; END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(d->'memberships'))<>(SELECT count(DISTINCT x->>'articleId') FROM jsonb_array_elements(d->'memberships') x) THEN RAISE EXCEPTION 'Duplicate article assignment'; END IF;
 FOR m IN SELECT value FROM jsonb_array_elements(d->'memberships') LOOP
  IF NOT EXISTS(SELECT 1 FROM resources_cms.articles WHERE id=(m->>'articleId')::uuid) OR jsonb_typeof(m->'folderIds') IS DISTINCT FROM 'array' OR NOT(m->'folderIds' ? coalesce(m->>'primaryFolderId','')) OR (SELECT count(*) FROM jsonb_array_elements(m->'folderIds'))<>(SELECT count(DISTINCT x) FROM jsonb_array_elements(m->'folderIds') x) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(m->'folderIds') id WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'folders') active_folder WHERE active_folder->>'id'=id AND NOT(active_folder->>'archived')::boolean)) OR EXISTS(SELECT 1 FROM jsonb_object_keys(m) k WHERE k NOT IN('articleId','folderIds','primaryFolderId')) THEN RAISE EXCEPTION 'Valid article and active primary folder required'; END IF;
 END LOOP;
END $$;
CREATE FUNCTION resources_cms.navigation_query() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s resources_cms.navigation_state; v resources_cms.navigation_versions;
BEGIN
 IF NOT resources_cms.has_role(ARRAY['owner','editor','reviewer','viewer']) THEN RAISE EXCEPTION 'CMS membership required' USING ERRCODE='42501'; END IF;
 SELECT * INTO s FROM resources_cms.navigation_state WHERE id=1;SELECT * INTO v FROM resources_cms.navigation_versions WHERE version=s.version;
 RETURN jsonb_build_object('version',s.version,'publishedVersion',s.published_version,'document',v.document,'checksum',v.checksum,'redirects',s.redirects,'history',(SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY version DESC),'[]') FROM resources_cms.navigation_versions r));
END $$;
-- Only the published version is exposed. Memberships are projected on the server
-- against the separately verified public catalog; anonymous callers never receive
-- raw article IDs or hidden folders from the draft/published configuration.
-- This private RPC has no anonymous EXECUTE. Public gateway uses navigation_public.
CREATE FUNCTION resources_cms.navigation_public(p_surface text DEFAULT 'hub') RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE d jsonb; catalog jsonb; folders jsonb; members jsonb; raw_members jsonb; s resources_cms.navigation_state;
BEGIN
 IF p_surface NOT IN('hub','header','assistant') THEN RAISE EXCEPTION 'Unknown navigation surface'; END IF;
 SELECT * INTO s FROM resources_cms.navigation_state WHERE id=1;SELECT document INTO d FROM resources_cms.navigation_versions WHERE version=s.published_version;
 IF d IS NULL OR to_regprocedure('resources_cms.verified_public_catalog()') IS NULL THEN RETURN NULL; END IF;
 catalog:=resources_cms.verified_public_catalog();
 SELECT coalesce(jsonb_agg(m),'[]') INTO raw_members FROM jsonb_array_elements(d->'memberships') m WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(catalog) c WHERE c->>'id'=m->>'articleId');
 WITH RECURSIVE tree AS(
 SELECT f,ARRAY[f->>'id'] ids FROM jsonb_array_elements(d->'folders') f WHERE nullif(f->>'parentId','') IS NULL AND NOT(f->>'archived')::boolean AND (f->'visibility'->>p_surface)::boolean
 UNION ALL SELECT f,t.ids||(f->>'id') FROM tree t CROSS JOIN jsonb_array_elements(d->'folders') f WHERE f->>'parentId'=t.f->>'id' AND NOT(f->>'archived')::boolean AND (f->'visibility'->>p_surface)::boolean
 ), used AS(SELECT DISTINCT unnest(ids) id FROM tree WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(raw_members) m WHERE m->'folderIds' ? (f->>'id')))
 SELECT coalesce(jsonb_agg(f),'[]') INTO folders FROM jsonb_array_elements(d->'folders') f WHERE f->>'id' IN(SELECT id FROM used);
 SELECT coalesce(jsonb_agg(m||jsonb_build_object('folderIds',ids,'primaryFolderId',CASE WHEN ids ? (m->>'primaryFolderId') THEN m->>'primaryFolderId' END)),'[]') INTO members FROM (SELECT m,(SELECT coalesce(jsonb_agg(id),'[]') FROM jsonb_array_elements(m->'folderIds') id WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(folders) f WHERE f->'id'=id)) ids FROM jsonb_array_elements(raw_members) m) projected WHERE jsonb_array_length(ids)>0;
 RETURN jsonb_build_object('version',s.published_version,'document',jsonb_build_object('format',d->'format','paths',d->'paths','folders',folders,'memberships',members),'redirects',(SELECT coalesce(jsonb_agg(r),'[]') FROM jsonb_array_elements(s.redirects) r WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(folders) f WHERE f->>'id'=r->>'folderId')));
END $$;
CREATE FUNCTION resources_cms.navigation_command(p_command jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=resources_cms.actor(); s resources_cms.navigation_state; v resources_cms.navigation_versions; prior jsonb; d jsonb; result jsonb; fingerprint text:=md5(p_command::text); receipt resources_cms.navigation_receipts; op text:=p_command->>'action'; redirect_list jsonb; before_path text; after_path text; folder jsonb; part jsonb; p text;
BEGIN
 IF actor IS NULL OR NOT resources_cms.has_role(ARRAY['owner']) THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='42501'; END IF;
 IF octet_length(p_command::text)>262144 OR (p_command->>'commandId')::uuid IS NULL THEN RAISE EXCEPTION 'Bounded command with UUID required'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('resources_cms.navigation',0));
 SELECT * INTO receipt FROM resources_cms.navigation_receipts WHERE command_id=(p_command->>'commandId')::uuid;
 IF FOUND THEN IF receipt.actor_id<>actor OR receipt.fingerprint<>fingerprint THEN RAISE EXCEPTION 'Command replay differs'; END IF;RETURN receipt.result; END IF;
 SELECT * INTO s FROM resources_cms.navigation_state WHERE id=1 FOR UPDATE;
 IF (p_command->>'expectedVersion')::integer IS DISTINCT FROM s.version THEN RAISE EXCEPTION 'Navigation version conflict' USING ERRCODE='40001'; END IF;
 SELECT * INTO v FROM resources_cms.navigation_versions WHERE version=s.version;
 SELECT document INTO prior FROM resources_cms.navigation_versions WHERE version=s.published_version;
 IF op IN('save','restore') THEN
  IF op='restore' THEN SELECT document INTO d FROM resources_cms.navigation_versions WHERE version=(p_command->>'restoreVersion')::int;IF d IS NOT NULL THEN d:=jsonb_set(d,'{folders}',(d->'folders')||coalesce((SELECT jsonb_agg(f||jsonb_build_object('archived',true)) FROM jsonb_array_elements(v.document->'folders') f WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(d->'folders') old WHERE old->>'id'=f->>'id')),'[]'));END IF;ELSE d:=p_command->'document';END IF;
  PERFORM resources_cms.navigation_validate(d,v.document);
  INSERT INTO resources_cms.navigation_versions(version,document,checksum,actor_id) VALUES(s.version+1,d,encode(sha256(convert_to(d::text,'UTF8')),'hex'),actor);
  UPDATE resources_cms.navigation_state SET version=s.version+1 WHERE id=1;
  result:=jsonb_build_object('version',s.version+1,'publishedVersion',s.published_version);
 ELSIF op='publish' THEN
  IF s.version=0 OR p_command->>'approval' IS DISTINCT FROM 'PUBLISH NAVIGATION' OR p_command->>'checksum' IS DISTINCT FROM v.checksum THEN RAISE EXCEPTION 'Exact navigation revision approval required' USING ERRCODE='42501'; END IF;
  redirect_list:=s.redirects;
  FOR folder IN SELECT value FROM jsonb_array_elements(coalesce(prior->'folders','[]')) LOOP
   before_path:=resources_cms.navigation_path(prior,folder->>'id');after_path:=resources_cms.navigation_path(v.document,folder->>'id');
   IF after_path IS NOT NULL AND before_path<>after_path THEN redirect_list:=redirect_list||jsonb_build_array(jsonb_build_object('from',before_path,'folderId',folder->>'id'));END IF;
  END LOOP;
  SELECT coalesce(jsonb_agg(x),'[]') INTO redirect_list FROM(SELECT DISTINCT ON(value->>'from') value x FROM jsonb_array_elements(redirect_list) WHERE value->>'from' IS DISTINCT FROM resources_cms.navigation_path(v.document,value->>'folderId')) r;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(redirect_list) r CROSS JOIN jsonb_array_elements(v.document->'folders') f WHERE r->>'from'=resources_cms.navigation_path(v.document,f->>'id') AND r->>'folderId'<>f->>'id') THEN RAISE EXCEPTION 'Former folder path is reserved'; END IF;
  UPDATE resources_cms.navigation_state SET published_version=s.version,redirects=redirect_list WHERE id=1;
  result:=jsonb_build_object('version',s.version,'publishedVersion',s.version);
 ELSE RAISE EXCEPTION 'Unsupported navigation action'; END IF;
 INSERT INTO resources_cms.navigation_receipts VALUES((p_command->>'commandId')::uuid,actor,fingerprint,result);
 INSERT INTO resources_cms.audit(actor_id,action,detail) VALUES(actor,'navigation_'||op,result);
 RETURN result;
END $$;
CREATE FUNCTION resources_cms.navigation_path(d jsonb,id text) RETURNS text LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path='' AS $$
DECLARE f jsonb; result text; p text;
BEGIN SELECT value INTO f FROM jsonb_array_elements(d->'folders') WHERE value->>'id'=id;IF f IS NULL THEN RETURN NULL; END IF;result:=f->>'slug';p:=nullif(f->>'parentId','');WHILE p IS NOT NULL LOOP SELECT value INTO f FROM jsonb_array_elements(d->'folders') WHERE value->>'id'=p;result:=f->>'slug'||'/'||result;p:=nullif(f->>'parentId','');END LOOP;RETURN '/resources/collections/'||(f->>'pathId')||'/'||result||'/';END $$;
ALTER FUNCTION resources_cms.navigation_immutable() OWNER TO resources_cms_command_owner;
ALTER FUNCTION resources_cms.navigation_validate(jsonb,jsonb) OWNER TO resources_cms_command_owner;
ALTER FUNCTION resources_cms.navigation_query() OWNER TO resources_cms_command_owner;
ALTER FUNCTION resources_cms.navigation_public(text) OWNER TO resources_cms_command_owner;
ALTER FUNCTION resources_cms.navigation_command(jsonb) OWNER TO resources_cms_command_owner;
ALTER FUNCTION resources_cms.navigation_path(jsonb,text) OWNER TO resources_cms_command_owner;
REVOKE ALL ON FUNCTION resources_cms.navigation_immutable(),resources_cms.navigation_validate(jsonb,jsonb),resources_cms.navigation_query(),resources_cms.navigation_public(text),resources_cms.navigation_command(jsonb),resources_cms.navigation_path(jsonb,text) FROM PUBLIC,anon,authenticated,service_role,resources_cms_runtime;
GRANT EXECUTE ON FUNCTION resources_cms.navigation_query(),resources_cms.navigation_command(jsonb) TO authenticated;
-- Only the surface-specific, published and non-empty projection is public.
GRANT EXECUTE ON FUNCTION resources_cms.navigation_public(text) TO anon,authenticated;
REVOKE CREATE ON SCHEMA resources_cms FROM resources_cms_command_owner;
REVOKE resources_cms_command_owner FROM postgres GRANTED BY postgres RESTRICT;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid='resources_cms_command_owner'::regrole AND (inherit_option OR set_option)) THEN RAISE EXCEPTION 'Temporary privilege remains'; END IF; END $$;
ROLLBACK;
