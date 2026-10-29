# Topic queue release gates — 2026-10-29

**Decision: NO-GO for activation or Production release.** Code review and isolated regression fixes are ready for draft PR #27. This document is not authorization to apply SQL, set live flags/secrets, deploy, generate paid articles or publish.

## Reviewed baseline

- PR #27 is draft/unmerged, branch `fix/cms-private-staging-media`, based on `review/owner-publishing-recovery`.
- Inspected remote head `45dd3b122f79f136e58894e4841960f432d98ac4`: both GitHub Actions jobs passed in run https://github.com/PoolDocAi/pooldocai-secure-foundation/actions/runs/40895734162 . Supabase Preview was skipped, not database acceptance. PR description still described older work and was not evidence of queue readiness.
- Issue #37 remains the product requirement: https://github.com/PoolDocAi/pooldocai-secure-foundation/issues/37 . Eight topics are seeded in the unapplied candidate, including Weekly care of your pool.
- Existing `cms-staging` checkout has unrelated uncommitted changes. Work was isolated in `cms-topic-review` on the draft branch; those files were preserved.

## Corrected defects

- Topic controls used a single-element selector as a collection, stopping page initialization. Replaced those selectors and removed the invalid call on the topic selector itself.
- Add now carries a stable UUID generated once per open form. The SQL candidate returns the existing matching operation on retry, rejects changed payload/actor reuse, and serializes additions before checking capacity.
- SQL rejects NULL action, ID, version and payload and non-object payloads. Stale versions use null-safe comparison. Stalled recovery preserves the three-attempt cap. Queue functions execute as the restricted NOLOGIN command owner rather than the migration executor.
- Create retries reopen the existing article even with the original topic version. A lost create acknowledgement can be recovered without writing another article or paying for another generation; edits/revisions remain intact. A persisted draft can complete a stalled association without another claim.
- Request bodies are capped while streaming. Provider calls use a fixed endpoint, reject redirects, cap response bytes, reject blocked/truncated output, exclude thought parts, disable thinking, and log only allowlisted usage measurements.
- Citation candidates require grounding support indices with matching text byte offsets. Search hits alone are insufficient. Unsafe citation URLs and duplicate normalized sources are rejected; model-invented source IDs remain rejected. These checks establish structural provenance, not factual correctness or publisher trust.
- Topic startup fails unless the deployment is Preview and targets the exact reviewed Staging URL. Existing Origin/CSRF, owner membership and normal private-draft dispatch remain authoritative. SQL quota/conflict errors become safe 429/409 responses.

## Verified locally

- Focused queue/provider/complete-article tests: synthetic PostgreSQL-compatible PGlite, HTTP boundary tests and mocked Gemini responses. Includes NULL bypasses, restricted function ownership, attempt cap after recovery, ten-claim daily quota, lost responses, replay, oversized inputs, forged/unsupported citations, provider failure/truncation, Staging target checks and Origin/CSRF rejection.
- Full queue plus existing article SQL and PostgreSQL adapter: complete article becomes one normal immutable draft; owner edit creates revision two; replay preserves that edit, no extra generation; public article/index remain unreachable, knowledge grants and publication authorizations remain empty.
- Existing production adapter/publication suite passes (30 tests); owner publication, login and branch deployment-suppression regressions pass.
- Real browser on loopback at 390px and 1440px: add -> select -> create -> existing editor -> reopen, no second generation, no script errors, no page overflow, WCAG A/AA scan passes. Identity, DB and writer are synthetic; this is not hosted acceptance.
- Review-only CI now runs the new generator/SQL/adapter tests and browser flow. Current-head CI must be inspected after push; the baseline run cannot attest to subsequent commits.

## Blocking gates and next actions

| Gate | Status | Required evidence / action |
| --- | --- | --- |
| SQL release package | BLOCKED | Candidate has not been applied remotely. Generate a migration only after explicit authorization and independent review of actual Staging history, role grants and function ownership. PostgreSQL 17 hosted ownership transfer needs the existing grantor-specific temporary SET-membership/revocation procedure; isolated superuser PGlite does not validate that managed-role procedure. Test actual JWT-bound actor, inactive owner/editor/viewer/anon denials and direct-table denial. |
| Production target isolation | CODE PASS; operational check required | Exact target plus Preview enforced. Independently verify SSO/deployment protection and that project rzkgmvyyeclrpomrlyft has not been promoted to Production under the separate promotion proposal. Production queue activation remains unsupported. |
| Paid generation budget | BLOCKED | Approve and enforce a verified billing ceiling/provider quota, including Search charges and failed requests; reconcile usage logs with provider accounting. Ten claims/day and token caps are finite usage bounds, not a monetary guarantee. No live key inspected and no paid requests made. |
| Request lifetime | CODE CANDIDATE; HOSTED BLOCKED | A specific Vercel function for topic creation now requests **maxDuration 120s**, while the general CMS function stays at **30s**. The exact create-article path is rewritten to the dedicated function and still passes through the existing origin/CSRF, Auth membership, and SQL claim controls. The two Gemini calls remain individually bounded; actual max-duration availability depends on plan/runtime/Fluid compute settings. Verify the rewrite and 120s function setting on the exact protected Preview, run realistic latency/timeout tests with a metered test call only after separate owner authorization, and confirm retry semantics on interrupted execution. This candidate improves the synchronous pilot path; a durable background job is still preferred before large-scale launch. No deployment or hosted runtime change has been made. |
| Grounding/provider contract | BLOCKED | Verify pinned model availability, current generateContent response schema/byte-offset semantics, citations/redirect destinations and Google Search attribution/display requirements on an explicitly authorized Staging sample. No arbitrary source fetcher was added. Support metadata cannot prove that the writer's claims follow the source or defeat all prompt injection. |
| Editorial completeness | BLOCKED | Fact-check each significant claim, prices, chemical safety and manufacturer procedures against primary sources; require explicit NEEDS VERIFICATION markers for unresolved claims. Validate substantive original prose, related-article suggestions, accessible comparisons/checklists, full regeneration/section rewrite and revision comparison requirements in Issue #37; these are not all implemented. Initial eight drafts have not been generated. |
| Hosted owner acceptance | BLOCKED | After separate SQL/deployment/paid-use approval, one owner-authenticated complete Staging article must open in the editor, survive edit/save/retry and remain absent from public delivery, sitemap, diagnostic knowledge and approved/held content. Repeat phone/desktop UX against the exact deployed commit. |
| Production recovery/publication | BLOCKED | Existing Issue #33 recovery/security and exact-revision owner publication gates still apply. This work grants no approval, hold removal, image rights, PDF/scheduler activation or public release. |

No Staging/Production SQL, flag, secret, deployment, publication or existing manuscript was changed by this engineering review.

### Hosting duration reference

Verified provider documentation: https://vercel.com/docs/functions/configuring-functions/duration . Fluid compute defaults to 300s for current Hobby/Pro Node functions, and a 120s override is within documented bounds when Fluid compute is enabled. Non-Fluid Hobby max remains 60s. Check actual private CMS project settings and usage/billing before enabling; this migration changes source configuration only and does not attest to hosted configuration or reliability.
