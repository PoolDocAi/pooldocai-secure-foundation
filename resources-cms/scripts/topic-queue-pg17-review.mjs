import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

// REVIEW-ONLY assembly. Does not connect, deploy, apply SQL or change history.
const sourceUrl=new URL('../security/staging-topic-queue-candidate.sql',import.meta.url);

const prefix=String.raw`
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
`;

const suffix=String.raw`
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
`;

export function assemblePg17TopicQueueSql(candidate=readFileSync(sourceUrl,'utf8')) {
 if(typeof candidate!=='string'||
   (candidate.match(/^BEGIN;$/gm)||[]).length!==1||
   (candidate.match(/^COMMIT;$/gm)||[]).length!==1||
   !candidate.includes('ALTER FUNCTION resources_cms.topic_queue_list() OWNER TO resources_cms_command_owner;')||
   !candidate.includes('ALTER FUNCTION resources_cms.topic_queue_command(text,uuid,integer,jsonb) OWNER TO resources_cms_command_owner;'))
   throw Error('Unreviewed topic SQL source; refuse automatic packaging');
 return '-- REVIEW ONLY, NOT AN APPROVED MIGRATION OR SQL EXECUTION.\n'+candidate
   .replace(/^BEGIN;$/m,'BEGIN;\n'+prefix)
   .replace(/^COMMIT;$/m,suffix+'\nCOMMIT;');
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
 if(process.argv.length!==3||process.argv[2]!=='--print-review-sql'){
   process.stderr.write('Usage: node scripts/topic-queue-pg17-review.mjs --print-review-sql\n');
   process.exitCode=2;
 }else process.stdout.write(assemblePg17TopicQueueSql());
}
