-- REVIEW ONLY. Transaction-native exact reversal for this uncommitted candidate.
-- Must run in the SAME transaction/session started by mfa-aal2-review.sql,
-- before its terminal ROLLBACK. No post-COMMIT rollback is authorized/offered.
-- No function definition/ACL reconstruction and no manual privilege cleanup.
ROLLBACK TO SAVEPOINT mfa_candidate_start;
DO $restore$ BEGIN
 IF pg_temp.mfa_snapshot() IS DISTINCT FROM (SELECT state FROM mfa_start_state) THEN
   RAISE EXCEPTION 'Exact baseline restoration failed'; END IF;
 IF pg_has_role('postgres','resources_cms_command_owner','SET') OR pg_has_role('postgres','resources_cms_command_owner','USAGE')
   OR has_schema_privilege('resources_cms_command_owner','resources_cms','CREATE') THEN RAISE EXCEPTION 'Temporary privilege residue'; END IF;
END $restore$;
SELECT 'PASS: exact captured catalog/ACL/owner/membership/policy baseline restored' AS rollback_evidence;
ROLLBACK;
