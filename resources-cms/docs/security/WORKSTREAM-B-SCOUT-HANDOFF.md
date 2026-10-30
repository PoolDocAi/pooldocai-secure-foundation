# Workstream B V3 helper-only review return — 2026-10-30

Harbor coordinator; Scout independent reviewer. Implements review corrections
from Issue #30 comments 6528794213 and 6528904537. Successor executor ACK 6529332306.
Release NO-GO; no push, hosted SQL/rehearsal, deploy or MFA activation.

## Exact source continuity

Same checkout `/workspace/scratch/9db0e3459aad/cms-auth`, existing branch
`security/cms-totp-owner-2fa-stage`, HEAD `6c1155d8afff34d621076d2247a44cafabe913f9`.
The 19-file V2 local state matched its prior manifest before V3 editing.
Prior patch `9ab60395601e97831ab73d08fb4bddec3d53cffac090665371f072c0695be95e`,
source-set `3ccfd5e5679a81cd18986f6217d512cdb1ec12881170a7bb1302eb751770cea7`,
bundle `37b081463d3a068e76777b04a50baeaf397a5df071f50427a74a4cf7c236f623`
remain preserved in ../workstream-b-review. No competing branch or commit.
V2 patch 1cde551b170d2d5682950947a363ac3b49e9444ebfc65a1fa7916b80f97eeabe
and V2 bundle ef2adb0be6c1e73b7564c95637b40f1942c8b16e58f4a848a050abe23623a67f
remain unchanged in ../workstream-b-review-v2.
Result is the same HEAD plus uncommitted changes; complete replacement patch,
changed-file hash manifest, logs and new bundle are in ../workstream-b-review-v3.
The new patch applies to the original HEAD, not on top of the first patch.

## Corrected Auth capability boundary

No Auth schema, table or column grants are proposed. In particular this package
never asks postgres to grant Auth USAGE, never invokes supabase_admin, and never
adds a role to an existing privileged Auth role.

Two static SQL/PLpgSQL SECURITY DEFINER functions remain owned by postgres:
`mfa_identity(boolean,boolean)` and `mfa_storage_subject()`. The first reads only
the current verified caller's session and bound TOTP factor, returning a UUID
or NULL; it accepts no target user/session/factor/company argument. The second
returns only auth.uid() for the gate-OFF Storage compatibility path. Both have
empty search_path, fully qualified names, no dynamic SQL or Auth writes. PUBLIC,
anon, authenticated and retired runtime EXECUTE are revoked. Only the existing
NOLOGIN/NOINHERIT/NOBYPASSRLS CMS command-owner role receives EXECUTE. Other
private helpers remain command-owner-owned and cannot read Auth relations.

This is a bounded capability design using an existing trusted function owner,
not a newly created least-privilege Auth role. postgres itself remains broadly
privileged; its two new function bodies are part of the trusted computing base
and require Scout review. It was not possible to give a new reader Auth USAGE
using the demonstrated grant authority; no such grant path is fabricated.

| Required privilege/capability | Existing holder / legal authority | Proposed change and reversal |
| --- | --- | --- |
| Auth schema USAGE | postgres already holds it; supabase_admin owns schema | NONE. No grantor needed, no reversal needed. |
| Auth sessions SELECT on id,user_id,aal,factor_id,not_after | postgres already has SELECT WITH GRANT OPTION | NONE. Existing table/column ACLs preserved byte-for-byte in snapshot. |
| Auth factors SELECT on id,user_id,status,factor_type | postgres already has SELECT WITH GRANT OPTION | NONE. No transfer to command-owner or API roles. |
| auth.jwt()/auth.uid() EXECUTE | postgres must already hold it | Hard precondition; STOP if absent, no new grant. |
| resources_cms CREATE for reader creation | postgres must already hold it | No new postgres privilege. |
| Reader EXECUTE to command-owner | postgres, owner of the two new reader functions | Explicit bounded function grant; transaction rollback removes new functions/grants exactly. |
| New command-owned helper EXECUTE to API roles | command-owner, after guarded SET ROLE | Granted by that legal function owner, not assumed postgres INHERIT. Rollback removes the new objects/grants. |
| Existing Storage helper replacement | command-owner owns those functions | CREATE OR REPLACE under SET LOCAL ROLE; original owner/ACL retained, definitions restored by native rollback. |
| Storage policy DDL | storage.objects remains managed Storage-admin-owned | NONE. No owner-equivalent authority, SET, membership or grant is required. |

