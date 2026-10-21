# PoolDocAI existing-install update guide — October 21, 2026

This guide is for updating the repository and Supabase project already used by the PoolDocAI pilot. Use this guide rather than recreating users, companies, or keys.

## What this release adds/fixes

- Changes the server-enforced and UI public demo cap to eight turns for Homeowner Triage and a separate eight turns for Field Tech Mobile App preview.
- Fixes the CI multi-statement SQL smoke-test runner: the workflow executes `supabase/tests/security_review.sql` using `psql --file` against the local Supabase database after `supabase db reset`. It pins Ubuntu 24.04 and current GitHub Actions releases.
- Includes company-manual upload, private storage, extraction/OCR/chunking/index status, private retrieval, and reviewed optional contribution to shared retrieval.
- Gives PoolDocAI platform owners a company/subscription overview, company cancel/restore (soft removal; records retained), seat limits, account/membership/Auth status, and usage event list.
- Gives company admins a team/seat interface to invite/assign, suspend/reactivate seats, and delegate job-note viewing/editing plus document upload/extracted-text review within the company's seat limit.
- Enforces subscription seat limits in PostgreSQL and prevents company admins from changing subscription-level `seat_limit` or company status directly; those controls are platform-owner-only.
- Restricts the technician service worker to its own technician route/assets so it does not intercept `/app` or `/admin` navigation.

## A. Apply database migrations to the existing correct project

The established PoolDocAI project reference is `owfeebydlyacssqpnmkq`. Open its SQL Editor: `https://supabase.com/dashboard/project/owfeebydlyacssqpnmkq/sql/new`.

If already applied successfully, do not rerun migrations 001–007. For the existing database, run these migration files in a fresh SQL Editor query, one full file per query, in order. The current version includes a forward repair for the previous eight-turn quota RPC; do not skip 011 even if 008 already ran:

1. `supabase/migrations/202610210008_public_demo_eight_turns.sql` — makes the public limit eight per server session. It is safe to rerun.
2. `supabase/migrations/202610210009_company_member_permissions_management.sql` — adds delegated permissions, team/audit fields, seat-limit enforcement and private document capabilities.
3. `supabase/migrations/202610210010_company_admin_safety_fixups.sql` — ensures the trigger replacement and platform-only company subscription controls are in place. It is intended to be safe to rerun after 009.
4. `supabase/migrations/202610210011_demo_quota_and_company_creation_fix.sql` — fixes the server-side eight-turn RPC update expression and provides the explicit platform-owner company-create policy. Run this even if migration 008 was already applied; changing an old migration file does not update an already deployed database.

Do not paste multiple migration files into one query. Stop and resolve any actual SQL error before pushing the code. Never rerun account-provisioning INSERT statements.

## B. Merge the repository files

1. Download and extract this bundle.
2. Open the existing local repository using GitHub Desktop → Repository → Show in Explorer.
3. Copy the contents of `PoolDocAI_Release_Bundle/` into that repository root, allowing matching source files and workflows to be replaced.
4. This release includes `website/js/config.js` configured for the correct project `owfeebydlyacssqpnmkq` and the public publishable key supplied for this installation. Copy it with the other files. It replaces the previous missing or misconfigured client configuration. Never substitute an `sb_secret_` key or other server-side credential.
5. Ensure `.github/workflows/security-tests.yml`, `.github/workflows/deploy-supabase.yml`, migrations 008–011, website files, worker code, and documentation are copied.
6. Commit and push to `main` with GitHub Desktop.

GitHub Actions should run on the push. The deployment workflow deploys the Edge Function only; it does not apply the live SQL migrations, which were applied manually above. If the security workflow fails, inspect the `Run SQL security smoke tests` log and share the actual PostgreSQL error; a green status has not been assumed in this bundle.

## C. Check the three deployed services

- **Supabase:** `clever-handler` deploy workflow passes; `GEMINI_API_KEY` is set as an Edge Function secret. Supabase built-in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided to the hosted Edge Function and should not be manually added as reserved Edge Function secrets.
- **Render:** document-worker remains a Docker web service using `document-worker/Dockerfile` (Node 22). It needs `SUPABASE_URL`, server-side Supabase Secret API key in the `SUPABASE_SERVICE_ROLE_KEY` environment variable, a unique random `DOC_WORKER_SECRET`, and paid `GEMINI_API_KEY`. Keep these off the browser/repository.
- **Vercel:** let the connected `main` branch redeploy. Confirm `website/js/config.js` contains the public key for project `owfeebydlyacssqpnmkq`; this release includes that configuration. Test `/demo`, `/app`, `/admin`, `/technician` and `/learning-review`.

## D. Key acceptance tests

- Both public demo modes allow eight turns each, then reject the ninth server-side. Switching modes must not share the same session counter.
- Company admins can add/reactivate only as many active seats as subscription allows; suspending a seat frees one seat but retains membership history.
- Only a platform owner can change company plan/status/seat limit or access global account status and shared-learning review.
- Company seat flags gate job-note read/write and document upload/review. Company admins retain full access inside their own active tenant.
- Uploaded documents remain private company references even when shared-learning opt-in is false. Extracted text is company-scoped; opted-in manual lessons stay pending and require platform-owner review before shared retrieval.
- Verify cross-company isolation, inactive-account revocation and company suspension using two separate test companies before adding real customer information.

Billing fields remain metadata only; no payment processor/webhook is included.

### Browser Supabase configuration

This release includes `website/js/config.js` configured for project `owfeebydlyacssqpnmkq` using the public publishable key supplied for this project. Copy this file with the other bundle files. Never replace it with `sb_secret_`, service-role, Gemini, Render worker, or personal access-token credentials.
