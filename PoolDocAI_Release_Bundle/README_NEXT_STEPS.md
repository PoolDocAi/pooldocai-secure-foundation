# PoolDocAI — cost controls, triage tiers, learning loop, privacy and navigation

## Files
- `website/`: six HTML pages, friendlier consistent nav labels.
- `supabase/functions/clever-handler/index.ts`: Edge Function source with PII scrubbing, tiered model routing, photo recognition and session quota guard.
- `supabase/migrations/202610210001_learning_loop_privacy.sql`: privacy-minimized learning-loop tables and atomic session quotas.
- `.github/workflows/deploy-supabase.yml`: GitHub Actions deploy workflow.
- `QA_CHECKLIST.md`: release verification.

## Model tiers (implemented routing; verify model availability in your Google AI project)
1. **Tier 1 — Gemini 2.5 Flash-Lite**: model selection, simple questions, short/common symptoms and basic error-code explanations.
2. **Tier 2 — Gemini 2.5 Flash**: ordinary equipment troubleshooting and straightforward manual-grounded follow-up.
3. **Tier 3 — Gemini 3.8 Flash**: complex/multi-symptom, repeated-failure, dose-calculation, longer-context or root-cause requests.
4. **Vision**: Gemini 2.5 Flash for equipment/nameplate image interpretation; identification is a candidate and user confirmation is required.

Model IDs and endpoint compatibility can change; confirm they are available for your API key before production. If a model call fails, do not automatically retry repeatedly on a more expensive model.

## Session cost limits
The migration adds an atomic budget of 18 calls per session per rolling hour and 60 calls per session per UTC day. The Edge Function hashes the opaque session ID before persistence. A request is rejected when the quota guard is unavailable. These limits are a basic friction layer: a visitor can reset a browser session, and a public unauthenticated endpoint cannot guarantee one person equals one session. For stronger control, require Supabase Auth for customers/technicians, enforce per-user and per-tenant budgets, cap input/output tokens, limit image size and calls, add CAPTCHA/abuse detection, and configure Google API quotas/budget alerts. Consider lower caps for photo recognition and web-grounded calls.

## Persistent learning loop
The migration creates `diagnostic_cases`, `diagnostic_case_steps`, and `learning_review_queue`. These tables are intentionally private to the backend service role. The schema supports a learning loop, but does **not** mean automatic case capture/review UI is fully wired: the application must call approved backend write actions after PII screening, save step outcomes, submit a resolution for review, and expose an authenticated technician/admin review screen. Never train/retrieve from unverified lessons; only approved, redacted lessons should be reused.

## Privacy promise and limitation
The handler removes common PII patterns and common identity/contact keys before downstream processing. Learning tables contain no identity/contact columns and are not accessible to `anon`/`authenticated` roles. Images should not be stored; ask users not to upload images containing people or personal documents. Regex cannot guarantee recognition of every name/address in arbitrary text or imagery. For a strict no-PII guarantee, block raw text persistence, use tested PII detection with fail-closed behavior, inspect image uploads for personal content, configure provider data controls, audit logs and analytics, and security-test before public launch. The separate waitlist/Formspree collection is not covered by troubleshooting redaction and needs its own consent, access and retention policy.

## Deploy website through GitHub + Vercel
1. Extract the ZIP.
2. In `PoolDocAI/vercel`, replace the six root HTML files with the matching files in `website/` (adjust paths if your repo uses a subfolder).
3. Commit to `main`. Vercel should deploy automatically. Check Deployments and confirm the commit is the latest.

## Deploy Supabase Edge Function from GitHub
A GitHub URL alone does not deploy an Edge Function. The workflow deploys it when configured.
1. Add `supabase/functions/clever-handler/index.ts` and `supabase/migrations/202610210001_learning_loop_privacy.sql` to the repository.
2. Add `.github/workflows/deploy-supabase.yml`. Review it before enabling.
3. In GitHub repository Settings → Secrets and variables → Actions, add `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF`. Never commit API keys or service-role keys.
4. In Supabase Dashboard → Edge Functions → Secrets, set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) and verify existing `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` runtime values.
5. Apply the migration using Supabase SQL Editor or `supabase db push`. Back up production first.
6. Run GitHub Actions workflow and verify deployment logs.
7. Test the deployed endpoint with no personal data, then verify quotas, RLS, redaction, chemistry validation and model fallback behavior.

