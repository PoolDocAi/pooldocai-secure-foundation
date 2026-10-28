# PoolDocAI — isolated public-build rehearsal (October 27, 2026)

**Result: PASS for marketing-only static two-article release rehearsal. NO-GO for full owner-editable Resources CMS launch.**

The owner requested a phone-only route to launch as soon as safe, with no PowerShell.

## Separate protected rehearsal

- Target Vercel team `bersonjoshua-8595`, **new isolated Vercel project** `pooldocai-marketing-launch-rehearsal-20261027` / `prj_32JysC1hScWWcGPT7EWML1DTlXCX`.
- Vercel Authentication set to **all deployments**, even production-mode URLs. Domain `pooldocai.com` is not attached to this rehearsal.
- Source reconstructed using exact uploaded file blobs from the owner-approved protected marketing Preview `dpl_661mMspSnH7tPFWdHF2meTqe5yqd`, without publishing any private full source package to public GitHub.
- **Rehearsal deployment** `dpl_41ZxJG2Bwk2ckC4B7VdrngA8nzmi` / `pooldocai-marketing-launch-rehearsal-20261027-neba8vv3c.vercel.app`, `target=production` **on that isolated rehearsal project only**, READY with no build failures.
- Small explicit **marketing-only** changes in that isolated deployment: add missing read-only `api/public-resources.mjs` handler restricted to exactly the two previously published article snapshots; materialize four original source WebPs from their losslessly decoded bytes. Retain the previously approved homepage, new optional email checkbox, legal footer, marketing text, native Vercel scripts and static snapshots. This handler has **no CMS editing, Production Supabase connection, private drafts, admin authentication, or dynamic CMS publication**.
- Independent backup/rollback unchanged: original public marketing project's prior production deployment `dpl_BCVRxR5M79oyVrDjCxFfy6tY2uPt` remains in place. No domain cutover, Production Vercel deployment on the marketing project, DNS change, Production DB mutation, PR merge or Formspree routing change was performed.

## Hosted HTTP smoke test

Actual authenticated Vercel fetch against rehearsal deployment returned:

| Route | Status |
|---|---:|
| `/` | 200 |
| `/resources/` | 200 |
| `/resources/pool-pump-wont-start/` | 200 |
| `/resources/green-pool-first-checks/` | 200 |
| `/resources/collections/whats-wrong/first-checks/` | 200 |
| `/resources/collections/equipment-and-guides/pool-care/` | 200 |
| `/privacy.html` | 200 |
| `/terms.html` | 200 |
| `/sitemap.xml` | 200 |
| `/llms.txt` | 200 |
| `/robots.txt` | 200 |
| `/assets/day-1536.webp` | 200 (`image/webp`) |
| `/assets/night-768.webp` | 200 (`image/webp`) |
| `/public/resource-design.css` | 200 |
| `/resources/unpublished-resource/` | 404 |

The homepage contains the optional unchecked email opt-in and approved legal footer. No Preview-only notice appeared. `X-Robots-Tag: noindex` on these requests is caused by the isolated rehearsal project's **all-deployments Vercel Authentication**, not by the public build's `robots.txt`, which allows indexing. The original live domain was not changed.

## Production launch decision

**Two separate launch scopes remain:**

1. **Public marketing-only release of homepage + static Resources Hub/two articles**: this code has a functioning hosted public-mode rehearsal, but cannot provide the owner's mandatory launch-time editing/import workflow. It must not be silently substituted for the complete CMS release. A separate explicit owner decision to *defer CMS editing* is required if launching just the marketing site now. Never link the production public site to CMS Staging.
2. **Full owner-editable CMS launch**: still gated. Existing Production Supabase `owfeebydlyacssqpnmkq` has no `resources_cms` schema. Owner's Production custom-format backup has checksum/metadata/decompression verification but no independent restored copy. Original user requirement was to prove safe recovery before migrations. The Supabase Free plan has no managed automatic backups or branch restore; paid-only `Restore to a new project` cannot immediately solve this Free-tier gap. Do not apply Production DDL, bootstrap owner permissions, enable public publication or merge PR #26 until proper recovery and independent migration tests.

## Remaining decision, no Windows needed

If owner explicitly chooses marketing-only first: reproduce the tested static source to the **existing marketing project**, validate production build separately with domain assignment disabled, then promote only after verifying all routes, Formspree, SSL, sitemap and rollback. That phased release does not satisfy owner CMS editing/import and should be labeled accordingly. If owner insists on editing from day one, wait for a reliable recovery and Production installation pathway.

This is a hosted smoke report, not an authenticated end-to-end owner-edit/import test or a claim that the full product is live.
