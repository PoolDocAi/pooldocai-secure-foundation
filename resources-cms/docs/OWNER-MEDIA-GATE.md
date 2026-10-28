# Owner image delivery — local completion and hosted gate

Target for any separately approved remote execution: **Staging `rzkgmvyyeclrpomrlyft` only**. No bucket, policy, Auth, credential or database change was executed for this work.

## Implemented and tested locally

`PrivateStorage` uploads only a server-decoded JPEG/PNG/WebP, re-encoded as metadata-free WebP. Empty, oversized, malformed, SVG, PDF, unsupported formats, animated images, over-dimensioned images and oversized canonical outputs are rejected. Immutable object names are `images/<UUID>.webp`; uploads do not upsert. A replacement is a new object plus a draft reference change, preserving prior published revisions and rollback images. The adapter forwards only the caller token and publishable key. Anonymous operations are GET-only; malformed UUIDs, path traversal and unsupported methods never reach Storage.

The media gateway now uses **no-store** for public bytes as well as private bytes and 404s. Its previous hour-long CDN lifetime plus 24-hour stale allowance could retain a withdrawn image. Each new request must recheck current publication eligibility. There is no permanent public object URL or long-lived signed download link in this delivery contract.

`tests/owner-media.test.mjs` uses actual Sharp decode/re-encode operations with nonpersistent synthetic raster test pixels and mocked HTTP Storage responses. It verifies canonical encoding, metadata removal, stable checksums, immutable replacement IDs, caller authentication, upload/removal transport, rejection cases, provider denial, private delivery and immediate gateway revocation. **These are not live Supabase Storage/RLS results.** No fixture is public article imagery.

## Exact remote operations requiring separate owner authorization

The existing `20261026050000_resources_cms_storage_candidate.sql` is an unapplied proposal, **not an authorized executable final migration**. Do not replay it blindly: its public predicates require reconciliation with the final approved published-revision architecture and image-rights gate.

1. Read-only preflight: inventory bucket `resources-cms-media`, CMS media table/ACLs, `storage.objects` policies and function ownership. Capture permission fingerprints for `public`, `auth` and `storage`. Stop if a bucket or policy with these names exists unexpectedly. Do not alter another bucket.
2. In one separately reviewed transaction create only the private bucket `resources-cms-media`, with `file_size_limit=4194304`, `allowed_mime_types=ARRAY['image/webp']`, `public=false`. Assert exactly those settings. No public bucket, broad `storage.objects` grant, service-role credential or paid service.
3. Install only CMS-namespaced helper functions and bucket-scoped policies from the final reviewed SQL: member SELECT for active owner/editor/reviewer/viewer; INSERT for active owner/editor; DELETE for active owner/editor when the object is eligible for cleanup. No UPDATE/upsert permission. Public SELECT requires an exact registered canonical media UUID referenced by an authorized **published revision**, active media metadata and approved rights/relevance. Never match working-draft HTML.
4. Preserve valid published references during draft edits. Public media eligibility must follow `published_revision_id` until explicit unpublication/archive/delete. Media archive/removal must refuse any object referenced by a retained live published revision. Parent publication SQL and Storage helpers must use the same invariant.
5. Test using the existing owner JWT and an explicitly approved synthetic nonmember token. Upload one nonpublic test image; verify owner delivery, anonymous draft denial, unrelated bucket/tenant denial and failed overwrite. Replace with a new media UUID. Publish a separately authorized disposable article revision referencing it, verify anonymous delivery, then unpublish and verify immediate gateway/Storage denial. Archive/remove only untouched test objects and rows. A live owner session is required; SQL role impersonation is not a real JWT test.
6. Independently verify bucket settings, exact policy/function inventory, zero public draft objects, unchanged unrelated permissions and audit records. Do not claim hosted image readiness until these checks pass.

## Authentic media approval contract

The source-of-truth media record must retain: source/photographer/manufacturer, source URL or owned original ID, copyright, license/permission evidence, attribution, restrictions/expiry, exact source checksum, canonical checksum/dimensions, equipment/model associations, alt text, reviewer and review date. Upload defaults to **pending review**; file existence or editorial article approval does not prove image rights. Images are authentic owned, manufacturer-permitted, licensed or contributor-permitted originals. AI-generated or generatively modified technical imagery is prohibited. If verified imagery is absent, the existing branded non-photographic design remains valid.

The current registration API only records the canonical object/checksum/name/alt metadata. Final rights-record persistence and publication checks are an explicit parent integration dependency; they must not be represented as remotely deployed by these adapter tests. PDF/document uploads remain disabled, including the approved Resource 13 PDF, until separate sanitization/accessibility/security review and authorization.

## Rollback and stop conditions

Before commit, any unexpected policy, ownership, claim behavior or cross-tenant access is a transaction failure: ROLLBACK and stop. After commit, revoke access by disabling only the new CMS media policies in a separately authorized transaction, preserving the private bucket and bytes for recovery. Do not drop a nonempty bucket, delete non-test objects, or overwrite any prior referenced image. Restore the exact captured CMS-only policy definitions only after review; recompare unrelated fingerprints.

A Storage object delete is not a database transaction. Use the existing upload-registration compensation path; if compensation fails, record an orphan for owner cleanup, never report a registered image as successful. Do not delete published images to make tests pass. Keep public delivery fail-closed during provider outages rather than serving potentially revoked cached bytes.

Expected incremental cost: existing-project Storage/bandwidth and image Function CPU only, subject to the existing plan and usage allowance. No new subscription, paid upgrade, worker or external image vendor is provisioned. Real metering and allowance checks remain part of remote preflight.