Reader dependencies are hard-checked before changes. No hosted request was used
to supplement Scout's ACL evidence; current hosted applicability remains for
independent preflight review. If a privilege/owner differs, the candidate aborts.

## Guarded PG17 ownership mechanics

The proposal uses the project's established grantor-specific sequence:

1. Require non-superuser current_user postgres, exactly one managed command-owner
   membership granted by supabase_admin with ADMIN true, INHERIT/SET false;
   no effective postgres SET/USAGE and no command-owner schema CREATE/Auth USAGE.
   Require safe role attributes, actor owner postgres and Storage-helper owners
   command-owner. Verify reader prerequisites and read-only existing-policy composition/digest.
2. `GRANT resources_cms_command_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres`.
3. Temporarily grant CREATE on resources_cms to command-owner. Assert exact
   temporary grantor row/options and effective CREATE before any ownership move.
4. Create new functions; leave Auth readers postgres-owned. ALTER the remaining
   new helpers to command-owner while SET/CREATE prerequisites hold. Existing
   actor remains postgres-owned. Replace Storage helpers under SET LOCAL ROLE
   command-owner. Issue function ACL changes as their actual owners. Return to
   SET LOCAL ROLE postgres explicitly (no assumed inherited owner privileges).
5. REVOKE command-owner schema CREATE; REVOKE only the membership row GRANTED BY
   postgres with RESTRICT. Never touch the managed row. Hard-assert no effective
   SET/USAGE/CREATE, and exact original memberships, schema ACLs and Auth ACLs.
   Gate must still be false. No intermediate COMMIT or swallowed exception.

An error aborts the transaction; the reviewed transaction ends in ROLLBACK.
No temporary privileges persist on successful completion or rollback. Neither
CASCADE nor a new ownership-transfer mechanism is used.

## Exact rollback proof and scope

Before a savepoint, `pg_temp.mfa_snapshot()` captures exact catalog JSON for:
Auth/resources_cms/storage schema owner+ACL; storage.objects relation owner/ACL/RLS; all Auth table/column ACLs+owners; all CMS
function definitions, owners and EXECUTE ACLs; all pg_auth_members rows/options/
grantors; all CMS/Storage policies; CMS relation ACL/owner/RLS state.

`mfa-aal2-rollback-review.sql` rolls back to that savepoint and asserts the whole
snapshot equals the captured baseline, including original NULL ACLs and OIDs. Storage policies and relation state
also compare exactly equal before and after the forward candidate, which
performs no Storage policy/table/grant DDL.
It explicitly asserts no temporary SET/USAGE/schema CREATE remains, then ends
with ROLLBACK. No manually reconstructed ACL, hand-coded actor definition,
manual cleanup or CASCADE. The harness proves both normal candidate reversal
and an injected error while temporary SET/CREATE are present. Rollback restores
actor/helper definitions, owners, ACLs and Storage policies together.

This is exact rollback of the **uncommitted review/rehearsal transaction** only.
It is not a post-COMMIT reversal or a deployable forward migration. No committed
migration/activation is offered or authorized. Any later committed rollout and
post-commit recovery design need separate review; do not convert the terminal
ROLLBACK to COMMIT on a hosted database. The behavioral harness does so only
inside its disposable in-memory instance after separately proving exact rollback.

## AAL1 Storage-helper exposure closed