## Important remaining work
- Verify persistent case capture, approved-lesson retrieval, and the authenticated learning-review interface end-to-end against the deployed database.
- Add robust PII detection/fail-closed checks for names in free text and personal content in images; audit all existing tables/logs and the waitlist/Formspree integration.
- Add account/tenant quotas, CAPTCHA and provider-level spending alerts; session limits alone can be reset.
- Run end-to-end QA and confirm all configured model IDs are available.


## Technician Field Notes PWA (new)

Files added under `website/`: `technician.html`, `technician.webmanifest`, `technician-sw.js`, and `technician-icon.svg`. Once deployed at the site root, open `/technician.html` on a phone and use the browser's Add to Home Screen / Install option. Voice dictation uses Web Speech API where the browser supports it; a typed-note fallback is always available. Offline drafts stay in the device's local storage and are not uploaded until the technician presses **Save job to database**.

Apply `supabase/migrations/202610210002_technician_job_records.sql` in the Supabase SQL Editor. Set the Edge Function secret `TECHNICIAN_ACCESS_CODE` to a strong pilot code, then redeploy `clever-handler`. Do not put this code in HTML or GitHub; each technician enters it in the panel. The current shared-code gate is for a controlled pilot only, not production-grade identity. Before a wider launch, replace it with individual Supabase Auth accounts, tenant-level authorization/RLS, audit logs, and role-specific access.

The new `save_technician_job` action stores manual technician jobs separately from AI diagnostic steps and supports optional linkage to an existing `diagnostic_cases` UUID. All entries remain unapproved for learning until a human review process approves them. Text redaction is best-effort and cannot guarantee that every personal identifier is removed; instruct technicians not to enter customer contact details.


## Company portal, authenticated troubleshooting, and public demo limits (new)

New files and migration:
- `website/admin.html` — Supabase Auth sign-in, company overview, plan/billing metadata, service requests, technician notes, customer records, member roles, invitation-request queue, private manuals/SOP uploads, and platform-owner analytics.
- `website/app.html` — authenticated full troubleshooting workspace. The Edge Function validates the Supabase bearer token and active company membership when `authenticatedApp: true` is sent.
- `supabase/migrations/202610210003_company_admin_portal.sql` — tenant tables, RLS policies, seat-limit trigger, private `company-manuals` storage bucket, and page-view analytics table.
- Each public demo mode has an eight-turn allowance, enforced both in the UI and by the database-backed Edge Function. Homeowner Triage and Field Tech Mobile App use separate session counters.

### Required deployment steps
1. Copy the website files to the Vercel/GitHub repository, including `admin.html` and `app.html`.
2. Apply migrations in numerical order in Supabase SQL Editor, including `202610210003_company_admin_portal.sql`. Review the SQL against your existing schema before production.
3. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as Supabase Edge Function secrets (existing setup), deploy the updated `clever-handler` function, and keep all service-role keys server-side.
4. In `website/admin.html`, `website/app.html`, and `website/technician.html`, replace `REPLACE_WITH_SUPABASE_ANON_PUBLIC_KEY` with the **public anon key** from Supabase Settings → API. Never use a service-role key in browser code.
5. Create each company and its first admin using a trusted administrative process. Create individual Supabase Auth users, then insert their `company_members` row. Add your own user ID to `platform_admins` from the SQL Editor after confirming the correct Auth user UUID. Never allow public sign-up to assign platform-admin role.
6. Ensure email/password auth and password-reset email templates are configured. Invitation requests are queued in the portal; sending an Auth invite requires a trusted server-side function using the service-role key.
7. Stripe Checkout, Billing Portal, and a verified/idempotent webhook endpoint are prepared but fail closed until a real Stripe account, recurring Price IDs, `STRIPE_SECRET_KEY`, and `STRIPE_WEBHOOK_SECRET` have been configured and tested in Test mode.
8. Test company A vs company B, technician vs company admin, suspended member, seat-limit overrun, unauthenticated API call, password reset, file access, public demo ninth turn, and public photo selection before production.

