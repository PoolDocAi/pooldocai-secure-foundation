-- ARCHIVED EXACT SQL USED IN THE APPROVED STAGING-ONLY SUPABASE apply_migration OPERATION.
-- Target project: rzkgmvyyeclrpomrlyft (PoolDocAI Staging); NEVER auto-apply to Production.
-- Supabase migration version: 20261029163440; name: resources_cms_staging_topic_queue_pg17.
-- Approved by owner for committed Staging migration only on 2026-10-29.
-- Reviewed candidate blob: 5a5e8cf379fad1479b7a4f19b776d2ad8a056285.
-- Reviewed PG17 assembler blob: 4d9ce3f10471dfed6df09d341e3ec3a4bc764914.
-- Preflight ROLLBACK rehearsal passed on the exact Staging project.
-- Do NOT place this file in automatically applied shared migrations or replay it.
-- Do NOT enable CMS_TOPIC_GENERATION_ENABLED or publish held articles by implication.

-- REVIEW/STAGING CANDIDATE ONLY. Not automatically applied; Production untouched.
-- This is a new private queue, separate from held owner-approved manuscripts.
-- Supabase apply_migration executes the migration transactionally; explicit BEGIN omitted.

-- Guard must execute before first schema change, inside BEGIN.
DO $topic_preflight$ BEGIN
 IF current_user<>'postgres' OR
    (SELECT rolsuper FROM pg_roles WHERE rolname=current_user) IS DISTINCT FROM false OR
    current_setting('server_version_num')::int<170000
 THEN RAISE EXCEPTION 'Expected non-superuser postgres on PostgreSQL 17+'; END IF;
 IF to_regclass('resources_cms.articles') IS NULL OR
    to_regclass('resources_cms.topic_queue') IS NOT NULL OR
    to_regclass('resources_cms.topic_generation_gate') IS NOT NULL OR
    to_regclass('resources_cms.topic_generation_attempts') IS NOT NULL OR
    to_regprocedure('resources_cms.topic_queue_list()') IS NOT NULL OR
    to_regprocedure('resources_cms.topic_queue_command(text,uuid,integer,jsonb)') IS NOT NULL
 THEN RAISE EXCEPTION 'Topic migration is not a clean Staging install'; END IF;
 IF (SELECT count(*) FROM pg_auth_members a
       JOIN pg_roles r ON r.oid=a.roleid
       JOIN pg_roles m ON m.oid=a.member
       JOIN pg_roles g ON g.oid=a.grantor
       WHERE r.rolname='resources_cms_command_owner' AND m.rolname='postgres'
         AND g.rolname='supabase_admin' AND a.admin_option
         AND NOT a.inherit_option AND NOT a.set_option)<>1
    OR (SELECT count(*) FROM pg_auth_members a
       JOIN pg_roles r ON r.oid=a.roleid
       JOIN pg_roles m ON m.oid=a.member
       WHERE r.rolname='resources_cms_command_owner' AND m.rolname='postgres')<>1
    OR pg_has_role('postgres','resources_cms_command_owner','SET')
    OR pg_has_role('postgres','resources_cms_command_owner','USAGE')
 THEN RAISE EXCEPTION 'Unexpected managed command-owner membership'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='resources_cms_command_owner'
    AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls))
    OR NOT has_schema_privilege('resources_cms_command_owner','resources_cms','USAGE')
    OR has_schema_privilege('resources_cms_command_owner','resources_cms','CREATE')
    OR NOT has_schema_privilege('postgres','resources_cms','CREATE')
 THEN RAISE EXCEPTION 'Unsafe schema or command-owner permissions'; END IF;
END $topic_preflight$;

-- PG17 grantor-specific SET membership, copied from reviewed CMS v2 strategy.
GRANT resources_cms_command_owner TO postgres
 WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
