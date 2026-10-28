# Hosted protected Preview smoke evidence — October 27, 2026

Source: owner-supplied approved marketing archive + approved legal pages + Staging-only public CMS delivery bridge. Target Vercel team: `bersonjoshua-8595`. **No Production deployment or database migration.**

## Release candidate tested

- Protected Vercel Preview: `pooldocai-coming-soon-onqe3m73o-bersonjoshua-8595.vercel.app`
- Deployment ID: `dpl_DLZEZ7uJsXo91sfEYfqv2BizYLsh` (CLI Preview, READY; no Production target).
- Prior Preview `dpl_7kq3XA14Vht3BM5LEVfstzPMWZ2T` had **500 FUNCTION_INVOCATION_FAILED** on every public Resources route due to missing `/var/task/review-navigation.json`. Runtime logs confirmed `ENOENT`. The rebuilt Preview resolved these startup failures.
- Connected Vercel protected-deployment fetch, checked as the authorized owner. These are actual hosted HTTP responses, not just local fixtures.

## Observed response matrix

| Route | Status | Notes |
|---|---|---|
| `/` | 200 | Approved homepage, footer links |
| `/resources/` | 200 | Dynamic Hub, two published Staging articles |
| `/resources/pool-pump-wont-start/` | 200 | Published guide |
| `/resources/green-pool-first-checks/` | 200 | Published guide |
| `/privacy.html` | 200 | Approved Privacy Policy |
| `/terms.html` | 200 | Approved Terms of Service |
| `/resources-sitemap.xml` | 200 | XML |
| `/llms.txt` | 200 | Plain text |
| Four linked `/resources/collections/{parent}/{child}/` routes | 200 each | All collection links present on live Hub work |
| Two tested collection paths lacking final slash | 200 each | Slash tolerance verified |
| Two published articles without final slash | 200 each | Slash tolerance verified |
| `/resources/not-published-resource/` | 404 | Missing/unpublished resource fails closed |
| `/assets/day-1536.webp`, `/assets/night-768.webp` | 200 each | `image/webp` |
| `/resources/resources.css`, `/style.css` | 200 each | CSS |
| `/robots.txt` | 200 | Preview robots protection |

The tested collection paths were `whats-wrong/first-checks`, `equipment-and-guides/pool-care`, `explore-resources/tips-tricks`, and `explore-resources/learning-center`.

All observed successful HTML routes had Preview `X-Robots-Tag: noindex, nofollow, noarchive`; public Resources content also returned `Cache-Control: no-store`. Approved footer links `/resources/`, `/privacy.html`, `/terms.html`, and `mailto:hello@pooldocai.com` were present on the homepage, Hub, guides and legal pages.

Connected Staging Supabase's `resources_cms.public_index()` returned exactly two public records matching the hosted articles, and protected Vercel Preview environment was separately configured with the Staging publishable key/URL. No private CMS table or Production database mutation occurred in these smoke checks.

The linked owner-editor login page `pooldocai-resources-cms-private-owner-review.vercel.app/hosted-login.html` returned HTTP 200 and the CMS health route returned JSON `{"ok":true}`; unauthenticated `/api/me` was rejected with 401.

## NOT YET VERIFIED — release blockers

- Authenticated owner sign-in, editing/saving either of the two published articles and importing additional approved content.
- Public-to-private editorial rights, scheduled publication/withdrawal live workflow and rollback.
- Visual and accessibility acceptance in a real mobile and desktop browser.
- Isolated restore rehearsal for the verified Production backup; reviewed hosted Production CMS migrations.
- Mailbox receipt/reply test for `hello@pooldocai.com`.
- Any Production domain cutover or merge.

The Preview is **ready for owner visual/functional acceptance**, not cleared for public Production release. Do not equate public-route smoke success with Production readiness. No PR merge, Production deploy, or DNS change is authorized by this report.
