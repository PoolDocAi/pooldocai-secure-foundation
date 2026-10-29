# PoolDocAI marketing launch — isolated CSS repair and public release gate

Public-domain contract: [Issue #28](https://github.com/PoolDocAi/pooldocai-secure-foundation/issues/28). This branch does **not** modify the CMS, Supabase, `pooldocai.com`, or the existing approved marketing source.

## Direct HTTP diagnosis (2026-10-28)

Read-only checks against the actual `https://pooldocai.com` deployment returned HTTP 200 and `image/webp` for all tested day/night scene assets; root HTML/CSS and `/resources/` also returned 200. The *live* CSS contained:

```css
.scenery { position: fixed; inset: 0; z-index: -1; background: #c7e8ed; }
.shell { max-width: 1540px; /* existing layout omitted */ }
```

This negative stacking layer can put the full-screen imagery behind the root canvas. Change the **approved marketing source** while preserving existing gradients and image URLs:

```css
.scenery { z-index: 0; pointer-events: none; }
.shell { position: relative; z-index: 1; }
```

Append this after existing scenery/shell rules, or merge it into their declarations. Validate with real browser screenshots at narrow/wide viewports and after switching day/night mode. Browser verification is still needed; the CSS mechanism is a strong hypothesis, not a complete visual acceptance.

An isolated Vercel **preview** was deployed from the existing older live site's source files with only this stylesheet change: deployment `dpl_Eu4p9mhAJz9KLci2icVJS2QpDC77` (READY), URL `https://pooldocai-marketing-launch-rehearsal-20261027-evw0ps5s7.vercel.app`. Source inventory verified exactly 18 files, original images retained, patched stylesheet blob `4309078b44fa702d321df8d36d1d73629ec508b3`. This is a technical proof, **NOT** the completed approved website: it starts from the older 18-file public deployment, not the latest 96-file marketing rehearsal. No production alias was assigned; preview remains separately protected.

A first rebuild in the marketing rehearsal failed because the project's `npm ci` expects a lockfile absent from this older static archive; a later per-deployment build override produced the READY proof. Do not use the proof deployment for public release or assume the rehearsal's build settings are correct for the final source.

## Repeatable read-only smoke checks

```sh
node marketing-launch/check-public-release.mjs https://pooldocai.com public
node marketing-launch/check-public-release.mjs https://approved-protected-preview.example preview
```

The second command requires an already authenticated mechanism for Vercel protected previews (use `vercel curl` or an approved ephemeral OIDC token for a browser); bare Node fetch cannot bypass Vercel Authentication. It is included to document intended preview noindex behavior, not to suggest bypassing protection.

The script tests server-delivered metadata, images, CMS-free URL navigation and sitemap. **It does not** test dynamic duplicates rendered by JavaScript, responsive layout, animation, Formspree delivery, CMS authorization, or visual acceptance. Those remain mandatory browser/manual release gates.

## Outstanding release steps

1. Locate and pin the **latest owner-approved marketing source** (separate from PoolDocAI SaaS and private CMS).
2. Integrate the backdrop stacking repair there, remove duplicate *visible* Resources navigation, and preserve the approved footer, messaging, waitlist and resources UI.
3. Produce a protected, provenance-attested preview with the complete source and current CMS public-delivery safeguards; test browser visuals and real Formspree delivery before promotion.
4. Do not expose unapproved CMS drafts or enable scheduling; keep PDFs disabled.
5. Only after owner acceptance and explicit go-live approval, promote to `pooldocai.com`, validate the real domain, and preserve rollback ability.

This branch is not a production-ready patch set by itself; its purpose is to preserve the reproducible diagnosis and automated HTTP release checks without interfering with the concurrently active CMS PR #27.
