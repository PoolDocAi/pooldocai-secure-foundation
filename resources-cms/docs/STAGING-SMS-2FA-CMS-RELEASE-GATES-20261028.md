# PoolDocAI Resources Studio — SMS 2FA readiness and CMS next steps
Date: 2026-10-28. Branch: `security/cms-sms-2fa-staging-20261028` / draft PR #32, stacked on MFA PR #31.

## Implementation and isolation

The custom private CMS uses Supabase Staging Auth and its verified, non-anonymous member identity. SMS here means **password THEN second-factor text code**, never SMS-only sign-in and never ChatGPT delivering the OTP.

PR #32 adds `phone` factors to verified-factor enumeration, E.164 validation, a send-code challenge endpoint, challenge-ID verification, owner login choice between SMS and TOTP, and synthetic tests for safe enrollment/phone handling. The existing TOTP backup management is retained. The MFA service still uses caller credentials plus the Supabase **publishable** key; no privileged Auth key or SMS provider credentials in repo.

**Feature remains DISABLED on deployed owner Studio.** Existing Staging has no enrolled phone or TOTP factors. The Staging CMS's `CMS_MFA_ENROLLMENT_ENABLED` and `CMS_REQUIRE_TOTP_MFA` flags default off. Under the staged implementation, the legacy enforcement flag `CMS_REQUIRE_TOTP_MFA=1` controls AAL2 irrespective of whether the enrolled factor is SMS or TOTP; rename it to a more accurate `CMS_REQUIRE_MFA` only after an independently reviewed migration path.

## Owner action that cannot be performed through this GitHub/Supabase integration

1. Choose/configure an SMS delivery provider (e.g. Twilio) in the **Staging Supabase** project `rzkgmvyyeclrpomrlyft`: Authentication → Providers → Phone. Add provider credentials *directly to the Supabase dashboard*, not in chat/GitHub. Check sender and geographic restrictions, per-message fees/billing, anti-abuse limits, and any US registration requirements. [Phone MFA](https://supabase.com/docs/guides/auth/auth-mfa/phone), [Phone Auth configuration](https://supabase.com/docs/guides/auth/phone-login).
2. Once an exact-source private Staging preview of PR #32 is security-reviewed and ready, use its owner-only enrollment UI to enter your own mobile number privately and request a text. Enter the code on that same protected Studio screen. Never send phone number or code in chat.
3. Enroll a **separate TOTP authenticator factor** as backup and test signing in with each factor. Supabase Auth has no recovery codes. Do NOT turn mandatory MFA on before one primary SMS factor + separate backup factor work.
4. Security reviewer validates AAL1 denied at all private APIs, including direct Supabase REST/RPC and policies; tests SMS resend throttling/expired challenges, replay attempts, sign-out/refresh, existing sessions, password reset, device-loss recovery. The current pending MFA cookie Max-Age=300 requires an independent review of whether expiry is enforced *server-side*, not just by browsers.
5. Enable MFA enforcement only on the reviewed protected Staging deployment with exact `CMS_ORIGIN`; verify fresh password→SMS→AAL2 login and TOTP fallback. Private production CMS deployment requires a separate owner signoff.

**Do not deploy an MFA-protected Studio without tested recovery**: the current private owner-review login still works by password and must not be accidentally locked.

## CMS release gate sequence after SMS setup

**P0 — Code/provenance and security:** Reconcile PR #27 (private media/release security) with PR #31 and #32; pin exact source and environment for Vercel owner preview. PR #27 still reports 8/60 differing deployed source files and incomplete Staging schema/grant/ledger reconciliation. Require independently validated provenance, migrations, ACLs, trigger/role behavior and AAL2-backed data access before cutover.

**P1 — Private owner preview:** Verify Staging sign-in, two MFA factors, 31 held owner-approved drafts and all additional database rows against the owner-approved manifest, reading/editing, revision approval and revocation, media storage, browser mobile/desktop, protected URLs and publication authorization. Verify that no draft is served in public Hub.

**P2 — Publication adapter:** The live `pooldocai.com` Resources Hub is currently a **static two-guide release**. CMS edits in Staging do not publish into that static Hub. Build and test read-only published-snapshot delivery to production public pages, keeping hidden drafts and private assets inaccessible.

**P3 — Recoverable Production backup:** Supabase Production `owfeebydlyacssqpnmkq` is Free, so complete an independently recoverable, encrypted `pg_dump`/restore rehearsal and protected storage **before** any production CMS schema/data changes. Do not claim a backup from a SQL listing or local staging copy.

**P4 — Controlled promotion and editorial release:** After independent staging and security approval, separately approve Production CMS migration/deploy, enable private owner CMS at an authenticated URL, and publish the first small approved wave with rollback, sitemap/canonical checks and event monitoring. Keep scheduled publication and PDF delivery disabled until their explicit gates pass.

## Current evidence

Read-only Staging queries October 28: 1 active CMS member; 33 article rows (32 draft, 1 published); 32 editorial-hold rows; zero enrolled `auth.mfa_factors`. These **row counts are not the approved editorial manifest** and require mapping/reconciliation. No Prod DB mutations, migrations, account enrollment, mail routing changes, or content publication were performed in this PR.