owner_storage_member(text[]) now branches on enforcement: when ON it derives
only a live AAL2/session/factor-bound UUID through the private reader. At AAL1
it returns false regardless of supplied role arrays. owner_storage_orphan_object
uses a CASE fence: if membership fails it returns false before the orphan query.
AAL1 therefore cannot use either exposed helper to distinguish membership or
registered-versus-orphan state, even after the five-minute bootstrap period.
Both remain callable for legitimate Storage RLS. When OFF, the private subject
reader preserves the old caller-UID semantics without command-owner Auth USAGE.
The existing restrictive CMS bucket fences and UPDATE prohibition remain; no
company-manual or other bucket policy is rewritten.

Direct SQL calls use the same function/argument privileges as PostgREST RPCs,
not a mocked JavaScript predicate. Tests cover role arrays, canonical orphan
keys, expired bootstrap, AAL1 Storage denial and AAL2 helpers/private Storage.
They do not establish actual hosted PostgREST/Storage transport behavior.

## Preserved authorization behavior

Caller-only zero-argument AAL1 membership bootstrap; five-minute JWT-iAT window;
no privileged fallback; nonanonymous live session/user binding; JWT and live
session AAL2; current verified bound TOTP factor; JWT expiry/not_after; current
CMS membership; fail-closed server/database mismatch; pending logout revocation;
existing restrictive Storage-policy/helper composition; gate OFF by default; no activation command.

## Validation and fixture limits

Node v24.22.1. No dependency/lockfile change. Fixed a test-only clock race: synthetic logout
JWT expectations now share one timestamp; no production authorization change. Focused tests, production suite,
syntax, whitespace, patch-application and broad baseline comparison are returned
with exact commands/results in the review bundle and Issue #30. Final focused
CI command: 55/55 pass; npm run test:production: 30/30 pass. Broader suites:
21 pass / 10 fail (core), 1 pass / 2 fail (integration), identical to clean baseline.

The database fixture models a bootstrap role named supabase_admin and a distinct
non-superuser postgres. It sets up the fixture's preexisting Auth privileges only
during local setup, then runs the corrected candidate **without rewriting its
hard guards, grant/ownership sequence, ACL statements or function bodies**.
Legacy baseline setup normalizes schema-wide function ACL operations by actual
owner because those old statements are not the candidate under review. Fixture
administrative seed writes use test_root; candidate execution uses postgres.
The fixture storage.objects owner is a distinct simulated supabase_storage_admin;
postgres has no MEMBER/SET/USAGE/ADMIN path to it. A counterfactual policy DDL
request by postgres is denied; the complete V3 candidate still succeeds.
No test-only admin setup action is a proposed hosted grant path.

The 12 broader failures remain missing approved/private fixtures or scripts,
independently confirmed by Scout as baseline debt. No approved content was
fabricated. Baseline-comparison.json is preserved; corrected comparison reruns
match the clean original HEAD archive's failure titles/counts.

## V3 policy contract and regression evidence

V2-to-V3 delta: remove the new resources_cms_mfa_boundary policy, remove the
mfa_storage_allowed helper and Storage-owner authority precondition; retain the
accepted Auth/caller/session/transfer/Storage-helper/rollback/CI corrections.
The bundle includes a separate V2-to-V3 diff as well as the full replacement
patch against the unchanged remote baseline.

mfa-storage-policy-contract.sql is read-only. Its identical query is embedded
in preflight and in the candidate's pre-mutation hard guard. It verifies seven
expected CMS policies by command, permissive/restrictive mode, role OIDs, and
complete pg_get_expr expression equality with whitespace-only normalization:

