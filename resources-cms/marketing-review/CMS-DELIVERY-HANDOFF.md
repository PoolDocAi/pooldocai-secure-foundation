# CMS published-revision integration

This is an additive, disabled-by-default candidate on the full owner-approved marketing/legal source, not a replacement with an older GitHub subtree. No deployment, Supabase mutation, publication, domain, or security change was executed.

- Marketing package SHA-256: `a9c46f12e0d5832d840c330f85e462c3a8896e0ad9adad96873888b1b00d43e9`.
- Exact approved `privacy.html` and `terms.html` fetched from PR #25 commit `ec26ba2372e816910af069d32fba23e7ca85ea6c`; copy unchanged. All homepage source, photographs, typography, animation, existing APIs, and accepted Preview config remain untouched.
- Shared CMS delivery source is `src/production/public-delivery.mjs`. Its nine focused tests run in the sibling CMS checkout. This marketing bridge uses the same file.

## Controlled Staging Preview after separate authorization

1. Apply the separately reviewed owner import/publication migration and trusted import allowlist to **Staging only**, then reconcile the two existing articles and one representative approved draft. Do not replay or alter Gate 3B.
2. Test owner Auth, exact-revision release, direct API rejection, unpublication and restore. Public RPCs must use only the authorized immutable published pointer, including while a newer working draft exists.
3. Deploy this exact marketing candidate to the existing protected marketing project using `vercel.cms-preview.json` as deployment config. Set `CMS_PUBLISHED_DELIVERY_ENABLED=1`, `PUBLIC_RESOURCES_SUPABASE_URL` to Staging and `PUBLIC_RESOURCES_PUBLISHABLE_KEY` to its publishable key through secure provider configuration. No direct database or service-role credentials.
4. The alternate build removes generated static article/sitemap fallbacks. It materializes original encoded WebP assets into their original binary bytes without altering source assets. Approved HTML/CSS renderers are reused for the Hub, reading pages, collections and footer. Preview canonical metadata stays on `pooldocai.com`; article clicks remain within the protected Preview.
5. Verify actual hosted HTTP and authenticated owner browser flows. Local fixtures are not hosted evidence. In particular confirm Vercel routing precedence and no stale static page after unpublication.

Staging publication makes its authorized projections accessible through its anonymous Data API; Vercel Authentication does not protect that API. Exact approval must cover the temporary test projection and cleanup. No manuscript was published in this work.

## Production candidate, never automatically activated

`vercel.cms-production.json` and `scripts/build-cms-production.mjs` are local candidates only. They retain the approved production homepage/waitlist/legal build and route resource articles, Hub, discovery, sitemap and llms.txt through the same published-only handler. Production deployment, production CMS data target, and production configuration require owner approval and successful hosted Staging/recovery gates first. Routine future editorial releases update the database's authorized published pointer and need no build or deployment.

## Delivery and operational behavior

- Only public_index/public_article/public_redirect/public_media RPCs; no admin JWT, cookies, credentials, or write calls are forwarded. Malformed responses, unexpected canonical paths, privileged keys and upstream redirects fail closed.
- No-store at browser, CDN, and Vercel CDN layers. Withdrawal is immediate on the next request; there is no stale snapshot fallback. An unconfirmed upstream error gives controlled 503 + Retry-After. The static marketing homepage remains available. Related-guide failure safely omits that recommendation instead of retaining an unverified link.
- Public image bytes are bounded, validated against the exact object key and SHA-256, and delivered only while public_media permits them. New image publication is still gated on Storage/rights review. Typically one published article read plus one revalidated related legacy guide; Hub/search use one bounded index read. No worker, embedding call, external search vendor, paid library or new service. Future large catalogs should add a small paginated public-summary RPC rather than raising the bounded 2 MB response limit.
- Existing folder identities and analytics element IDs are retained. Fixture article IDs are remapped by canonical slug to actual immutable CMS UUIDs. New articles appear in global Hub/search without redeployment; additional owner-managed folder persistence remains its separately authorized migration feature.
- Runtime analytics remains disabled as in the approved public release candidate. Existing validation-only Preview collector uses former fixture UUIDs; it is not falsely presented as dynamic CMS analytics persistence.

## Local evidence

- 9 shared public-delivery tests: mocked public RPC transport; same handler sees released changes, draft isolation, no cached withdrawals, private headers ignored, publication mutation rejected, canonical redirects, noindex/HEAD/sitemap/llms, bounded failures.
- 21 marketing unit checks (includes five new integration checks) and owner-regression check.
- 13 real local browser checks at 320/360/390/430/768/1024/1440 widths, real Node router with mock published RPC transport and the two exact live article bodies. Covers current Hub, article shell, technical safety text, legal footer, collection UUID remapping, mobile assistant and axe WCAG checks. Screenshots are local, not hosted acceptance.
- Logs and screenshots: `launch-recovery/public-integration/evidence/` and adjacent `*-results.log`, `cms-delivery-browser.log`, `marketing-audit.json`.