DO $topic_temp$ BEGIN
 IF (SELECT count(*) FROM pg_auth_members a
   JOIN pg_roles r ON r.oid=a.roleid
   JOIN pg_roles m ON m.oid=a.member
   JOIN pg_roles g ON g.oid=a.grantor
   WHERE r.rolname='resources_cms_command_owner' AND m.rolname='postgres'
   AND g.rolname='postgres' AND NOT a.admin_option
   AND NOT a.inherit_option AND a.set_option)<>1
 THEN RAISE EXCEPTION 'Temporary SET-only membership not established'; END IF;
END $topic_temp$;
-- Function ownership transfer also requires CREATE on the function schema.
GRANT CREATE ON SCHEMA resources_cms TO resources_cms_command_owner;

CREATE TABLE resources_cms.topic_queue (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 topic text NOT NULL CHECK (char_length(btrim(topic)) BETWEEN 6 AND 180),
 brief text NOT NULL DEFAULT '' CHECK (char_length(brief)<=1200),
 audience text NOT NULL DEFAULT 'both' CHECK (audience IN ('both','homeowners','professionals')),
 state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','generating','drafted','archived')),
 article_id uuid NOT NULL DEFAULT gen_random_uuid(),
 attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
 version integer NOT NULL DEFAULT 1,
 created_by uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 claimed_at timestamptz,
 UNIQUE(article_id)
);
CREATE UNIQUE INDEX cms_topic_no_duplicate_names ON resources_cms.topic_queue(lower(btrim(topic)));
ALTER TABLE resources_cms.topic_queue ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON resources_cms.topic_queue FROM PUBLIC,anon,authenticated,resources_cms_runtime;
GRANT SELECT,INSERT,UPDATE ON resources_cms.topic_queue TO resources_cms_command_owner;
CREATE POLICY topic_queue_owner_only ON resources_cms.topic_queue FOR ALL TO resources_cms_command_owner USING(true) WITH CHECK(true);

-- One row lock serializes paid generation claims across serverless workers.
-- Every claim counts toward a rolling 24h budget, including failed providers.
CREATE TABLE resources_cms.topic_generation_gate(id integer PRIMARY KEY CHECK(id=1));
INSERT INTO resources_cms.topic_generation_gate VALUES(1);
CREATE TABLE resources_cms.topic_generation_attempts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 topic_id uuid NOT NULL REFERENCES resources_cms.topic_queue(id),
 actor_id uuid NOT NULL,
 claimed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cms_topic_generation_recent ON resources_cms.topic_generation_attempts(claimed_at);
ALTER TABLE resources_cms.topic_generation_gate ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources_cms.topic_generation_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON resources_cms.topic_generation_gate,resources_cms.topic_generation_attempts
 FROM PUBLIC,anon,authenticated,resources_cms_runtime;
GRANT SELECT,UPDATE ON resources_cms.topic_generation_gate TO resources_cms_command_owner;
GRANT SELECT,INSERT ON resources_cms.topic_generation_attempts TO resources_cms_command_owner;
CREATE POLICY cms_topic_gate_command_only ON resources_cms.topic_generation_gate
 FOR ALL TO resources_cms_command_owner USING(true) WITH CHECK(true);
CREATE POLICY cms_topic_attempt_command_only ON resources_cms.topic_generation_attempts
 FOR ALL TO resources_cms_command_owner USING(true) WITH CHECK(true);

-- Only verified Supabase PostgREST claims with active CMS owner membership
-- can reach the queue. Never derive authorization from request body.
CREATE FUNCTION resources_cms.topic_queue_list()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF resources_cms.actor() IS NULL OR NOT resources_cms.has_role(ARRAY['owner'])
 THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='42501'; END IF;
 RETURN coalesce(
 (SELECT jsonb_agg(jsonb_build_object(
  'id',q.id,'topic',q.topic,'brief',q.brief,'audience',q.audience,
  'status',q.state,'articleId',q.article_id,'attempts',q.attempts,'version',q.version,
  'createdAt',q.created_at,'updatedAt',q.updated_at
 ) ORDER BY q.created_at,q.id) FROM resources_cms.topic_queue q WHERE q.state<>'archived'),
 '[]'::jsonb);
