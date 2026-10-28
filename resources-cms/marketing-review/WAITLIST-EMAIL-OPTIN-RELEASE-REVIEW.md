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
- **Hosted Preview deployed and verified October 27 (EDT):** `dpl_661mMspSnH7tPFWdHF2meTqe5yqd` on `pooldocai-coming-soon-jtpexisbf-bersonjoshua-8595.vercel.app` is READY, target Preview only. Authenticated Vercel fetch confirmed `/`, both guides, Hub, collection path, Privacy, Terms, sitemap, `llms.txt`, robots, stylesheet, and `app.js` all return HTTP 200; nonexistent article returns HTTP 404; Preview `noindex` headers remain set.
- The hosted homepage header no longer includes the redundant early-access link (the original waitlist card heading remains). Short disclosure, unchanged `/privacy.html` and `#privacy-details` links, unchecked optional marketing checkbox, `app.js` yes/no value and opted-in-only timestamp/version are all present. Hosting only proves code delivery; **no live Formspree submission, delivery receipt, or stored-field check has been performed**. Both existing `pooldocai.com` and new Preview point to `https://formspree.io/f/mrpppgkw` (no routing change).
- **Owner visual approval recorded:** On October 27, 2026, after reviewing the hosted protected Preview, the owner replied **“Approved”** to the request to approve the concise waitlist notice, optional unchecked marketing opt-in, and removal of the redundant top navigation link. This approval is for the **marketing UI/copy and Preview behavior only**, not an authorization to deploy to Production, merge PR #26, switch form endpoints, change notifications, migrate the Production database, or publish CMS content.
- **Next gate:** Perform one labeled live Formspree submission with an opted-in test and one opted-out test (or first test the current endpoint delivery and consent values in the Formspree dashboard) and verify each stored `email_updates_opt_in` value and actual notification routing. The protected Preview blocks live form submissions via its review adapter, so passing its mocked tests is not evidence of external delivery.
- **Known discrepancy to resolve before release:** The approved landing page and existing production homepage submit to `https://formspree.io/f/mrpppgkw`, while a separate account-transition record refers to `xzedoqqq`. Do not assume these are interchangeable forms or change their destination without an independently verified routing decision. Confirm the intended mailbox and test receipt/reply.
- Independent database recovery, isolated Production CMS migration rehearsal, authenticated editor write/import workflow, and formal cutover authorization remain separate gates.

## Release safeguards

- The checkbox is **marketing permission only**, not automatic enrollment into an external email list. Any newsletter or article campaign must filter for `email_updates_opt_in=yes`; missing/no must not become marketing recipients. A live emailing system must honor opt-outs and applicable sender disclosures.
- No Formspree endpoint or recipient routing was changed. Source still targets `mrpppgkw`, while a separate account-transition handoff refers to `xzedoqqq`. Confirm the intended live form and conduct a labeled, fabricated-data delivery test before public launch; do not silently redirect real customer data.
- Protected Preview `review-adapter.js` intentionally prevents live waitlist submission. Do not infer Formspree delivery from the simulated tests. Keep Preview's noindex/auth protection and don't run `vercel --prod`.

## Owner confirmation — Formspree target

On October 27, 2026, in response to the request to confirm the **intended live waitlist endpoint**, the owner supplied **https://formspree.io/f/mrpppgkw**. Treat `mrpppgkw` as the explicitly confirmed target for this marketing waitlist, while preserving existing routing. The separate historical `xzedoqqq` reference is **not** authorization to replace the owner-confirmed target. Do not change notification recipients or any Formspree settings based on this note.

**Owner-specified notification inbox:** On October 27, 2026, the owner identified `support@pooldocai.com` as the intended/current Formspree waitlist notification recipient. This is an owner confirmation of the destination, **not technical evidence** of current Workflow routing or successful message delivery. An earlier October 25 account-transition handoff showed that `support@pooldocai.com` had been verified as a linked email but that live notifications then still went to the legacy Gmail address. An actual labeled live opted-in/opted-out delivery-and-stored-field test is still required. Do not alter Formspree recipient routing without inspecting it and obtaining authorization. Avoid claiming Formspree submission/delivery is verified until test entries and recipient delivery are observed. The protected Preview suppresses real submissions.

## October 27 — live Formspree smoke test (owner-observed)

**Form and recipient:** The owner confirmed `https://formspree.io/f/mrpppgkw` as the waitlist form and `support@pooldocai.com` as the intended notification destination. The two synthetic `Invoke-RestMethod` requests posted directly to that endpoint with distinct `email_updates_opt_in=no` and `email_updates_opt_in=yes` values and labeled QA names. The `yes` request also carried the UTC timestamp and consent-version fields; the `no` request did not.

**Observed by owner:** PowerShell printed `Consent no - Accepted: True` and `Consent yes - Accepted: True`. The owner explicitly confirmed **both notification emails arrived** at `support@pooldocai.com`. This resolves the **endpoint acceptance and notification-delivery** check for both consent selections, and supersedes earlier uncertainty about where these two notices would arrive. The form destination and recipient were **not** changed in this work.

**Scope limitation:** This is owner-reported external receipt evidence, not a direct Formspree dashboard inspection. It does **not** independently establish that Formspree stored each consent field correctly, that an export filters `yes` only, or that the protected Preview browser posted live data (its adapter intentionally blocks real submission). Do not send marketing email without verified consent filtering, sender information and unsubscribe handling. This does not authorize Production deployment or CMS migration.
