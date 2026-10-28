# Private marketing release candidate — 2026-10-28

## Deployment evidence

- Latest pre-existing 96-file marketing source: Vercel deployment `dpl_6PM6T6MNYABpS2CrUcCAZxQ9uZ6W` in protected rehearsal project `pooldocai-marketing-launch-rehearsal-20261027`.
- Rebuilt candidate: `dpl_8R2Swuw3qvn8c3dV71xegeGoME1X`, URL `https://pooldocai-marketing-launch-rehearsal-20261027-e3pew1p1d.vercel.app`. Vercel state READY, SSO for all deployments. No public domain aliases were changed.
- Built with `npm run build:production && node scripts/finalize-marketing-v2.mjs` and `public` output. The deployment's postprocessor contents are preserved in this branch as `marketing-launch/finalize-public-static.mjs`; its static routing/security policy as `marketing-launch/vercel-public-static.json`. The live preview was created from the 96 existing Vercel source file blobs, not a GitHub-attested entire marketing bundle; do not claim GitHub commit/source equivalence.
- Build logs report `PASS: marketing-only release candidate, backed by existing public two-article Hub; no Production CMS dependency.` Source files for media API `api/cms-public.mjs` and review API `api/review.mjs` were excluded, and the CMS rewrites were replaced by static public routes. The build used the approved original day/night images, patched CSS scenery stacking (z-index 0 and shell 1), removed obsolete footer slogan, included legal/footer and exactly one static homepage Resources link, and retained only the two approved static public guides.
- Before owner acceptance, **hosted browser visual/functional QA is still required**: desktop/mobile responsive layouts, rotating headline and scene, Formspree real labeled delivery to existing recipient, legal links, Resources Hub functionality, articles, consent tracking, and 404 for forbidden SaaS routes. Vercel SSO has not been disabled or bypassed. No actual authenticated hosted browser test was performed by this release script.

## CMS separation

The functioning owner-private Resources Studio is Staging-only. This marketing release is a *static public two-article Hub*; its public contents will NOT automatically update when the Staging owner edits CMS drafts. Production CMS schema and publishing workflows require their own separately approved migration/security/release, and publication holds remain. Do not imply full private CMS-to-public publishing integration is live.

## Next gate

Owner opens the authenticated protected preview and visually accepts it, then explicitly authorizes promoting the reviewed marketing build to `pooldocai.com` (the full SaaS app remains excluded). Production CMS integration is a later independent gate. Keep prior `pooldocai.com` alias for rollback. Do not redirect any live domain until this acceptance.
