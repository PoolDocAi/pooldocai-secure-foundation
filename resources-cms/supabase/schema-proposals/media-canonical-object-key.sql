BEGIN;
GRANT resources_cms_command_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
GRANT CREATE ON SCHEMA resources_cms TO resources_cms_command_owner;
SET LOCAL ROLE resources_cms_command_owner;
DO $repair$
DECLARE original text; corrected text;
BEGIN
 original:=pg_get_functiondef('resources_cms.media_command(uuid,text,jsonb)'::regprocedure);
 corrected:=regexp_replace(original,'\(p_payload->>''objectKey''\) !~ ''[^'']+''','(p_payload->>''objectKey'') IS DISTINCT FROM (''images/''||(p_payload->>''id'')||''.webp'')');
 IF corrected=original THEN RAISE EXCEPTION 'Expected media registration key guard missing'; END IF;
 EXECUTE corrected;
END $repair$;
RESET ROLE;
REVOKE CREATE ON SCHEMA resources_cms FROM resources_cms_command_owner;
REVOKE resources_cms_command_owner FROM postgres GRANTED BY postgres;
COMMIT;
