# PoolDocAI Resources — Authentic Media & Verified Equipment Library

**Status:** draft integration package. Repository-only; not wired into CMS commands, storage, database, article rendering, or the public site. **Not deployed.**
**Base:** Resources CMS v0.6.0 draft PR #19. Intended to follow Gate 3B and any separately approved Storage/backend migrations.

## Trust policy

No AI-generated or generatively enhanced photographic imagery, synthetic product photos, fabricated equipment diagrams, or simulated repair scenes in public PoolDocAI Resources. Do not use image-generation APIs as placeholders.

Allowed:
1. PoolDocAI-owned, real photographs with traceable source/ownership.
2. Manufacturer-provided product photos or technical diagrams **with documented reuse rights** and verified model/revision.
3. Licensed authentic editorial/stock photographs with commercial web usage rights.
4. Contributor photographs with explicit permission and any needed subject/appearance releases.
5. Verified public-domain images with origin evidence.
6. Non-photographic brand UI artwork (logo, typography, shapes, icons), or verified human-created instructional graphics.

For every image: require real source, rights evidence, copyright owner, context-specific usage permissions, alt text, model applicability (where relevant), human review, and expiry/revocation checking. **Do not presume a manufacturer image is available for unrestricted marketing reuse.**

No AI image detector can prove authenticity. Require a human reviewer to confirm provenance and suitability, using the original file, source and evidence. This policy is both editorial and a publication gate.

## Existing implementation to reuse

- CMS already has a **Media library** in resources-cms/public/admin.js.
- Upload pipeline validates JPEG, PNG, WebP, strips embedded metadata via re-encoding, and stores private WebP (resources-cms/src/production/storage.mjs).
- Existing articles expose featured/social/body image fields and alt text.
- Storage bucket and policies remain separately gated; do not activate them without authorization.
- The resources_cms.media table has image ID, checksum, object key, name and alt text but **does not** contain rights/provenance or approval state.

This branch adds a pure policy module and regression tests:
- src/production/media-provenance.mjs
- tests/media-provenance.test.mjs

**It does not yet provide a functional, CMS-integrated verified media library.** No image becomes approved merely because it passes a validation function.

## Proposed staged integration (future implementation)

### Backend and storage — after separate migration authorization
- Add a versioned provenance record related 1:1 to resources_cms.media.id, with a server-owned default status of pending_review.
- Preserve immutable raw-file SHA-256 and normalized-display derivative SHA-256 for duplicate detection.
- Store original rights evidence in private storage or an authenticated evidence reference; never public URLs if sensitive.
- Track source type, real-world photographer/manufacturer, copyright holder, usage scopes (website/social/download), license/permission evidence, credit, license expiry, authenticity declaration, applicability, manufacturer/model/family/generation, representative caption, subject consent, alt text, audit/reviewer decision, creation/update timestamps.
- Model decision lifecycle: pending_review -> approved | rejected; approved -> revoked. Revision of core evidence invalidates approval and must return to pending_review.
- Deny direct writes to approval fields by public users or ordinary media-uploaders; only audited, explicitly authorized reviewer commands may update approval state. Require actor identity from trusted authentication, never user-supplied fields.
- Keep the Storage bucket private. Public read via server gateway only after verified publication reference **and** approved provenance and valid usage scope. Current storage read rules alone are not sufficient for this new policy.
- Never expose license evidence, consent records or private review notes through public metadata.
- Reject expired licenses from new/public use; on expiry or withdrawal, remove image from public delivery and replace with branded non-photographic fallback; retain immutable audit history.
- Rate-limit, validate image bytes, strip EXIF/GPS, constrain upload sizes and image dimensions, and scan/validate file types before any publication.

### CMS Media library UX
- Add authenticated filters: Pending verification, Approved, Rejected, Revoked, Expiring rights, Missing alt text, Exact model, Representative.
- Add source/evidence, copyright, usage scope, manufacturer, model, generation, accuracy, attribution, license expiry and alt fields to upload/review form. **No uploader-accessible "approved" toggle**.
- Add reviewer side-by-side image preview, source evidence, resolution/rights checklist, human decision with reason, and audit trail.
- Search and reuse approved images by verified manufacturer/model, equipment, article category and source without reuploading.
- On article image-picker, display only approved, unexpired images licensed for requested purpose; show model match vs representative warning.
- Require a visible "Representative photo — not exact model" label for non-exact technical imagery.
- Ensure friendly touch controls, labeled inputs, keyboard focus, and verification status on Android.

### Resource rendering and public UI
- Preserve existing public article slugs, resource IDs, publisher controls and analytics IDs.
- Require image provenance approval before article publication when that article references a media asset, including body, featured, social and download imagery.
- If any image lacks verified public rights, keep draft/publish blocked for that image, or let editors remove it and use the approved **branded non-photographic fallback**.
- Never substitute generated photographs or misleading visually similar models.
- Only published content may expose its approved media publicly.
- Track image impressions, interactions, content IDs and asset IDs through the existing consent-aware first-party analytics framework. Do not include image-license evidence or visitor personal data.
- Respect attribution, license terms and accessible alt text; do not fill public cards with unrelated pictures.

## Required QA and release checks

1. A new upload is ALWAYS pending verification, irrespective of client-provided status/approval flags.
2. User cannot authorize their own media without server-side reviewer permission.
3. Fake/synthetic-origin image declarations are rejected; a "false" declaration alone does not prove authenticity and still requires source evidence and independent human review.
4. Missing/expired licenses, revoked media, out-of-scope usage, absent alt text, or incomplete model applicability block public use.
5. A revoked image does not remain available from a public URL or CDN cache longer than the defined revocation window; explicitly purge cached variants or set appropriate cache headers.
6. Image choice for one model must not silently misrepresent another.
7. Original evidence and personal release documents are not public.
8. Duplicate checksum flags collisions/duplicates but does not automatically reject rights-verified alternate licensed uses.
9. Existing live articles and image associations are not changed before migration and release approvals.
10. All tests, responsive browser interactions, accessibility checks and exact Staging/Preview migration gates must pass.

## Release boundary

This package is intentionally a **code-only review**. Gate 3B Staging import is still pending; do not introduce schema, Storage or image records beforehand. Integrate through a follow-up tested migration and authenticated API/UI change once Gate 3B completes and the owner separately approves the required operations. No production deployment or paid services.
