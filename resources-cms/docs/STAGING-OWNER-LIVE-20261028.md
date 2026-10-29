# Private Staging owner checkpoint — October 28, 2026

Owner-authenticated hosted browser acceptance completed on the existing protected CMS owner-review deployment. This is Staging owner access, not public Production release. No Production database, domain, deployment protection or content-release authorization changed.

## Delivered

- Verified confirmed Auth identity matches the active CMS owner membership; no account identifier or credential is recorded here.
- Hosted editor saved the existing lifecycle-test draft, displayed its immutable revision history, and restored its original summary with a subsequent private revision. No test revision was published.
- Imported the 31 numeric approved resources (01–33 excluding 13 and 30) through the authenticated trusted catalog. Existing 03 and 08 were retained; 01 became a private working revision while its historical live snapshot remained intact. Asset and publication holds were preserved. Private source envelopes and manuscripts remain outside this public repository.
- Created the missing private WebP-only CMS media bucket with caller-owned orphan cleanup, registered-object immutability and restrictive bucket boundaries. No anonymous object-read policy was added.
- Fixed managed Storage identity lookup without granting Auth schema/table privileges to the internal helper owner. The helper reads the same verified request subject settings used by the installed auth.uid function.
- Replaced the incorrectly escaped registration filename regex with exact object-key/UUID equality. Existing published-pointer archive protection was preserved by changing only the key predicate in the installed function definition.
- Hosted synthetic PNG upload passed decoding, canonical 44-byte WebP storage, metadata registration and authenticated image display. The test image was archived; it is not approved editorial imagery and has no rights release.

## Recorded Staging migrations

1. `20261028185341` resources_cms_private_owner_storage — exact applied transaction in private-owner-storage-hosted.sql.
2. `20261028191418` resources_cms_storage_request_identity — private-owner-storage-identity.sql.
3. `20261028191527` resources_cms_media_canonical_object_key — media-canonical-object-key.sql.

Apply these neither to Production nor again to Staging. Failed setup attempts rolled back and produced no migration entry. private-owner-storage.sql is the consolidated private policy fragment for disposable tests, not a fourth applied migration. Temporary CREATE and SET-role privileges were revoked. Existing company-manual Storage policy fingerprint remained unchanged.

## Validation

55 targeted Node tests passed: login, recovery, serverless routes, media rights/RLS, image handling, production adapters and owner revision release. Added canonical path acceptance/mismatch rejection and private Storage tests with no internal Auth schema access. SQL fixtures require LF checkout on Windows because local fixture guards are line-sensitive; historical migration content was not edited.

Hosted and database evidence: 33 articles, 57 revisions, 32 publication holds, 10 dependency blocks, two existing published snapshots, zero active diagnostic knowledge grants, archived synthetic media. Existing released snapshots remain separate from working draft state. No new article publication occurred.

## Remaining limits

- Scheduled publication is not enabled: no pg_cron installation/job, and the current held-revision workflow requires a fresh owner release. Live scheduler execution was rejected by automatic approval review because it could publish; it was not run.
- Migration history still records the original isolated-v1 gate plus these three repairs; existing commands/owner-publishing changes predate this checkpoint without separate migration records. Do not replay old proposals to fill that gap.
- Folder/taxonomy/analytics migrations remain independently gated. No full browser/device, recovery-email delivery or new public publication acceptance is claimed.
- This repair changes the live Staging database used by the existing preview; no replacement Vercel deployment was needed. Root branch guard disables automatic deployment to the unrelated core project.

Public Production rollout and exact-revision releases still require explicit owner authorization. PDFs remain disabled.
