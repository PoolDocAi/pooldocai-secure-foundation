BEGIN;
GRANT resources_cms_command_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
GRANT CREATE ON SCHEMA resources_cms TO resources_cms_command_owner;
SET LOCAL ROLE resources_cms_command_owner;
CREATE OR REPLACE FUNCTION resources_cms.owner_storage_member(p_roles text[]) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT EXISTS(SELECT 1 FROM resources_cms.members
 WHERE user_id=coalesce(nullif(current_setting('request.jwt.claim.sub',true),''),
 (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub'))::uuid
 AND active AND role=ANY(p_roles))
$$;
RESET ROLE;
REVOKE CREATE ON SCHEMA resources_cms FROM resources_cms_command_owner;
REVOKE resources_cms_command_owner FROM postgres GRANTED BY postgres;
COMMIT;
