# Waitlist UI and optional marketing email consent — owner acceptance update (October 27, 2026)

**Scope:** Full privately held approved marketing Preview ZIP, not the incomplete public marketing mirror in this repository. **No merge, Production deployment, DNS change, Formspree configuration change, or CMS database operation.**

The owner requested two changes before launch:

1. Remove redundant top-of-homepage `Get early access` link. Keep the waitlist card and the already-approved footer navigation.
2. Replace the long inline Formspree/scene/analytics data-use paragraph with a short statement about waitlist notification and links to `/privacy.html` and in-page `#privacy-details`. The detailed disclosure remains inside the existing privacy dialog, which continues to describe Formspree and optional analytics choices.
3. Add a distinct, unchecked and optional checkbox: **“Email me PoolDocAI news, product updates, newsletters, and new articles. (optional)”**. The waitlist does not require selecting it.

## Private deliverable and regression evidence

- Full protected Preview release archive: `PoolDocAI_Waitlist_Email_OptIn_Protected_Preview_2026-10-27.zip`, kept outside this **public** repository. SHA-256: `3a950e840f41501a19c428e77fa0f80ec433a2a0b56c587e30da67872c0b2bd0`. 740,737 bytes; 109 archive entries; ZIP CRC test passed.
- The only approved runtime source changes are `index.html`, `app.js`, and `style.css`. One new test file and an explanatory README are included. The prior dynamic CMS bridge, protected Preview config, legal pages, original images, tracking consent, and existing Formspree endpoint are unchanged.
- 26 local structural/unit checks passed, including four consent regression checks. Original homepage regression check passed.
- Real Chromium submission simulation (network mocked, NO Formspree requests): 360px and 1280px, both checked/unchecked: 4/4 passed. FormData includes `email_updates_opt_in=yes` only when selected, otherwise `no`; opt-in evidence timestamp/version included only when selected. Checkbox default is unchecked, is not required, and does not create horizontal overflow.
- The previously successful hosted Preview remains unchanged until the owner explicitly redeploys the updated archive and its hosted routes are rechecked.

## Release safeguards

- The checkbox is **marketing permission only**, not automatic enrollment into an external email list. Any newsletter or article campaign must filter for `email_updates_opt_in=yes`; missing/no must not become marketing recipients. A live emailing system must honor opt-outs and applicable sender disclosures.
- No Formspree endpoint or recipient routing was changed. Source still targets `mrpppgkw`, while a separate account-transition handoff refers to `xzedoqqq`. Confirm the intended live form and conduct a labeled, fabricated-data delivery test before public launch; do not silently redirect real customer data.
- Protected Preview `review-adapter.js` intentionally prevents live waitlist submission. Do not infer Formspree delivery from the simulated tests. Keep Preview's noindex/auth protection and don't run `vercel --prod`.
