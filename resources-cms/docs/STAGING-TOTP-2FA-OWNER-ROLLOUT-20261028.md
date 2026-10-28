# Private Resources Studio TOTP 2FA — Staging rollout and owner enrollment

## Status (October 28, 2026)
Implementation is in draft PR #31. Existing owner admin portal `https://pooldocai-resources-cms-private-owner-review.vercel.app/admin/` **does not yet require 2FA**. Code is not deployed. This is an explicit lockout prevention requirement: do not enforce AAL2 before the owner enrolls at least a primary and backup factor.

The connected Staging Supabase project is `rzkgmvyyeclrpomrlyft`. Read-only verification found 0 total MFA factors and 0 verified factors before this PR. There has been **no Supabase schema change**, no account mutation, and no Production Supabase database change.

## What was built

- Password-only login through the feature flag `CMS_REQUIRE_TOTP_MFA=1` obtains a short-lived HttpOnly pending-MFA cookie for up to five minutes. It does **not** issue a privileged CMS session. The UI prompts for one-time code or primary factor enrollment.
- `/api/mfa/enroll` and `/api/mfa/verify` use the existing Supabase **publishable key** and the caller's own bearer token. Verification must result in a Supabase-validated AAL2 token before full access/refresh tokens are issued.
- After enforcement, every private CMS identity check and token refresh checks for `aal2`; AAL1 is denied for privileged admin, media, preview, and command requests.
- Existing owners can pre-enroll two factors with `CMS_MFA_ENROLLMENT_ENABLED=1` and `CMS_REQUIRE_TOTP_MFA=0` (pre-enforcement), using the new “Add backup authenticator” control in the private Studio. The feature flags default **off** to avoid changing deployed behavior unexpectedly.
- Secrets/QR and TOTP codes are user-visible only in HTTPS auth UI and sent directly to Supabase Auth; do not log/store/copy them or submit through chat.

## Safe activation sequence

1. **Security reconciliation:** PR #27 CMS security/integration and its Staging deployment provenance issues must be reconciled; independently review and test PR #31's authentication changes against the approved branch. Do not blindly replace the active CMS Studio with a mismatched deployment archive.
2. **Prepare protected, isolated owner-review preview** using Staging Supabase only. Confirm Vercel Authentication protection and exact `CMS_ORIGIN`. Set `CMS_MFA_ENROLLMENT_ENABLED=1` and leave `CMS_REQUIRE_TOTP_MFA=0`; never turn the latter on first.
3. **Owner-operated step:** Sign in to this authenticated owner preview, open **Add backup authenticator**, and scan/register a **primary** and a **separate backup** TOTP device. The operator must enter each six-digit code privately into the Studio. Verify Supabase `auth.mfa_factors` records with `status='verified'` belong to the correct owner, and test fresh sign-in via each factor (using a test session). No secrets or OTPs in logs or chat.
4. **Enforce MFA:** Set `CMS_REQUIRE_TOTP_MFA=1` on the reviewed Staging preview and redeploy the exact approved commit; keep the recovery route available but **not** as an MFA bypass. Verify AAL1 cannot read/write CMS data, AAL2 can, session refresh cannot downgrade, and bad/replayed codes fail.
5. **Review backend RLS:** Staging policies primarily invoke `resources_cms.has_role` and do not visibly require AAL2 at the policy level. Require an independent security review for any direct Supabase REST/RPC access bypass; database policy hardening must be a separate reviewed Staging migration. Avoid changing RLS ad hoc in PR #31 while PR #27 migration history remains unresolved.
6. **Owner approval and controlled final private deployment** after Staging MFA and rollback/recovery tests pass. The public marketing site (`pooldocai.com`) must remain entirely unchanged.

## Rollback/recovery
- Never disable the only factor or enforce before a backup is verified.
- Supabase Auth MFA does not issue recovery codes; store a distinct backup TOTP factor in a separate secure authenticator/device.
- The recovery password reset does **not** bypass the second factor.
- If owner loses all authenticators, stop; verify identity through a documented administrative recovery procedure rather than bypassing AAL2 in production code.

## Test evidence
Run from `resources-cms`: `node --test tests/totp-mfa.test.mjs tests/serverless-app.test.mjs tests/login-fix.test.mjs`. GitHub workflow `.github/workflows/cms-mfa-security.yml` runs this without secrets and checks syntax. Owner enrollment and a true hosted end-to-end auth test have **not** been performed.
