# Production readiness preparation — October 28, 2026

Preparation only. No Production connection, backup, restore, deployment, policy
transition, publication, merge or cutover was executed in this continuation.
Production is `owfeebydlyacssqpnmkq`; Staging is `rzkgmvyyeclrpomrlyft`.
Older free-tier promotion notes are historical evidence, not authority to rename
Staging, target Production, activate a same-ref exception or enable publication.
2FA is paused. Scheduling stays disabled; PDFs stay off.

## Hosted authorization acceptance packet

Current read-only Staging discovery: one active owner member; no editor/reviewer/viewer
members. No reserved-domain (`example.test` / `.invalid`) Auth users were found;
this does not claim absence of all possible test users. No isolated sessions were supplied.
The connector has no supported Auth admin provisioning tool. Do not fabricate Auth
users, memberships or JWTs through SQL, or borrow the owner session.

Provision through the approved identity/membership workflow: separate Staging editor,
reviewer, viewer, ordinary authenticated nonmember, and a second-tenant test user
with synthetic tenant-owned records and private objects. Identify the disposable CMS
article/media IDs and tenant A/B record/object IDs. Keep sessions in distinct browser
contexts, credentials outside chat/source/evidence, and use only Staging.

| Identity | Positive checks | Negative checks |
| --- | --- | --- |
| Editor | Private read; save and submit disposable draft for review | Publish; knowledge approval; cross-tenant data/object access |
| Reviewer | Private read; permitted knowledge review on explicitly eligible synthetic revision | Editorial save; publication; cross-tenant data/object access |
| Viewer | Private read | Every editorial/media/knowledge/publication mutation; cross-tenant access |
| Authenticated nonmember | Auth identity succeeds | CMS dashboard/article/history/preview/media reads and every mutation |
| Tenant B synthetic user | Own-tenant permitted row and Storage read | Tenant A row ID/object path read and write; CMS access without membership |

Use real authenticated HTTP calls with normal Origin and CSRF for mutations so a
CSRF failure cannot masquerade as a role denial. Verify rejected writes produce no
database/audit/rights/release changes. If prerequisites for knowledge approval require
owner rights or release actions, stop that positive case and record the unmet
prerequisite; do not publish or approve rights to construct coverage. Keep knowledge
delivery disconnected; revoke/archive only disposable fixture state through normal
workflows. Record expected/actual statuses, sanitized response classification,
fixture IDs and before/after counts; never record headers carrying credentials.
Direct Supabase RLS/Storage tests require each user's real session too; privileged
connector SQL cannot establish user-session isolation.

## Network packet

Target only matching READY deployment `dpl_EA8VscFYwjXevhdJ51Yov5eV8VwJ`, commit
`365e4ff0ca1655464ef4a480765530c77976df58`. Retain Vercel Authentication in a fresh
context without `__Host-pooldocai-cms-access`, refresh or csrf cookies. Use the existing
Vercel identity through an authenticated CLI or independent browser session. No such
session is currently exposed. Do not disable protection or use a CMS cookie as the
perimeter credential. Application denial must come from the CMS, not an SSO redirect.

Probe `/api/me`, `/api/dashboard`, actual private preview and private media routes
from the deployed source, first without CMS cookies. For full editor/history/preview/
image/static waterfalls use an isolated permitted synthetic CMS identity context.
Capture status, method, origin + pathname only, resource type, content type, timings,
private cache headers and redirect classification. Strip query strings, cookies,
authorization/CSRF headers, request/response bodies and signed object URLs. Capture
console errors and failed requests with the same redaction; do not export raw HAR.
Check unexpected external origins, private responses/cache behavior, missing assets,
incorrect MIME, redirect loops and unhandled errors. This packet is not yet executed.

## Encrypted recoverable backup and restore packet

1. Before any later execution, name the operator, owner-controlled encryption
   recipient/key custodian, restricted offsite destination, retention, approved RPO/
   RTO, and separate empty recovery project. The recovery destination must equal
   neither Production nor the occupied Staging project. Confirm schema/version and
   migration baseline with a read-only source connection at that later time.