END $$;

CREATE FUNCTION resources_cms.topic_queue_command(
 p_action text,p_id uuid,p_version integer,p_payload jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 actor_id uuid:=resources_cms.actor();
 q resources_cms.topic_queue;
 name text;
 instructions text;
 audience text;

BEGIN
 IF actor_id IS NULL OR NOT resources_cms.has_role(ARRAY['owner'])
 THEN RAISE EXCEPTION 'Owner required' USING ERRCODE='42501'; END IF;
 IF p_action IS NULL OR p_id IS NULL OR p_version IS NULL OR p_version<0
    OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object'
 THEN RAISE EXCEPTION 'Invalid topic request' USING ERRCODE='22023'; END IF;
 IF p_action='add' THEN
   name:=btrim(coalesce(p_payload->>'topic',''));
   instructions:=btrim(coalesce(p_payload->>'brief',''));
   audience:=coalesce(p_payload->>'audience','both');
   IF p_version<>0 OR p_id IS NULL OR char_length(name) NOT BETWEEN 6 AND 180
      OR char_length(instructions)>1200 OR audience NOT IN ('both','homeowners','professionals')
   THEN RAISE EXCEPTION 'Invalid topic request' USING ERRCODE='22023'; END IF;
   PERFORM 1 FROM resources_cms.topic_generation_gate WHERE id=1 FOR UPDATE;
   SELECT * INTO q FROM resources_cms.topic_queue WHERE id=p_id;
   IF FOUND THEN
     IF q.topic IS DISTINCT FROM name OR q.brief IS DISTINCT FROM instructions
        OR q.audience IS DISTINCT FROM audience OR q.created_by IS DISTINCT FROM actor_id
     THEN RAISE EXCEPTION 'Topic request identity conflict' USING ERRCODE='40001'; END IF;
   ELSE
   IF (SELECT count(*) FROM resources_cms.topic_queue WHERE state<>'archived')>=100
   THEN RAISE EXCEPTION 'Topic queue limit' USING ERRCODE='22023'; END IF;
   INSERT INTO resources_cms.topic_queue(id,topic,brief,audience,created_by)
   VALUES(p_id,name,instructions,audience,actor_id) RETURNING * INTO q;
   END IF;
 ELSE
   SELECT * INTO q FROM resources_cms.topic_queue WHERE id=p_id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Topic not found' USING ERRCODE='22023'; END IF;
   IF q.version IS DISTINCT FROM p_version THEN RAISE EXCEPTION 'Topic changed; reload queue' USING ERRCODE='40001'; END IF;
   IF p_action='claim' THEN
     IF q.state<>'queued' OR q.attempts>=3
     THEN RAISE EXCEPTION 'Topic is not ready for generation' USING ERRCODE='22023'; END IF;
     PERFORM 1 FROM resources_cms.topic_generation_gate WHERE id=1 FOR UPDATE;
     IF (SELECT count(*) FROM resources_cms.topic_generation_attempts
           WHERE claimed_at>now()-interval '24 hours')>=10
     THEN RAISE EXCEPTION 'Daily editorial generation budget exhausted' USING ERRCODE='22023'; END IF;
     IF EXISTS(SELECT 1 FROM resources_cms.topic_queue
           WHERE state='generating' AND claimed_at>now()-interval '3 minutes')
     THEN RAISE EXCEPTION 'Another topic is already generating' USING ERRCODE='22023'; END IF;
     UPDATE resources_cms.topic_queue SET state='generating',attempts=attempts+1,
       claimed_at=now(),version=version+1,updated_at=now()
       WHERE id=p_id RETURNING * INTO q;
     INSERT INTO resources_cms.topic_generation_attempts(topic_id,actor_id)
     VALUES(p_id,actor_id);
   ELSIF p_action='release' THEN
     IF q.state<>'generating' THEN RAISE EXCEPTION 'Topic is not generating' USING ERRCODE='22023'; END IF;
     UPDATE resources_cms.topic_queue SET state='queued',claimed_at=NULL,
       version=version+1,updated_at=now() WHERE id=p_id RETURNING * INTO q;
   ELSIF p_action='complete' THEN
     IF q.state<>'generating' THEN RAISE EXCEPTION 'Topic is not generating' USING ERRCODE='22023'; END IF;
     IF NOT EXISTS (SELECT 1 FROM resources_cms.articles a WHERE a.id=q.article_id AND a.state='draft')
     THEN RAISE EXCEPTION 'Generated private draft missing' USING ERRCODE='23503'; END IF;
     UPDATE resources_cms.topic_queue SET state='drafted',claimed_at=NULL,
       version=version+1,updated_at=now() WHERE id=p_id RETURNING * INTO q;
   ELSIF p_action='archive' THEN
     IF q.state='generating' THEN RAISE EXCEPTION 'Cannot archive generating topic' USING ERRCODE='22023'; END IF;
     UPDATE resources_cms.topic_queue SET state='archived',
       version=version+1,updated_at=now() WHERE id=p_id RETURNING * INTO q;
   ELSIF p_action='retry' THEN
     -- Recovery after an interrupted request, never changes an existing article.
     IF q.state<>'generating' OR q.claimed_at>now()-interval '3 minutes'
     THEN RAISE EXCEPTION 'Generation is still active' USING ERRCODE='22023'; END IF;
     UPDATE resources_cms.topic_queue SET state='queued',claimed_at=NULL,
       version=version+1,updated_at=now() WHERE id=p_id RETURNING * INTO q;
   ELSE RAISE EXCEPTION 'Unsupported topic action' USING ERRCODE='22023';
   END IF;
 END IF;
 RETURN jsonb_build_object('id',q.id,'topic',q.topic,'brief',q.brief,
   'audience',q.audience,'status',q.state,'articleId',q.article_id,
   'version',q.version,'attempts',q.attempts);
END $$;

-- The non-superuser creator MUST set routine ACLs BEFORE ownership transfer.
-- Afterwards postgres cannot grant/revoke privileges from the restricted owner.
REVOKE ALL ON FUNCTION resources_cms.topic_queue_list(),
 resources_cms.topic_queue_command(text,uuid,integer,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION resources_cms.topic_queue_list(),
 resources_cms.topic_queue_command(text,uuid,integer,jsonb) TO authenticated;

ALTER FUNCTION resources_cms.topic_queue_list() OWNER TO resources_cms_command_owner;
ALTER FUNCTION resources_cms.topic_queue_command(text,uuid,integer,jsonb) OWNER TO resources_cms_command_owner;

-- Seed owner's eight requests as QUEUED topics, not CMS articles or approvals.
INSERT INTO resources_cms.topic_queue(topic,brief,audience) VALUES
('Ruthenium in salt chlorine generator cells','Coated titanium electrodes, ruthenium and iridium materials, replacement-cell prices, upkeep and lifecycle cost; never infer manufacturer coating weight or BOM price.','both'),
('Maintenance of a salt chlorine generator system','Water balance, salinity, cleaning only when needed, scale, seasonal settings, safety and model-specific maintenance.','both'),
('Sodium bisulfate versus muriatic acid for pools','pH and alkalinity effects, sulfates versus chloride, relative cost, equipment compatibility and chemical handling safety.','both'),
('Borates in pools: borax, boric acid and sodium tetraborate','Buffering chemistry, naming, pH adjustment, limitations, testing and pet/child safety.','both'),
('Salt chlorine generators versus tablets, UV and AOP','Residual sanitizer distinction, effectiveness, ownership costs, stabilizer effects and compatible supplemental systems.','both'),
('Types of algae in swimming pools','Green, yellow/mustard and dark algae/cyanobacteria; compare staining, biofilm and surface-safe approaches.','both'),
('Metals in pools: stains, testing and treatments','Iron, copper, manganese, sources, stain colors, test limits, sequestration versus physical removal and prevention.','both'),
('Weekly care of your pool','Practical weekly maintenance checklist, while emphasizing sanitizer and pH need more frequent testing. Covers what to inspect, add only when testing justifies, cleaning/filtration, borates, algaecides and convenient add-ons.','homeowners')
ON CONFLICT DO NOTHING;

-- Ephemeral privileges must disappear within this same atomic transaction.
REVOKE CREATE ON SCHEMA resources_cms FROM resources_cms_command_owner;
REVOKE resources_cms_command_owner FROM postgres GRANTED BY postgres RESTRICT;
DO $topic_postflight$ BEGIN
 IF pg_has_role('postgres','resources_cms_command_owner','SET')
    OR pg_has_role('postgres','resources_cms_command_owner','USAGE')
    OR has_schema_privilege('resources_cms_command_owner','resources_cms','CREATE')
 THEN RAISE EXCEPTION 'Temporary grants survived migration'; END IF;
 IF (SELECT count(*) FROM pg_auth_members a
       JOIN pg_roles r ON r.oid=a.roleid
       JOIN pg_roles m ON m.oid=a.member
       JOIN pg_roles g ON g.oid=a.grantor
       WHERE r.rolname='resources_cms_command_owner' AND m.rolname='postgres'
       AND g.rolname='supabase_admin' AND a.admin_option
       AND NOT a.inherit_option AND NOT a.set_option)<>1
    OR (SELECT count(*) FROM pg_auth_members a
       JOIN pg_roles r ON r.oid=a.roleid
       JOIN pg_roles m ON m.oid=a.member
       WHERE r.rolname='resources_cms_command_owner' AND m.rolname='postgres')<>1
 THEN RAISE EXCEPTION 'Managed command-owner membership changed'; END IF;
 IF (SELECT count(*) FROM pg_proc p WHERE p.oid IN (
    'resources_cms.topic_queue_list()'::regprocedure,
    'resources_cms.topic_queue_command(text,uuid,integer,jsonb)'::regprocedure
   ) AND pg_get_userbyid(p.proowner)='resources_cms_command_owner')<>2
 THEN RAISE EXCEPTION 'Topic RPC owner mismatch'; END IF;
 IF (SELECT count(*) FROM resources_cms.topic_queue)<>8
    OR (SELECT count(*) FROM resources_cms.topic_generation_attempts)<>0
    OR NOT EXISTS (SELECT 1 FROM resources_cms.topic_queue
       WHERE topic='Weekly care of your pool' AND state='queued')
 THEN RAISE EXCEPTION 'Topic seed or budget table changed'; END IF;
 IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname='resources_cms'
     AND c.relname IN ('topic_queue','topic_generation_gate','topic_generation_attempts')
     AND (NOT c.relrowsecurity OR
       has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE')
       OR has_table_privilege('resources_cms_runtime',c.oid,'SELECT,INSERT,UPDATE,DELETE')))
 THEN RAISE EXCEPTION 'Unsafe direct queue table privilege'; END IF;
 IF has_function_privilege('anon','resources_cms.topic_queue_list()','EXECUTE')
    OR has_function_privilege('anon','resources_cms.topic_queue_command(text,uuid,integer,jsonb)','EXECUTE')
    OR has_function_privilege('resources_cms_runtime','resources_cms.topic_queue_list()','EXECUTE')
    OR has_function_privilege('resources_cms_runtime','resources_cms.topic_queue_command(text,uuid,integer,jsonb)','EXECUTE')
    OR NOT has_function_privilege('authenticated','resources_cms.topic_queue_list()','EXECUTE')
    OR NOT has_function_privilege('authenticated','resources_cms.topic_queue_command(text,uuid,integer,jsonb)','EXECUTE')
 THEN RAISE EXCEPTION 'Unsafe topic RPC grant'; END IF;
END $topic_postflight$;

-- Supabase apply_migration owns the commit and migration-history insertion.
