# Owner-feedback corrections — marketing preview

## READY release candidate
- Protected preview: https://pooldocai-marketing-launch-rehearsal-20261027-ckl4inbmh.vercel.app
- Deployment ID: `dpl_BN7dRwQt9cVvtZA1X5pfQ78dHNLN`; READY on October 28, 2026
- Vercel project: `pooldocai-marketing-launch-rehearsal-20261027` (SSO enabled for all deployments)
- Source: complete prior 96-file approved marketing archive built with `npm run build:production`, plus pinned finalizer and browser regression test in this branch
- `pooldocai.com` was not reassigned, Production Supabase database was not changed, CMS publication holds remain active

## Owner-requested corrections
1. **Day/night backgrounds:** previous production archive contained ASCII base64 *instead of WebP bytes* under the `.webp` filenames. Corrected all four by decoding into actual RIFF/WEBP bytes and verifying magic/header; sizes after correction: day-1536 196,188 bytes, day-768 62,830 bytes, night-1536 191,930 bytes, night-768 62,378 bytes. Fixed background CSS stacking so scenery is on `z-index: 0` and site foreground is on `z-index: 1` with click-safe layering.
2. **Manual scene/tagline selectors:** retained existing `data-step=0/1/2` JS selection and added clearly labeled, 44px-height, keyboard-focusable Day / Pool care / Night controls. Browser acceptance clicks all three and checks pressed state and headline.
3. **Remove marketing phrase:** deleted the “Something smarter is on the horizon” span from homepage, not merely hidden in CSS.
4. **Footer:** centered “PoolDocAI” with an evenly spaced, mobile-wrapping row **below**: Resources, Privacy Policy, Terms of Service, Contact, Privacy choices, and Admin. Kept original consent-aware Privacy choices button and `#year` anchor. Admin opens the protected Staging owner Studio `https://pooldocai-resources-cms-private-owner-review.vercel.app/admin/` (does not make CMS public).

## Verified tests
The Vercel build printed `VALID WEBP` for each background and `PASS: playable binary scenes, manual scene buttons, centered footer, Admin link and two-guide Hub`.

**Playwright + Chromium browser acceptance PASSED** both:
- Desktop `1440×900`: day and night actual decoded images, Day/Pool care/Night headline switching, selected-state updates, single Resources link, protected Admin link, removed marketing phrase, centered footer/links below, zero unhandled JS errors.
- Mobile `390×844`: same assertions passed.

Two existing approved public resources retained, and all held drafts/private media remain out of the public build. Tests did NOT send waitlist forms or verify actual external Formspree delivery, and did NOT test the Vercel SSO-protected deployment from the owner's browser. **Owner visual acceptance is still required before any public domain switch.**

The marketing release is intentionally **static** with two public guides; it does not yet include a Production CMS publishing integration. PR #27 handles the private CMS separately.

## Go-live gate
Owner reviews the protected candidate and confirms that the background/photos, controls, mobile layout, footer, waitlist, and two public guides match approved design. Once explicitly accepted, promote a corresponding reviewed public marketing build with correctly configured routes and run actual `pooldocai.com` smoke tests. Do not replace the public domain with the full PoolDocAI SaaS website.
