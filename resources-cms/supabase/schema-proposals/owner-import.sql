-- LOCAL REVIEW PROPOSAL FRAGMENT ONLY. Run only within an approved migration transaction.
-- Parent migration owns function transfer/grant checks. No role creation or core changes.
CREATE FUNCTION resources_cms.safe_public_html(p_html text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path='' AS $safe$
DECLARE token text; parts text[]; tag text; attrs text; attr text[]; names text[]; key text; val text;
BEGIN
 IF p_html IS NULL OR octet_length(p_html)>250000 OR p_html ~ '[\x01-\x08\x0b\x0c\x0e-\x1f]' THEN RETURN false; END IF;
 IF regexp_replace(p_html,'<[^>]*>','','g') ~ '[<>]' THEN RETURN false; END IF;
 FOR token IN SELECT m[1] FROM regexp_matches(p_html,'(<[^>]*>)','g') m LOOP
  IF token ~ '^</[a-z][a-z0-9]*>$' THEN tag:=substring(token FROM '^</([a-z][a-z0-9]*)>$'); attrs:='';
  ELSE
   parts:=regexp_match(token,'^<([a-z][a-z0-9]*)([[:space:]][^<>]*)?/?>$');
   IF parts IS NULL THEN RETURN false; END IF;
   tag:=parts[1];attrs:=coalesce(parts[2],'');attrs:=regexp_replace(attrs,'/[[:space:]]*$','');
  END IF;
  IF tag <> ALL(ARRAY['p','br','h2','h3','h4','strong','b','em','i','a','ul','ol','li','table','thead','tbody','tr','th','td','caption','blockquote','aside','div','section','span','img','figure','figcaption','hr','sup','pre','code']) THEN RETURN false; END IF;
  names:=ARRAY[]::text[];
  WHILE btrim(attrs)<>'' LOOP
   attr:=regexp_match(attrs,'^([[:space:]]+([a-z][a-z0-9-]*)="([^"]*)")');
   IF attr IS NULL THEN RETURN false; END IF;
   key:=attr[2];val:=attr[3];
   IF key=ANY(names) OR val ~ '[<>\x01-\x1f]' THEN RETURN false; END IF;
   names:=array_append(names,key);
   IF key='id' THEN IF val !~ '^[A-Za-z0-9_:-]{1,120}$' THEN RETURN false; END IF;
   ELSIF key='role' AND tag IN ('aside','div') THEN IF val<>'note' THEN RETURN false; END IF;
   ELSIF key='class' AND tag IN ('aside','div') THEN IF val NOT IN ('callout','safety-callout') THEN RETURN false; END IF;
   ELSIF key IN ('href','title') AND tag='a' THEN
    IF key='href' AND val<>'' AND NOT (val ~ '^https://[^[:space:]<>"''\\]+$' OR val ~ '^/resources/[a-z0-9-]+/?$' OR val ~ '^/media/[a-f0-9-]{36}$' OR val ~ '^#[A-Za-z0-9_-]+$') THEN RETURN false; END IF;
   ELSIF key IN ('src','alt','width','height') AND tag='img' THEN
    IF key='src' AND val<>'' AND val !~ '^/media/[a-f0-9-]{36}$' THEN RETURN false; END IF;
    IF key IN ('width','height') AND (val !~ '^[0-9]{1,4}$' OR val::integer NOT BETWEEN 1 AND 4096) THEN RETURN false; END IF;
   ELSIF key IN ('colspan','rowspan') AND tag IN ('th','td') THEN IF val !~ '^[0-9]{1,2}$' OR val::integer<1 THEN RETURN false; END IF;
   ELSIF key='scope' AND tag='th' THEN IF val NOT IN ('row','col','rowgroup','colgroup') THEN RETURN false; END IF;
   ELSE RETURN false;
   END IF;
   attrs:=substring(attrs FROM length(attr[1])+1);
  END LOOP;
 END LOOP;
 RETURN true;
EXCEPTION WHEN others THEN RETURN false;
END $safe$;
REVOKE ALL ON FUNCTION resources_cms.safe_public_html(text) FROM PUBLIC,anon,authenticated,service_role,resources_cms_runtime;
GRANT EXECUTE ON FUNCTION resources_cms.safe_public_html(text) TO resources_cms_command_owner;

RESET ROLE;
CREATE TABLE resources_cms.approved_import_allowlist(
 source_identity text PRIMARY KEY,
 envelope_checksum text NOT NULL CHECK(envelope_checksum ~ '^[a-f0-9]{64}$')
);
ALTER TABLE resources_cms.approved_import_allowlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE resources_cms.approved_import_allowlist FORCE ROW LEVEL SECURITY;
REVOKE ALL ON resources_cms.approved_import_allowlist FROM PUBLIC,anon,authenticated,service_role,resources_cms_runtime,resources_cms_command_owner;
GRANT SELECT ON resources_cms.approved_import_allowlist TO resources_cms_command_owner;
CREATE POLICY cms_approved_import_read ON resources_cms.approved_import_allowlist FOR SELECT TO resources_cms_command_owner USING(true);
-- Supabase project postgres may be a non-BYPASSRLS owner; explicit seed/read policies apply only to this new metadata table.
CREATE POLICY cms_approved_import_admin_read ON resources_cms.approved_import_allowlist FOR SELECT TO postgres USING(true);
CREATE POLICY cms_approved_import_admin_seed ON resources_cms.approved_import_allowlist FOR INSERT TO postgres WITH CHECK(true);
CREATE TRIGGER cms_approved_import_allowlist_immutable BEFORE UPDATE OR DELETE ON resources_cms.approved_import_allowlist FOR EACH ROW EXECUTE FUNCTION resources_cms.immutable_record();
SET ROLE resources_cms_command_owner;
CREATE FUNCTION resources_cms.canonical_import_json(p_value jsonb) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $canonical$
 SELECT CASE jsonb_typeof(p_value)
 WHEN 'object' THEN '{'||coalesce((SELECT string_agg(to_jsonb(key)::text||':'||resources_cms.canonical_import_json(value),',' ORDER BY key COLLATE "C") FROM jsonb_each(p_value)),'')||'}'
 WHEN 'array' THEN '['||coalesce((SELECT string_agg(resources_cms.canonical_import_json(value),',' ORDER BY ordinality) FROM jsonb_array_elements(p_value) WITH ORDINALITY),'')||']'
 ELSE p_value::text END
$canonical$;
REVOKE ALL ON FUNCTION resources_cms.canonical_import_json(jsonb) FROM PUBLIC,anon,authenticated,service_role,resources_cms_runtime;
GRANT EXECUTE ON FUNCTION resources_cms.canonical_import_json(jsonb) TO resources_cms_command_owner;
RESET ROLE;
CREATE TABLE resources_cms.owner_import_sources(
 article_id uuid NOT NULL REFERENCES resources_cms.articles(id),
 resource_id text NOT NULL CHECK(resource_id<>'30'),
 source_identity text NOT NULL,
 source_checksum text NOT NULL CHECK(source_checksum ~ '^[a-f0-9]{64}$'),
 body_checksum text NOT NULL CHECK(body_checksum ~ '^[a-f0-9]{64}$'),
 approval_status text NOT NULL CHECK(approval_status IN ('editorial-approved','historical-live-snapshot')),
 asset_status text NOT NULL CHECK(asset_status IN ('not-required','pending-review','blocked')),
 envelope jsonb NOT NULL,
 imported_by uuid NOT NULL,
 imported_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(article_id,source_checksum),UNIQUE(source_identity)
);
ALTER TABLE resources_cms.owner_import_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON resources_cms.owner_import_sources FROM PUBLIC,anon,authenticated,service_role,resources_cms_runtime;
GRANT SELECT,INSERT ON resources_cms.owner_import_sources TO resources_cms_command_owner;
CREATE POLICY cms_owner_import_internal ON resources_cms.owner_import_sources TO resources_cms_command_owner USING(resources_cms.has_role(ARRAY['owner'])) WITH CHECK(resources_cms.has_role(ARRAY['owner']));
CREATE TRIGGER cms_owner_import_immutable BEFORE UPDATE OR DELETE ON resources_cms.owner_import_sources FOR EACH ROW EXECUTE FUNCTION resources_cms.immutable_record();

SET ROLE resources_cms_command_owner;
CREATE FUNCTION resources_cms.owner_import(p_command_id uuid,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $import$
DECLARE actor uuid:=resources_cms.actor(); aid uuid; fp text; receipt resources_cms.command_receipts; prior resources_cms.owner_import_sources;
 a resources_cms.articles; row jsonb; old resources_cms.revisions; v integer; rid uuid; category resources_cms.taxonomy; answer jsonb; source_bytes bytea; expected integer:=0; latest uuid; latest_editable jsonb; stored_version integer; revision_mapping jsonb:='[]'::jsonb;
BEGIN
 IF actor IS NULL OR NOT resources_cms.has_role(ARRAY['owner']) THEN RAISE EXCEPTION 'Owner required'; END IF;
 IF octet_length(p_payload::text)>2000000 OR p_payload->>'format'<>'pooldocai-owner-import-v1' OR p_payload->>'resourceId'='30' THEN RAISE EXCEPTION 'Approved import rejected'; END IF;
 IF NOT EXISTS(SELECT 1 FROM resources_cms.approved_import_allowlist WHERE source_identity=p_payload#>>'{source,identity}' AND envelope_checksum=encode(sha256(convert_to(resources_cms.canonical_import_json(p_payload),'UTF8')),'hex')) THEN RAISE EXCEPTION 'Private approved source not authorized'; END IF;
 IF p_payload->>'resourceId' NOT IN ('legacy-pump','legacy-green','01','02','03','04','05','06','07','08','09','10','11','12','13','14','15','16','17','18','19','20','21','22','23','24','25','26','27','28','29','31','32','33') THEN RAISE EXCEPTION 'Unknown approved resource'; END IF;
 IF p_payload->>'state'<>'draft' OR p_payload->>'publicationAuthorized'<>'false' OR p_payload->>'knowledgeEligible'<>'false' OR p_payload->>'hold'<>'true' THEN RAISE EXCEPTION 'Protected draft state required'; END IF;
 IF p_payload->'source'->>'approvalStatus' NOT IN ('editorial-approved','historical-live-snapshot') OR p_payload->>'assetStatus' NOT IN ('not-required','pending-review','blocked') THEN RAISE EXCEPTION 'Source status required'; END IF;
 aid:=(p_payload->>'articleId')::uuid; fp:=encode(sha256(convert_to(p_payload::text,'UTF8')),'hex');
 source_bytes:=decode(p_payload#>>'{source,base64}','base64');
 IF length(source_bytes)=0 OR encode(sha256(source_bytes),'hex')<>p_payload#>>'{source,sha256}' OR encode(sha256(convert_to(p_payload#>>'{article,body}','UTF8')),'hex')<>p_payload->>'bodyChecksum' THEN RAISE EXCEPTION 'Import source checksum mismatch'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_command_id::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(aid::text,1));
 SELECT * INTO receipt FROM resources_cms.command_receipts WHERE command_id=p_command_id;
 IF FOUND THEN
  IF receipt.actor_id<>actor OR receipt.namespace<>'owner-import' OR receipt.target_id<>aid OR receipt.fingerprint<>fp THEN RAISE EXCEPTION 'Idempotency key reuse rejected'; END IF;
  RETURN receipt.result;
 END IF;
 SELECT * INTO prior FROM resources_cms.owner_import_sources WHERE article_id=aid AND source_checksum=p_payload#>>'{source,sha256}';
 IF FOUND THEN
  IF prior.envelope<>p_payload THEN RAISE EXCEPTION 'Import source replay mismatch'; END IF;
  RETURN jsonb_build_object('id',aid,'unchanged',true,'state','draft');
 END IF;
 IF EXISTS(SELECT 1 FROM resources_cms.articles WHERE slug=p_payload#>>'{article,slug}' AND id<>aid) THEN RAISE EXCEPTION 'Duplicate canonical slug'; END IF;
 IF jsonb_typeof(p_payload->'history')<>'array' OR jsonb_array_length(p_payload->'history') NOT BETWEEN 1 AND 30 THEN RAISE EXCEPTION 'Immutable history required'; END IF;
 FOR row IN SELECT value FROM jsonb_array_elements(p_payload->'taxonomy') LOOP
  SELECT * INTO category FROM resources_cms.taxonomy WHERE id=(row->>'id')::uuid;
  IF FOUND THEN IF category.kind<>row->>'kind' OR category.name<>row->>'name' THEN RAISE EXCEPTION 'Taxonomy identity conflict'; END IF;
  ELSE INSERT INTO resources_cms.taxonomy(id,kind,name,position,archived,version) VALUES((row->>'id')::uuid,row->>'kind',row->>'name',(row->>'position')::integer,false,1); END IF;
 END LOOP;
 SELECT * INTO a FROM resources_cms.articles WHERE id=aid FOR UPDATE;
 IF NOT FOUND THEN INSERT INTO resources_cms.articles(id,slug,state,version) VALUES(aid,p_payload#>>'{article,slug}','draft',0); SELECT * INTO a FROM resources_cms.articles WHERE id=aid; END IF;
 IF a.slug<>p_payload#>>'{article,slug}' OR a.state IN ('archived','deleted','scheduled') THEN RAISE EXCEPTION 'Existing resource requires explicit reconciliation'; END IF;
 FOR row IN SELECT value FROM jsonb_array_elements(p_payload->'history') ORDER BY (value->>'revision_number')::integer LOOP
  expected:=expected+1;v:=(row->>'revision_number')::integer;rid:=(row->>'id')::uuid;
  IF v<>expected OR (row->>'article_id')::uuid<>aid OR row->'editable' IS NULL OR row->>'rendered_html' IS DISTINCT FROM row#>>'{editable,body}' OR NOT resources_cms.safe_public_html(row->>'rendered_html') THEN RAISE EXCEPTION 'Unsafe or inconsistent historical revision'; END IF;
  SELECT * INTO old FROM resources_cms.revisions WHERE id=rid;
  IF FOUND THEN IF old.article_id<>aid OR old.editable<>row->'editable' OR old.rendered_html<>row->>'rendered_html' OR old.content_checksum<>row->>'content_checksum' THEN RAISE EXCEPTION 'Immutable revision conflict'; END IF; stored_version:=old.revision_number;
  ELSE
   -- Source revision ordinals describe the immutable source archive. Local edits
   -- and editorial transitions may already have advanced the article version.
   -- Preserve source UUIDs and original ordinals in the envelope; append only
   -- at a new monotonic database ordinal, recording the explicit mapping below.
   SELECT greatest(a.version+1,coalesce(max(revision_number),0)+1) INTO stored_version FROM resources_cms.revisions WHERE article_id=aid;
   INSERT INTO resources_cms.revisions(id,article_id,revision_number,editable,rendered_html,content_checksum,primary_category_id,tag_ids,sources,audience,created_by,created_at)
   VALUES(rid,aid,stored_version,row->'editable',row->>'rendered_html',row->>'content_checksum',(row->>'primary_category_id')::uuid,ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(row->'tag_ids')),row->'sources',row->>'audience',actor,(row->>'created_at')::timestamptz);
   a.version:=stored_version;latest:=rid;latest_editable:=row->'editable';
  END IF;
  revision_mapping:=revision_mapping||jsonb_build_array(jsonb_build_object('revisionId',rid,'sourceRevisionNumber',v,'storedRevisionNumber',stored_version));
 END LOOP;
 IF p_payload->'article' IS DISTINCT FROM (p_payload->'history'->-1->'editable') THEN RAISE EXCEPTION 'Working revision payload mismatch'; END IF;
 IF latest IS NOT NULL THEN UPDATE resources_cms.articles SET version=a.version,working_revision_id=latest,state='draft',scheduled_at=NULL,updated_at=now() WHERE id=aid; END IF;
 INSERT INTO resources_cms.editorial_holds(article_id,resource_number,source_checksum,reason) VALUES(aid,p_payload->>'resourceId',p_payload#>>'{source,sha256}',coalesce(p_payload->>'holdReason','Editorial approval does not authorize publication')) ON CONFLICT(article_id) DO NOTHING;
 INSERT INTO resources_cms.owner_import_sources(article_id,resource_id,source_identity,source_checksum,body_checksum,approval_status,asset_status,envelope,imported_by)
 VALUES(aid,p_payload->>'resourceId',p_payload#>>'{source,identity}',p_payload#>>'{source,sha256}',p_payload->>'bodyChecksum',p_payload#>>'{source,approvalStatus}',p_payload->>'assetStatus',p_payload,actor);
 IF p_payload->>'assetStatus'<>'not-required' OR p_payload->>'resourceId' IN ('05','13','14','15','16','17') THEN
  INSERT INTO resources_cms.publication_blocks(article_id,block_key,reason) VALUES(aid,'import-asset-review','Approved source asset delivery or rights remain unverified') ON CONFLICT DO NOTHING;
 END IF;
 FOR row IN SELECT value FROM jsonb_array_elements(coalesce(p_payload->'blocks','[]')) LOOP
  INSERT INTO resources_cms.publication_blocks(article_id,block_key,reason) VALUES(aid,row->>'key',row->>'reason') ON CONFLICT DO NOTHING;
 END LOOP;
 INSERT INTO resources_cms.audit(actor_id,action,article_id,detail) VALUES(actor,'owner_approved_draft_import',aid,jsonb_build_object('sourceIdentity',p_payload#>>'{source,identity}','sourceChecksum',p_payload#>>'{source,sha256}','publicationAuthorized',false,'knowledgeEligible',false,'revisionMapping',revision_mapping));
 answer:=jsonb_build_object('id',aid,'version',a.version,'state','draft','working_revision_id',coalesce(latest,a.working_revision_id),'unchanged',latest IS NULL);
 INSERT INTO resources_cms.command_receipts(command_id,actor_id,namespace,target_id,fingerprint,result) VALUES(p_command_id,actor,'owner-import',aid,fp,answer);
 RETURN answer;
END $import$;
REVOKE ALL ON FUNCTION resources_cms.owner_import(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role,resources_cms_runtime;
GRANT EXECUTE ON FUNCTION resources_cms.owner_import(uuid,jsonb) TO authenticated;
-- Ownership and grants for existing immutable holds are applied by the parent proposal.