2. Inventory the full application database, Auth identity mapping, CMS editorial and
   recovery tables, original releases and holds, immutable revisions/audit/provenance,
   rights, configuration, navigation (if present), bucket policies and all recoverable
   Storage bytes. Supabase DB backups contain Storage metadata, not object bytes:
   https://supabase.com/docs/guides/platform/backups . Inventory core application
   Storage such as company manuals as well as CMS media when claiming full-project
   recovery. Keep credentials and configuration secret values out of manifests.
3. Existing `backup-production-free-plan.ps1` produces an unencrypted logical archive;
   archive listing/decompression is not restore proof. Do not run it unchanged as an
   encrypted-backup solution. Prepare authenticated encryption to an owner-controlled
   recipient (for example age), test tool versions/round-trip on disposable bytes,
   check native exit codes and incomplete outputs, and use restricted temporary disk
   if plaintext staging is unavoidable. Windows secure deletion is not assumed.
4. Existing `exportCMS` uses a repeatable-read transaction, but Storage exports are
   separate. Establish a consistent capture boundary and compare inventory/hash
   manifests before and after capture; abort/retry if objects change. Existing
   `exportMedia` omits archived objects, so it cannot prove a complete recoverable
   byte archive. Include archived objects required by historical releases and other
   recovery records through a separately reviewed export path. This is an open gate.
5. Hash every object and archive; put detailed manifests inside encryption. Record
   encrypted artifact SHA-256/size/time, source commit/migration baseline, object and
   row totals and custody metadata in sanitized evidence. Keep key separately.
   Retrieve and decrypt from the offsite copy to prove key/storage recovery.
6. Rehearse in a quarantined empty nonproduction project with public API delivery,
   schedules, PDFs, email/webhooks and outbox workers disabled. Recreate managed
   roles/extensions/Auth/Storage with the version-compatible documented procedure;
   do not blindly replay a whole Supabase dump into managed schemas. Verify immutable
   originals first, then apply documented quarantine transformations. `restoreEmptyCMS`
   intentionally clears published pointers/schedules, adds holds, disables release
   policy/knowledge grants and changes some outbox/navigation state; it is a safe
   editorial recovery mode, not an exact whole-project restore. Preserve the original
   encrypted evidence and report those transformations explicitly.
7. Verify table/object counts and hashes; identity mapping; audit/revision/rights/
   release integrity; no public snapshots/private bytes exposed; no schedules/outbox
   delivery; permitted recovery sign-in/media read and anonymous/nonmember denial.
   Prove a separate rollback/retry does not overwrite occupied targets. Record elapsed
   restore time, observed RPO/RTO, deviations and owner acceptance. Only this demonstrated
   recovery, not a checksum alone, satisfies the gate.

## Published-snapshot adapter packet

Use existing `src/production/public-delivery.mjs` and the complete owner-approved
marketing source, whose provenance is recorded in `marketing-review/CMS-DELIVERY-HANDOFF.md`.
The partial GitHub mirror is insufficient. Prepare an isolated protected Preview
with explicit Staging ref/HTTPS origin and immutable source SHA; no Production values,
same-ref promotion exception, alias or public domain. Keep runtime delivery disabled
until this preview is explicitly authorized. No new publication is authorized.

Read only existing authorized `public_index`, `public_article`, `public_redirect`,
`public_media` RPC projections. Compare historical released revision/checksum to
rendered HTML, canonical/structured data, sitemap, redirects, Hub/collections and
media-rights projection. Working held drafts and synthetic slugs must remain 404.
Check historical releases separately from newer held revisions; a hold must not
silently cause a different working revision to render. Verify private media objects
never enter source/bundles and no CMS cookies/admin keys are forwarded.

Prepare local fault-injection for upstream failures, null/revoked projections and
cache behavior. Actual hosted withdrawal needs a separate expressly authorized
disposable release; do not mutate the two historical releases to simulate it.
Confirm cache headers at browser/CDN, no stale static fallback, controlled upstream
failure, legal/homepage preservation, mobile/desktop and origin isolation. Record
network/source/CI attestation and obtain owner acceptance after restore proof before
any later Production release request. Existing local adapter passes and historical
hosted rehearsal evidence do not close the remaining current hosted gates.