### Important limitations
- Company invitations are sent by the trusted `clever-handler` action through Supabase Auth. Reliable initial mail delivery requires SMTP setup; resend requires `RESEND_API_KEY` and `INVITATION_FROM_EMAIL` server secrets.
- Stripe is prepared but remains disabled until the account, prices and webhook signature secret are configured. PoolDocAI never collects or stores payment card details.
- Page analytics record page path, referrer hostname, and a session hash; they do not capture raw IP addresses or full referrer URLs. They are basic traffic counts, not a full analytics suite.
- The existing technician PWA pilot access-code workflow remains a separate legacy route. Use the authenticated `/app.html` for the company troubleshooting workspace. Production rollout should move technician job saving entirely to per-user authenticated requests.
- Each public demo mode has an eight-turn limit enforced in the website client and by the database-backed Edge Function guard. This is a friction/cost control, not a guarantee that one person equals one browser session; the API session quotas remain separate.
- This package must still pass end-to-end tests on the live project. Run the QA checklist with two companies and synthetic records before storing customer data.


### Manual first-account provisioning (SQL Editor template)
After creating a company admin in Supabase Authentication → Users, use their actual Auth UUID in the following template. Run as the project owner in the SQL Editor; never expose an admin/service key in the browser.

```sql
-- Replace both placeholders with real values; do not paste this template unchanged.
insert into public.companies (name, status, plan_name, seat_limit, billing_status)
values ('Example Pool Company', 'pilot', 'pilot', 3, 'not_configured')
returning id;

-- Use the returned company UUID and the company's first admin Auth UUID.
insert into public.company_members (company_id, user_id, role, status, display_name)
values ('COMPANY_UUID', 'AUTH_USER_UUID', 'company_admin', 'active', 'Company Admin');

-- Add the platform owner Auth UUID separately; never expose platform-admin assignment in the UI.
insert into public.platform_admins (user_id) values ('OWNER_AUTH_USER_UUID')
on conflict (user_id) do nothing;
```

### Company manual consent and automatic learning-loop capture (migration 004)
- Apply `202610210004_company_manual_learning_consent.sql` after migrations 001–003.
- Each new manual upload defaults to `reference_enabled=true` and `shared_learning_opt_in=false`. Company admins can change the shared-learning consent on an uploaded document. Opting out does not disable its private company reference flag.
- Technician PWA job saves and authenticated dashboard troubleshooter turns are automatically captured as privacy-minimized cases and placed in `learning_review_queue` with status `pending`. They are **not** automatically approved for shared reuse: human privacy/quality review remains required.
- The current complete bundle includes the extraction/indexing worker and company-specific retrieval, but this still needs staging verification before production. Processing is queued asynchronously. Opted-in manual passages remain pending and are never immediately approved or used for model training.
- The PWA/dashboard capture uses automated text redaction, but redaction cannot guarantee removal of every identifier. Instruct technicians not to enter customer names, contact details, or addresses into diagnostic notes.


## Document extraction pipeline (new in this bundle)

For a clean install, follow `README_START_HERE.md` and apply all migrations `202610210001` through `202610210006` in order. Deploy the Edge Function and `document-worker`; set worker secrets in Render and Edge Function secrets in Supabase. The worker polls the durable database queue; `DOC_WORKER_URL` is not required by the current Edge Function.


## Latest update (Oct 21, 2026)
For the 8-turn-per-mode public demo, fixed SQL smoke test runner, company document upload/retrieval, platform-company/account/usage portal and seat-level permissions, follow `README_UPDATE_20261021_EXISTING_INSTALL.md`. Existing deployments should apply migrations 008–011 after 001–007 in numerical order. Migration 011 repairs the demo RPC update ambiguity and ensures platform-owner-only company creation. The workflow fix uses `psql --file` rather than `supabase db query --local --file` for the multi-statement security SQL.
