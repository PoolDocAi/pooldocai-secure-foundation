# Published-guide search and scene dots

The prior widget requested `/api/public/resources?surface=assistant&path=&folder=&q=&offset=0`. Authenticated HTTP inspection of `dpl_BN7dRwQt9cVvtZA1X5pfQ78dHNLN` returned **404 NOT_FOUND**. The marketing release is static and intentionally has no CMS API rewrite; restoring a CMS route would cross the publication boundary.

`finalize-public-search.mjs` runs after the existing v3 finalizer. It builds a minimal static catalog from an explicit allowlist of `green-pool-first-checks` and `pool-pump-wont-start`, verifies both static article pages exist, projects only public fields, and replaces the widget API call with the bundled search helper. Search uses title, summary, topic names and aliases; all query words and selected topic filters must match. It returns links and existing summaries, never invented answers. Unknown folders and unmatched queries return zero results. Discovery paths browse the same two published guides; no draft folders are included. Catalog loading failures clear the loading state and leave the Hub link available.

Scene controls contain no visible text and retain existing aria-labels and pressed-state behavior. Seven-pixel dots have 44-pixel transparent click targets. Existing v3 binary WebP validation, stacking repair, removed phrase, centered footer and private Admin link remain in the build.

## Reproduce against approved deployment source

```sh
VERCEL_ENV=production npm run build:production
node scripts/finalize-public-static-v3.mjs
node scripts/finalize-public-search.mjs
node scripts/browser-acceptance.mjs
```

The first command selects the static production-content build mode only. The Vercel deployment target remains Preview, with SSO enabled. It does not promote a domain or change database/CMS state. Install development dependencies to run Chromium acceptance tests.

Source provenance: reuse every source blob from `dpl_BN7dRwQt9cVvtZA1X5pfQ78dHNLN`, replacing the browser test and adding the two new scripts from this branch. Vercel's current tree has 98 file entries (the earlier archive is described as 96 files). Do not substitute the older 18-file website or claim the complete remote archive is tracked in GitHub.

No production domain, production database, CMS authorization, draft publication hold, or scheduling setting is changed.

## Verified candidate

- READY protected Preview: https://pooldocai-marketing-launch-rehearsal-20261027-ankqcrom8.vercel.app
- Deployment: `dpl_hdCJKGBhZbowH81Af9nfWRNCy34s`.
- Build-time Chromium acceptance passed at 1440×900 and 390×844: binary images, all three scenes and headlines, unlabeled accessible controls, centered footer, private Admin link, widget initial two results, pump/green searches, unmatched-query empty state, exactly two catalog slugs, and both article URLs returning 200.
- Hosted browser QA confirmed widget loads real results, pump and green queries, explicit no-results state, green result navigation and pump article navigation. Mobile hosted QA confirmed nighttime image, dot controls, discovery path selection and topic filtering to the pump guide. Same-origin credentials on the static catalog request preserve the existing Vercel SSO session; omitting them caused the first hosted candidate to fail despite passing local tests. No CMS credentials or endpoint are used.
- Screenshots: `qa-mobile-home.png`, `qa-mobile-widget.png`.
- Public domain promotion remains unapproved. The 31 held CMS drafts remain excluded by the two-slug catalog allowlist and unchanged static publishing boundary.
