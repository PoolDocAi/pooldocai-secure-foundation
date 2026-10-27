
> OWNER LEGAL COPY APPROVAL — October 27, 2026: the owner explicitly verified Privacy Policy and Terms of Service as ready for public publication. This approval does not authorize incomplete code/Preview-only settings to be promoted, nor does it apply CMS migrations.
# PoolDocAI legal/contact footer — protected release review

**Scope:** Add owner-requested **Contact** link to `mailto:hello@pooldocai.com`, and **Privacy Policy** and **Terms of Service** links, in the bottom navigation of the landing page, Resources Hub, both existing public articles and legal pages. Preserve the existing bottom-left Resources link (exactly one on homepage) and Privacy choices control. Do not redesign the approved homepage.

## Current source and intended routes

- `/privacy.html`: owner-requested public-facing policy text aligned with `website/privacy.html`; browser title, description, visible labels, and footer do **not** say draft. **Owner approved for public publication on October 27, 2026.**
- `/terms.html`: owner-requested public-facing Terms of Service text aligned with `website/terms.html`; no draft labels. **Owner approved for public publication on October 27, 2026.**
- `mailto:hello@pooldocai.com`: opens user's email software; delivery must be verified by the owner (mailbox receipt and reply).
- `/resources/`: existing Resources Hub. Do not publish drafts through the public catalog.
- Article routes remain **`/resources/green-pool-first-checks/`** and **`/resources/pool-pump-wont-start/`** with original canonicals.

The approved source is a code-only review subtree, **not** a full replacement for the latest hosted owner-accepted marketing deployment. Apply the `scripts/footer-navigation.mjs` additive footer transform during a review build using the complete marketing source from the latest verified protected Preview, preserving its exact rolling day/night assets, animation, typography, waitlist and visible Browse Collections fix.

## Protections and requirements

1. The review build explicitly rejects non-Preview Vercel environments and has no command to promote Production.
2. Vercel Authentication and `noindex` must stay enabled in the protected Preview.
3. Both legal pages are displayed without draft labels in accordance with owner instructions. **Owner explicitly confirmed both Privacy Policy and Terms of Service are verified and ready for public publication.** Technical release QA remains required before deployment.
4. Owner approved the current legal document copy for public publication on October 27, 2026. Keep legal copy immutable for this release except to correct technical/link errors or with fresh owner approval.
5. Before Production promotion, verify the `hello@pooldocai.com` mailbox receives inbound messages and replies successfully. Verify accessible navigation on homepage, Hub, both articles and legal pages in authenticated desktop and mobile Preview. Preserve the Analytics consent behavior.
6. This PR does not run Gate 3B, create/migrate CMS tables, publish manuscripts, alter Supabase/Auth/RLS, merge the Resources code to `main`, or touch Production.

## Outstanding release gates

- Gate 3B transaction rollback rehearsal and the exact authorized staged import require reliable native psql session; connected Supabase read-only baseline checks have passed, but **the import is still pending**.
- Authenticated CMS editing of the two existing live articles and end-to-end publication of one held draft in Staging must be demonstrated.
- Separate approval for CMS/folder Storage and Production DB migrations.
- **Complete:** Owner approved both current legal policy texts for public publication on October 27, 2026. Technical publishing / QA still pending.
- Full marketing + CMS release candidate tested on Android and desktop before promotion.

## Narrow change list

- Add accessible footer-nav generator and additive CSS for mobile and desktop.
- Add navigation to the homepage and two article review outputs through the existing build script.
- Add the same routes to the dynamic Resources Hub footer template.
- Keep `website/privacy.html` and `website/terms.html` synchronized with their protected marketing-review copies; no public draft labels or dead waitlist links.
- Add isolated tests of link destinations, no duplicate Resources on homepage, unchanged article canonicals, and build refusal in Production.

## Review facts still needing owner verification

- Correct legal entity/operator name and business mailing address, if applicable to the release geography.
- Confirm the website's actual form vendor, hosting/analytics tools, cookie/consent configuration, how long submitted data and logs persist, and privacy-request process. Do not assert unverified retention periods.
- Confirm which diagnostic and authenticated CMS functions are available to the public at launch; public policy text must describe real, not future, processing.
- Confirm hello@pooldocai.com inbound delivery and whether it should serve formal privacy/legal notices, not merely ordinary contact.
- **Owner approval completed October 27, 2026.** Preserve the approved policy text and contact destination in the next protected release candidate. Any future material text changes require review.