| Policy | Required expression |
| --- | --- |
| restrictive SELECT boundary | non-CMS bucket OR owner_storage_member(owner/editor/reviewer/viewer) |
| permissive CMS member SELECT | CMS bucket AND the same member helper |
| restrictive INSERT boundary | non-CMS bucket OR (own owner_id AND orphan helper) |
| permissive CMS INSERT | CMS bucket AND own owner_id AND orphan helper |
| restrictive DELETE boundary | non-CMS bucket OR (own owner_id AND orphan helper) |
| permissive CMS DELETE | CMS bucket AND own owner_id AND orphan helper |
| restrictive UPDATE boundary | non-CMS bucket in both USING and WITH CHECK |

It also checks table RLS, both helper owners/definer attributes, expected
anon/authenticated EXECUTE paths, no PUBLIC EXECUTE, and no additional policy
referencing the CMS bucket/helpers. A SHA256 digest binds the complete policy
inventory, including unrelated/global policies, to a separately reviewed
baseline in resources_cms.review_storage_policy_digest. Missing/mismatched
binding aborts. This review-only GUC is an executor preflight parameter, not an
application authorization control or permission to execute SQL. Do not copy
an unreviewed live digest blindly: Scout/Harbor must review/bind it first.

Expressions are exact conservative expectations inferred from Harbor's verified
composition, not a newly claimed live catalog digest. Any formatting/definition/
role difference stops the candidate for independent review; no permissive
substring matching or silent policy rewrite is used. Storage ownership is
identified read-only and never used as a required privilege path.

Synthetic tests exercise the existing seven policies, not a new permissive
blanket or MFA fence. ON/AAL1: SELECT/INSERT/DELETE/UPDATE denied and helpers
false for role/orphan/registered probes. ON/AAL2: authorized SELECT, owner/editor
owned-orphan INSERT/DELETE succeed, wrong-owner/viewer writes fail, UPDATE
remains denied. OFF/AAL1: compatibility read/orphan writes work, UPDATE denied.
Unrelated company-manual/other-private policies retain own-row scope and foreign
row denial with either AAL, and all policy definitions stay unchanged.
Policy bypass-expression drift, unexpected CMS policy and missing digest are
negative tests. Static assertions reject executable candidate Storage policy/
table-owner DDL or managed Storage-role grants, while allowing such strings
only in test-only counterfactual fixtures.

## CI and later push activity

The existing nondeploying PR workflow now runs the focused MFA/bootstrap/database
suite **and npm run test:production**, with syntax checks for auth.mjs,
supabase-data.mjs, mfa.mjs, app.mjs and serverless.mjs. contents:read, pinned
checkout/setup-node, persist-credentials:false, no hosted secrets/deploy steps.
A future update to this existing PR matches its paths and is expected to run CI.
No CI run was dispatched here. Other known Supabase/main security deployment
workflows are main-filtered; the older CMS review workflow targets another branch.

Remote remains unpushed. Root/nested Vercel branch exclusions remain false, but
are not proof every connected project/dashboard override/external hook is inert.
Historical PR31 previews exist. Render live filters and external hooks remain
unverified. Treat Vercel/other hosting activity as possible. Scout acceptance
and Harbor's separate hook certification precede any Owner push request.

## Remaining mandatory hosted negatives / security gaps

Do NOT claim /admin.html is secured from local tests. Later authorized hosted
acceptance must negatively test /admin, /admin/, **/admin.html**, preview, media,
refresh, search and compatibility routes, plus Vercel SSO/rewrite/gateway bypass.
Also unproven: actual AAL1/2 direct RPC and Storage transport identities, current
hosted owner/ACL fingerprints and dependency closure, TOTP replay/expiry and
throttling, backup-factor/recovery ceremony, immediate stale-token denial after
factor/session/membership removal, Auth inactivity cleanup and performance/load.
Postgres-owned readers deserve independent least-capability review. Core CMS
membership is a global editorial allowlist, not a new company-tenancy model.

No hosted SQL (including BEGIN/ROLLBACK), MFA enrollment/enforcement, Production,
publication, five-410 changes, Formspree/DNS, PR14, deployment or paid changes.
STOP after returning this artifact. Scout re-review required. Release NO-GO.
