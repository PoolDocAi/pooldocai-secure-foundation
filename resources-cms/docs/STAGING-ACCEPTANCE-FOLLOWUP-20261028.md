# Staging acceptance follow-up — October 28, 2026

Verdict: partial acceptance. Production release remains blocked.

## Source and changes

Read the owner's local `deliverables/CMS-STAGING-ACCEPTANCE-20261028.md`.
GitHub PR #27 was open, draft and unmerged at 3d35f7cea9ad463ad91e9e2e1786a49314de51aa.
Vercel dpl_VvkU85xdUwREkfKKs8bC7W8CTEK4 was READY at that SHA with the requested private branch alias.

The dashboard now prefers the recorded email, then labels a non-null historical actor as **Recorded user**. Only an actorless `scheduled_publish` event is labeled **Scheduler**; other actorless events are **Unattributed event**. It does not infer historical ownership from current membership, resolve users through privileged Auth APIs, or change audit/authorship data. Regression coverage executes the shipped dashboard renderer, tests HTML escaping, user/scheduler/unknown cases and input immutability. The regression is included in the PR CI workflow.

## Hosted evidence at the original deployed SHA

- Existing authenticated owner session loaded all seven CMS sections. No credentials were entered.
- Uploaded one explicitly disposable 96×64 color-block PNG, with alt text `Disposable staging acceptance color block; no article use`. Stored fixture ID: fb43be87-365b-4bfc-ae10-d6e08e44ae0e. Decoder stored image/webp, 90 bytes. The media-card image reported complete=true and naturalWidth=96, naturalHeight=64; its displayed alt matched. Direct authenticated image navigation displayed a 96×64 image document.
- No image rights approval, article reference or publication was created. `public_media(fixture_id)` returned null. Both resources-cms-media and company-manuals buckets remained private.
- Archived this fixture through the CMS. UI returned **Image archived** and the empty library. Database confirmed archived=true, active_media=0 and zero rights reviews for the fixture. Bytes and the archived metadata/audit evidence are retained; no permanent purge was attempted. Reload of the old image produced a browser HTTP-response failure, but no exact status was exposed, so a hosted 404 is not claimed.
- Verified dashboard, content library, taxonomy, media, SEO, knowledge and settings at 320, 390, 768 and 1440px. Each page's exact heading was awaited before measurement. All 28 measurements had scrollWidth=clientWidth; no completed image had zero naturalWidth. Mobile navigation opened and selected sections. Media screenshots were visually inspected at normal and 320px widths. This is a Chromium in-app-browser pass, not Firefox/WebKit or a complete accessibility/visual audit.
- Captured warning/error console records were empty during these sampled flows. No authenticated HAR/status inventory was available; full network acceptance remains open.
- Independent credential-free shell HTTP GET `/api/dashboard` returned 302 to Vercel SSO with no-store and noindex. This proves the perimeter denial, not the application's own cookie-free 401 behind that perimeter.
- Connected Vercel protected fetch of `/api/dashboard` failed `deployment_authentication_required` after its share-link redirect. Its 401 is an access-tool failure, not application-denial evidence. No protection setting was changed.
- Cleanup verification: 31 held drafts, 32 holds, 57 revisions, zero scheduled timestamps, zero active media. No owner article, revision, hold, release, schedule or production data was modified. Staging changes were limited to the disposable media register/archive and their audit records.

An early hash-only responsive navigation sample retained stale page headings; it was discarded. The recorded pass above used actual navigation controls and exact-heading waits.

## Local verification

- 19 tests passed: attribution renderer, login failure handling, private media validation, rights/Storage boundary checks and production HTTP/PostgreSQL adapter workflow.
- 38 further tests passed: production adapters, serverless routes, owner publication, release reachability, migration static checks and disabled Production assembly.
- 12 gate/navigation tests passed, including the attribution test repeated in this focused group.
- `tests/postgres-commands.mjs` and `tests/postgres-storage.mjs` passed. These cover owner/editor/reviewer/viewer/nonmember and anon authorization, customer-row RLS separation, private Storage scope, publication revocation and rollback in a local PostgreSQL engine. Their documented Supabase role-harness emulation is not a hosted Auth-session test.
- `git diff --check` passed.
- Existing broad `tests/browser.mjs` could not start: the review checkout lacks `examples/existing-resources.json`. No replacement owner content was invented. This missing private input remains a test-packaging prerequisite.

## Remaining acceptance and precise prerequisites

1. Use separate authenticated Staging sessions for an editor, reviewer, viewer and a normal non-CMS user. Only the owner session is currently available. Have the owner provide/provision these through the approved membership workflow; do not send passwords or session tokens in chat. Keep these sessions isolated from the owner browser session. Against disposable synthetic records only, verify editor save/review allowed and publish/knowledge-approve denied; reviewer save denied and authorized knowledge review allowed; viewer reads allowed and all mutations denied; nonmember private reads/writes denied. Capture HTTP outcomes and before/after counts. Owner publication tests must remain local or separately authorized; no hosted publication is authorized here.
2. With Vercel authentication retained but no CMS cookie, verify `/api/me`, `/api/dashboard`, private preview and private media return application denial and reveal no content. Capture a sanitized network inventory of API/media/static requests, content types, private no-store headers, source/asset origins and any unexpected failures. Never include cookies, signed URLs or tokens in evidence. An available authenticated Vercel CLI/session is required because the connected protected-fetch path failed.
3. Run full editor/history/preview layout and keyboard/accessibility checks and Firefox/WebKit coverage using the approved complete test package. Restore the missing private fixture through its existing source process; do not manufacture a substitute for the existing broad harness.
4. Cross-tenant hosted Storage requests still need the separate nonmember/tenant sessions above. Private buckets, public_media=null and local RLS tests do not alone prove that end-to-end case.
5. Recheck attribution on the new private preview after the PR branch deployment is READY and source matched. CI results must correspond to the new commit; previous green checks are insufficient.

## Production backup/restore plan — prepare only

Before any production migration, record the Production schema/migration baseline and owner-approved recovery objectives. Use the existing complete editorial export plus private Storage byte backup, including owner releases/holds, navigation, rights records, checksums and relevant configuration. Encrypt the bundle with an owner-controlled key, store it in restricted backup storage separately from its key, and record checksums, timestamp, scope and the recovery operator. Never commit the bundle or credentials.

Restore into an isolated empty nonproduction project with outbound processing and public delivery disabled. Verify all table/media counts, hashes, immutable revisions/audit/provenance, holds and rights records. Prove restored content remains private and unscheduled, release policy disabled, knowledge grants inactive and no outbox delivery. Exercise owner sign-in and private media read, plus anonymous/nonmember denial. Record elapsed restore time and signed owner review of the evidence. Only a recoverable encrypted backup with a demonstrated restore satisfies this gate. No production backup, migration or restore was performed in this follow-up.

## Public released-snapshot integration plan — prepare only

Use the complete approved marketing source in an isolated preview. Pin the CMS source commit and Staging destination explicitly. Render only public_index/public_article/public_media snapshots, never working revisions. Compare HTML, canonical URL, structured data, sitemap, published_revision_id, media-rights eligibility and historical released-hold mapping. Verify draft/held/synthetic slugs return 404, current held working revisions never appear, private bytes never enter bundles, and revocation is honored without stale caching. Test routing/redirects, mobile/desktop rendering, error handling and origin isolation. Retain sanitized network evidence and CI/source attestation. Obtain owner acceptance plus the backup/restore proof before a later release/cutover request. No alias cutover, production migration or publication is part of this plan.
