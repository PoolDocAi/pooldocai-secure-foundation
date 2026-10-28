-- LOCAL REVIEW FRAGMENT. Parent migration supplies BEGIN/COMMIT and temporary
-- ownership-transfer membership. Never execute separately or remotely unapproved.
CREATE TABLE resources_cms.media_rights_reviews(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),media_id uuid NOT NULL REFERENCES resources_cms.media(id),
 version integer NOT NULL CHECK(version>0),review_status text NOT NULL CHECK(review_status IN ('pending','approved','revoked')),
 details jsonb NOT NULL CHECK(jsonb_typeof(details)='object'),actor_id uuid NOT NULL,reviewed_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(media_id,version)
);
ALTER TABLE resources_cms.media_rights_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON resources_cms.media_rights_reviews FROM PUBLIC,anon,authenticated,resources_cms_runtime;
GRANT SELECT,INSERT ON resources_cms.media_rights_reviews TO resources_cms_command_owner;
CREATE POLICY cms_media_rights_read ON resources_cms.media_rights_reviews FOR SELECT TO resources_cms_command_owner USING(true);
CREATE POLICY cms_media_rights_insert ON resources_cms.media_rights_reviews FOR INSERT TO resources_cms_command_owner
 WITH CHECK(actor_id=resources_cms.actor() AND resources_cms.has_role(ARRAY['owner','editor']));
CREATE TRIGGER cms_media_rights_immutable BEFORE UPDATE OR DELETE ON resources_cms.media_rights_reviews FOR EACH ROW EXECUTE FUNCTION resources_cms.immutable_record();

