-- REVIEW/STAGING CANDIDATE ONLY. Not automatically applied; Production untouched.
-- This is a new private queue, separate from held owner-approved manuscripts.
BEGIN;
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

ALTER FUNCTION resources_cms.topic_queue_list() OWNER TO resources_cms_command_owner;
ALTER FUNCTION resources_cms.topic_queue_command(text,uuid,integer,jsonb) OWNER TO resources_cms_command_owner;

REVOKE ALL ON FUNCTION resources_cms.topic_queue_list(),
 resources_cms.topic_queue_command(text,uuid,integer,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION resources_cms.topic_queue_list(),
 resources_cms.topic_queue_command(text,uuid,integer,jsonb) TO authenticated;

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
COMMIT;
