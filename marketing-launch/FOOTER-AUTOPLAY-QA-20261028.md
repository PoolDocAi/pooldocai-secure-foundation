# Footer wordmark + automatic scene cycling — 2026-10-28

## Protected preview (not public release)
- READY Vercel preview: https://pooldocai-marketing-launch-rehearsal-20261027-l5jdsqzo4.vercel.app/
- Deployment: `dpl_6v52mbH9naetT7HqXeS71zdxeood`
- Source baseline: protected marketing deployment `dpl_hdCJKGBhZbowH81Af9nfWRNCy34s`; original 100 source file entries reused with 3 source updates (search finalizer, browser acceptance, new scene-autoplay helper), 101 files total. Private preview remains Vercel SSO protected.
- No custom-domain change, production data change, CMS publication, scheduler activation, or SaaS demo exposure.

## Owner requests implemented
1. **Footer PoolDocAI branding** restored as `PoolDoc<span class="brand-ai">AI</span>` within the existing centered footer. CSS inherits the exact accent used by the header wordmark, in daylight and dark scenes. Link spacing and protected Admin link are unchanged.
2. **Automatic scene rotation** now advances through the existing Day → Pool care → Night taglines/backgrounds every 10 seconds without scrolling the page. The three controls remain visually unlabeled dots with accessible names, manually clickable at any time. A real manual selection resets autoplay for 20 seconds, then resumes.
3. **Accessibility/comfort:** automatic rotation is disabled for the system's reduced-motion preference, pauses when the document is hidden, and suspends while the user interacts with a form or modal. No source texts or original WebP assets were altered.

## Verified build and browser acceptance
- Vercel reported `READY`; output contains `PASS: branded footer accent and reduced-motion-aware automatic scene cycling`.
- Chromium Playwright acceptance printed `AUTOPLAY PASS: first scene advanced to Pool care without a click` within 14.5 seconds, distinct from the original 16-second built-in interval.
- Desktop `1440×900` and mobile `390×844` browser acceptance both passed: all three manual scenes, WebP imagery, exact footer AI accent match to header, single Resources link, private Admin route, no visible labels on dots, published-only widget search/empty state, and both approved public guides.
- No Formspree submission was performed by automated tests.

## Release gate
Owner visual review of this exact new preview remains necessary. The existing public `pooldocai.com` still serves the previously deployed marketing site. The private CMS still runs separately; changes to held drafts remain unpublished.
