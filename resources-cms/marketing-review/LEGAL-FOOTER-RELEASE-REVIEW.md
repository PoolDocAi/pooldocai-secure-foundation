# PoolDocAI legal/contact footer — protected release review

**Scope:** Add owner-requested **Contact** link to `mailto:hello@pooldocai.com`, and **Privacy Policy** and **Terms of Service** links, in the bottom navigation of the landing page, Resources Hub, both existing public articles and draft legal pages. Preserve the existing bottom-left Resources link (exactly one on homepage) and Privacy choices control. Do not redesign the approved homepage.

## Current source and intended routes

- `/privacy.html`: copy of the existing `website/privacy.html` working draft with only ordinary-contact wording and footer-nav changes. **Not legally approved**.
- `/terms.html`: copy of existing `website/terms.html` working draft with only ordinary-contact wording and footer-nav changes. **Not legally approved**.
- `mailto:hello@pooldocai.com`: opens user's email software; delivery must be verified by the owner (mailbox receipt and reply).
- `/resources/`: existing Resources Hub. Do not publish drafts through the public catalog.
- Article routes remain **`/resources/green-pool-first-checks/`** and **`/resources/pool-pump-wont-start/`** with original canonicals.

The approved source is a code-only review subtree, **not** a full replacement for the latest hosted owner-accepted marketing deployment. Apply the `scripts/footer-navigation.mjs` additive footer transform during a review build using the complete marketing source from the latest verified protected Preview, preserving its exact rolling day/night assets, animation, typography, waitlist and visible Browse Collections fix.

## Protections and requirements

1. The review build explicitly rejects non-Preview Vercel environments and has no command to promote Production.
2. Vercel Authentication and `noindex` must stay enabled in the protected Preview.
3. Both legal pages remain visibly marked *Draft — formal legal review required*. They are **not** approved for a publicly accessible Production release.
4. Final legal approval needs confirmed legal operator, effective dates, actual vendors/data flows, retention periods and user rights; contact details for privacy/legal notices; coverage of published editorial Resources and forms; and owner sign-off (legal counsel review strongly recommended).
5. Before Production promotion, verify the `hello@pooldocai.com` mailbox receives inbound messages and replies successfully. Verify accessible navigation on homepage, Hub, both articles and legal pages in authenticated desktop and mobile Preview. Preserve the Analytics consent behavior.
6. This PR does not run Gate 3B, create/migrate CMS tables, publish manuscripts, alter Supabase/Auth/RLS, merge the Resources code to `main`, or touch Production.

## Outstanding release gates

- Gate 3B transaction rollback rehearsal and the exact authorized staged import require reliable native psql session; connected Supabase read-only baseline checks have passed, but **the import is still pending**.
- Authenticated CMS editing of the two existing live articles and end-to-end publication of one held draft in Staging must be demonstrated.
- Separate approval for CMS/folder Storage and Production DB migrations.
- Owner and legal approval of both final legal policies.
- Full marketing + CMS release candidate tested on Android and desktop before promotion.

## Narrow change list

- Add accessible footer-nav generator and additive CSS for mobile and desktop.
- Add navigation to the homepage and two article review outputs through the existing build script.
- Add the same routes to the dynamic Resources Hub footer template.
- Copy the existing draft legal pages for protected preview; keep their draft markers.
- Add isolated tests of link destinations, no duplicate Resources on homepage, unchanged article canonicals, and build refusal in Production.