CREATE FUNCTION resources_cms.media_rights_details_valid(p jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE k text;
BEGIN
 IF jsonb_typeof(p)<>'object' OR pg_column_size(p)>20000 THEN RETURN false;END IF;
 IF coalesce(p->>'authenticity','') NOT IN ('authentic-photograph','official-diagram','brand-graphic') OR
    coalesce(p->>'sourceType','') NOT IN ('pooldocai-original','manufacturer','licensed-professional','licensed-library','permitted-contributor','brand-graphic') THEN RETURN false;END IF;
 FOREACH k IN ARRAY ARRAY['sourceUrl','attribution','license','permissionReference','copyright','checksum','alt'] LOOP
  IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' OR length(btrim(p->>k)) NOT BETWEEN 1 AND 2000 THEN RETURN false;END IF;
 END LOOP;
 IF length(p->>'alt')>300 OR p->>'sourceUrl' !~ '^https://[^[:space:]<>]+$' OR p->>'sourceUrl' ~ '^https://[^/]*@' OR p->>'checksum' !~ '^[a-f0-9]{64}$' THEN RETURN false;END IF;
 IF jsonb_typeof(p->'width') IS DISTINCT FROM 'number' OR jsonb_typeof(p->'height') IS DISTINCT FROM 'number' OR coalesce(p->>'width','') !~ '^[1-9][0-9]{0,4}$' OR coalesce(p->>'height','') !~ '^[1-9][0-9]{0,4}$' OR (p->>'width')::integer>10000 OR (p->>'height')::integer>10000 THEN RETURN false;END IF;
 IF p->>'expiresAt' IS NOT NULL AND (p->>'expiresAt')<>'' THEN
  IF p->>'expiresAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9:.]+(Z|[+-][0-9]{2}:[0-9]{2}))?$' THEN RETURN false;END IF;
  PERFORM (p->>'expiresAt')::timestamptz;
 END IF;
 IF p ? 'equipment' AND jsonb_typeof(p->'equipment') IS DISTINCT FROM 'object' THEN RETURN false;END IF;
 IF p#>'{equipment,representative}' IS NOT NULL AND jsonb_typeof(p#>'{equipment,representative}') IS DISTINCT FROM 'boolean' THEN RETURN false;END IF;
 IF p#>'{equipment,representative}'='true'::jsonb AND length(btrim(coalesce(p#>>'{equipment,representativeLabel}','')))=0 THEN RETURN false;END IF;
 RETURN true;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation OR numeric_value_out_of_range THEN RETURN false;
END $$;

CREATE FUNCTION resources_cms.media_release_ready(p_media_id uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE item resources_cms.media;review resources_cms.media_rights_reviews;
BEGIN
 SELECT * INTO item FROM resources_cms.media WHERE id=p_media_id;
 IF NOT FOUND OR item.archived THEN RETURN false;END IF;
 SELECT * INTO review FROM resources_cms.media_rights_reviews WHERE media_id=p_media_id ORDER BY version DESC LIMIT 1;
 IF NOT FOUND OR review.review_status<>'approved' OR review.reviewed_at IS NULL OR NOT resources_cms.media_rights_details_valid(review.details) THEN RETURN false;END IF;
 IF review.details->>'checksum'<>item.checksum THEN RETURN false;END IF;
 IF coalesce(review.details->>'expiresAt','')<>'' AND (review.details->>'expiresAt')::timestamptz<=now() THEN RETURN false;END IF;
 RETURN true;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN false;
END;
$$;

CREATE FUNCTION resources_cms.media_rights_read(p_media_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF resources_cms.actor() IS NULL OR NOT resources_cms.has_role(ARRAY['owner','editor','reviewer','viewer']) THEN RAISE EXCEPTION 'CMS authorization denied';END IF;
 RETURN coalesce((SELECT jsonb_agg(r.details||jsonb_build_object('mediaId',r.media_id,'version',r.version,'status',r.review_status,
  'reviewStatus',CASE WHEN r.review_status='approved' THEN 'rights-and-relevance-verified' ELSE r.review_status END,
  'reviewerId',CASE WHEN r.review_status='approved' THEN r.actor_id END,'reviewedAt',r.reviewed_at,'ready',resources_cms.media_release_ready(r.media_id)))
 FROM(SELECT DISTINCT ON(media_id)* FROM resources_cms.media_rights_reviews WHERE p_media_id IS NULL OR media_id=p_media_id ORDER BY media_id,version DESC)r),'[]'::jsonb);
END $$;

CREATE FUNCTION resources_cms.media_rights_command(p_command_id uuid,p_media_id uuid,p_version integer,p_action text,p_details jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE actor uuid:=resources_cms.actor();prior resources_cms.command_receipts;latest resources_cms.media_rights_reviews;
 item resources_cms.media;entry resources_cms.media_rights_reviews;fp text;answer jsonb;next_status text;metadata jsonb;
BEGIN
 IF actor IS NULL OR NOT resources_cms.has_role(ARRAY['owner','editor']) THEN RAISE EXCEPTION 'Editor required';END IF;
 IF p_command_id IS NULL OR p_media_id IS NULL OR p_version<0 OR p_version IS NULL OR p_action IS NULL OR p_action NOT IN ('submit','approve','revoke') OR jsonb_typeof(p_details) IS DISTINCT FROM 'object' OR pg_column_size(p_details)>20000 THEN RAISE EXCEPTION 'Invalid media rights command';END IF;
 fp:=encode(sha256(convert_to(jsonb_build_array(p_media_id,p_version,p_action,p_details)::text,'UTF8')),'hex');
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_command_id::text,0));
 SELECT * INTO prior FROM resources_cms.command_receipts WHERE command_id=p_command_id;
 IF FOUND THEN
  IF prior.actor_id<>actor OR prior.namespace<>'media-rights' OR prior.target_id<>p_media_id OR prior.fingerprint<>fp THEN RAISE EXCEPTION 'Idempotency key reuse rejected';END IF;
  RETURN prior.result||jsonb_build_object('ready',resources_cms.media_release_ready(p_media_id),'replayed',true);
 END IF;
 SELECT * INTO item FROM resources_cms.media WHERE id=p_media_id FOR UPDATE;
 IF NOT FOUND OR item.archived THEN RAISE EXCEPTION 'Active media required';END IF;
 SELECT * INTO latest FROM resources_cms.media_rights_reviews WHERE media_id=p_media_id ORDER BY version DESC LIMIT 1;
 IF coalesce(latest.version,0)<>p_version THEN RAISE EXCEPTION 'Media rights version conflict';END IF;
 IF p_action='submit' THEN
  IF latest.review_status='approved' THEN RAISE EXCEPTION 'Owner must revoke approved rights before replacement review';END IF;
  IF p_details ?| ARRAY['reviewStatus','reviewerId','reviewedAt','ready','status'] THEN RAISE EXCEPTION 'Client review claims rejected';END IF;
  IF coalesce(p_details->>'checksum','')<>item.checksum THEN RAISE EXCEPTION 'Registered image checksum required';END IF;
  metadata:=p_details;next_status:='pending';
 ELSE
  IF NOT resources_cms.has_role(ARRAY['owner']) THEN RAISE EXCEPTION 'Owner required';END IF;
  metadata:=latest.details;
  IF p_action='approve' THEN
   IF latest.review_status IS DISTINCT FROM 'pending' OR p_details->'humanVerified' IS DISTINCT FROM 'true'::jsonb OR NOT resources_cms.media_rights_details_valid(metadata)
    OR metadata->>'checksum'<>item.checksum OR (coalesce(metadata->>'expiresAt','')<>'' AND (metadata->>'expiresAt')::timestamptz<=now()) THEN RAISE EXCEPTION 'Explicit complete human rights and relevance review required';END IF;
   next_status:='approved';
  ELSE
   IF latest.version IS NULL OR length(btrim(coalesce(p_details->>'reason','')))=0 THEN RAISE EXCEPTION 'Revocation reason required';END IF;
   metadata:=metadata||jsonb_build_object('revocationReason',left(p_details->>'reason',1000));next_status:='revoked';
  END IF;
 END IF;
 INSERT INTO resources_cms.media_rights_reviews(media_id,version,review_status,details,actor_id,reviewed_at)
 VALUES(p_media_id,p_version+1,next_status,metadata,actor,CASE WHEN next_status='approved' THEN now() END) RETURNING * INTO entry;
 answer:=metadata||jsonb_build_object('mediaId',p_media_id,'version',entry.version,'status',next_status,'reviewStatus',CASE WHEN next_status='approved' THEN 'rights-and-relevance-verified' ELSE next_status END,
  'reviewerId',CASE WHEN next_status='approved' THEN actor END,'reviewedAt',entry.reviewed_at,'ready',resources_cms.media_release_ready(p_media_id));
 INSERT INTO resources_cms.command_receipts(command_id,actor_id,namespace,target_id,fingerprint,result) VALUES(p_command_id,actor,'media-rights',p_media_id,fp,answer);
 INSERT INTO resources_cms.audit(actor_id,action,detail) VALUES(actor,'media_rights_'||p_action,jsonb_build_object('mediaId',p_media_id,'rightsVersion',entry.version,'status',next_status));
 RETURN answer;
END $$;

ALTER FUNCTION resources_cms.media_rights_details_valid(jsonb) OWNER TO resources_cms_command_owner;
ALTER FUNCTION resources_cms.media_release_ready(uuid) OWNER TO resources_cms_command_owner;
ALTER FUNCTION resources_cms.media_rights_read(uuid) OWNER TO resources_cms_command_owner;
ALTER FUNCTION resources_cms.media_rights_command(uuid,uuid,integer,text,jsonb) OWNER TO resources_cms_command_owner;
REVOKE ALL ON FUNCTION resources_cms.media_rights_details_valid(jsonb),resources_cms.media_release_ready(uuid),resources_cms.media_rights_read(uuid),resources_cms.media_rights_command(uuid,uuid,integer,text,jsonb) FROM PUBLIC,anon,authenticated,resources_cms_runtime;
GRANT EXECUTE ON FUNCTION resources_cms.media_rights_read(uuid),resources_cms.media_rights_command(uuid,uuid,integer,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION resources_cms.media_rights_details_valid(jsonb),resources_cms.media_release_ready(uuid) TO resources_cms_command_owner;
