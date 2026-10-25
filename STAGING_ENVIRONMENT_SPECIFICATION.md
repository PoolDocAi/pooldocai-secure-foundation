# PoolDocAI — Staging Environment & Infrastructure Isolation Specification

## 1. Executive Summary & Zero-Production Contact Mandate

Multi-tenant boundary verification, payment webhook handling, document processing, and administrative actions must never take place against live production infrastructure or real customer records. 

- **Production Project:** `owfeebydlyacssqpnmkq.supabase.co` (**STRICTLY OFF-LIMITS FOR AD-HOC TESTING**)
- **Target Staging State:** Isolated, non-production resources matching the actual production architecture.

This specification reconciles the staging architecture with the actual codebase, establishes fail-closed Vercel preview controls, and provides complete procedures for staging deployment, integration testing, and rollback.

---

## 2. Infrastructure Inventory & Staging Equivalents

| Component | Production Environment | Isolated Staging Equivalent | Code-Authoritative Configuration |
| :--- | :--- | :--- | :--- |
| **Database & Auth (Supabase)** | Project `owfeebydlyacssqpnmkq` (US East) | Dedicated staging project `PoolDocAI Staging` (`rzkgmvyyeclrpomrlyft`, US East 2, $0/mo) | Separate database cluster, distinct JWT secret, forward migrations 001–045, private bucket `company-manuals` |
| **Frontend Surface (Vercel)** | `pooldocai.com`, `app.pooldocai.com` | `staging.pooldocai.com` or Vercel preview URLs (`*.vercel.app`) | Build-time `scripts/generate-config.cjs` + runtime fail-closed guard; `X-Robots-Tag: noindex, nofollow, noarchive` |
| **Document Processing Worker** | Render Private Worker (Production) | Render Background Worker (`pooldocai-worker-staging`) | Docker container running `document-worker/Dockerfile`; uses `DOC_WORKER_SECRET`, `MAX_DOWNLOAD_BYTES`, `DOC_WORKER_REQUIRE_HMAC=true` |
| **AI Inference (Google Gemini)** | Production Cloud Project (Tier 1 Quotas) | Dedicated Google AI Project (`pooldocai-ai-staging`) | Dedicated `GEMINI_API_KEY`; strict $50 monthly budget hard cap; isolated model rate cards |
| **Payment & Billing (Stripe)** | Stripe Live Account (`pk_live_*`) | Stripe Test Mode (`pk_test_*`, `sk_test_*`) | Stripe test-clock simulation; test card numbers (4242...); dedicated `whsec_test_*` webhook secret |
| **Email & Lead Intake** | Formspree endpoint `xzedoqqq` | Mailpit / Formspree staging form | Catch-all test mailbox; dummy recipient domains (`@test.pooldocai.com`) |

---

## 3. Seven Grounded Prerequisites for Isolated Staging

### 1. Exact Resources Needed
1. **Supabase Staging Project:**
   - 1x Supabase Project: `PoolDocAI Staging` (ref `rzkgmvyyeclrpomrlyft`, PostgreSQL 17.11 with `extensions.vector`, ACTIVE_HEALTHY).
   - 1x Storage Bucket: `company-manuals` (private; RLS enforced).
   - 2x Edge Functions: `clever-handler` and `stripe-webhook`.
2. **Render Background Worker:**
   - 1x Background Worker service running the Docker image built from `document-worker/Dockerfile` (0.5 CPU, 512 MB RAM).
3. **Google Cloud / AI Studio:**
   - 1x Project with Gemini API enabled (`gemini-2.5-flash`, `gemini-3.8-flash`, `gemini-embedding-001`).
4. **Stripe Test Mode:**
   - 1x Stripe Test Account with 6 canonical products and prices configured (`solo_tech`, `solo_complete`, `pro_tech`, `pro_complete`, `fleet_tech`, `fleet_complete`).
5. **Vercel Preview Configuration:**
   - 1x Vercel Preview environment configuration mapping staging environment variables.

### 2. Estimated Recurring Costs
- **Supabase:** Free Tier ($0/mo) or Pro Tier ($25/mo) if compute add-ons are needed. Staging fits within standard usage allowances.
- **Render Worker:** Starter service tier (~$7/mo).
- **Google AI Studio / Gemini:** $0–$10/mo based on staging test volume; enforce $50 hard spend limit in Google Cloud billing console.
- **Stripe Test Mode:** $0/mo (free simulation environment).
- **Vercel Preview Deployments:** Included in existing team plan ($0 additional).
- **Total Estimated Staging Baseline:** ~$7 to $35/month.

### 3. Secrets and Configuration Requirements
*Never place secret values in version control or browser-accessible files.*

#### A. Document Worker (`document-worker/src/server.js`)
Configured in Render Dashboard environment settings:
```env
PORT=8080
NODE_ENV=staging
SUPABASE_URL=https://<staging-project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<staging-service-role-key>
DOC_WORKER_SECRET=<high-entropy-hmac-secret-min-32-chars>
DOC_WORKER_REQUIRE_HMAC=true
MAX_DOWNLOAD_BYTES=26214400
GEMINI_API_KEY=<staging-google-gemini-key>
GEMINI_OCR_MODEL=gemini-3.8-flash
GEMINI_EMBEDDING_MODEL=gemini-embedding-001
ALLOWED_OUTBOUND_DOMAINS=*.supabase.co,generativelanguage.googleapis.com
```

#### B. Supabase Edge Functions (`supabase/functions/`)
Configured via `supabase secrets set`:
```env
SUPABASE_URL=https://<staging-project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<staging-service-role-key>
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_test_...
GEMINI_API_KEY=<staging-google-gemini-key>
DOC_WORKER_URL=https://pooldocai-worker-staging.onrender.com/process-manual
DOC_WORKER_SECRET=<shared-hmac-secret>
STRIPE_PRICE_SOLO_TECH=price_test_solo_tech
STRIPE_PRICE_SOLO_COMPLETE=price_test_solo_complete
STRIPE_PRICE_PRO_TECH=price_test_pro_tech
STRIPE_PRICE_PRO_COMPLETE=price_test_pro_complete
STRIPE_PRICE_FLEET_TECH=price_test_fleet_tech
STRIPE_PRICE_FLEET_COMPLETE=price_test_fleet_complete
```

#### C. Vercel Preview Environment Variables
Configured in Vercel Project Settings under Environment Variables (Target: `Preview`):
```env
STAGING_SUPABASE_URL=https://<staging-project-ref>.supabase.co
STAGING_SUPABASE_ANON_KEY=sb_publishable_staging_anon_key_...
```
*Note: If these variables are missing during a preview build, `scripts/generate-config.cjs` fails closed immediately, aborting the build.*

### 4. Safe Migration Deployment Procedure
1. Verify clean baseline locally:
   ```bash
   supabase start
   supabase db reset
   ```
2. Link to isolated staging project (never production):
   ```bash
   supabase link --project-ref "rzkgmvyyeclrpomrlyft"
   ```
3. Push forward migrations (001 through 045, or execute `supabase/staging/00_apply_staging_migrations.sql`):
   ```bash
   supabase db push
   ```
4. Verify database grants and triggers against staging using `security_review.sql`:
   ```bash
   psql "<staging-db-connection-string>" -f supabase/tests/security_review.sql
   ```
5. Deploy Edge Functions to staging:
   ```bash
   supabase functions deploy clever-handler --project-ref "<staging-project-ref>"
   supabase functions deploy stripe-webhook --project-ref "<staging-project-ref>"
   ```

### 5. Two-Company Integration Test Procedure
Following migration, execute an end-to-end multi-tenant boundary test:
1. **Provision Test Tenants:**
   - Create Company Alpha (`comp_alpha_test`) and Company Beta (`comp_beta_test`).
   - Create User Alice (`alice@alpha.test`) as Company Alpha technician.
   - Create User Bob (`bob@beta.test`) as Company Beta technician.
2. **Tenant Storage Boundary:**
   - Alice uploads a field manual to `company-manuals/comp_alpha_test/manual1.pdf`.
   - Bob attempts to query chunks or download `company-manuals/comp_alpha_test/manual1.pdf`.
   - Verify: Bob receives HTTP 403 / 0 rows; cross-tenant access fails closed.
3. **Dual-Opt-In Shared Learning Verification:**
   - Alice logs a troubleshooting session and selects shared-learning opt-in.
   - If Company Alpha has `diagnostic_learning_opt_in = false` or Alice has not accepted terms in `pooldocai_legal_acceptances`, the case records as `company_private` and does not enter the global review queue.
   - If Company Alpha is opted in and Alice has valid terms, case enters `learning_review_queue`.
   - Platform owner approves: lesson publishes to `shared_learning_knowledge`.
   - Alice revokes consent: lesson is immediately deleted from `shared_learning_knowledge`.
4. **Stripe Concurrency & Webhook Replay:**
   - In Stripe Test Mode, simulate simultaneous `customer.subscription.updated` deliveries.
   - Verify: Exactly one worker claims the event; the other receives HTTP 409 Retry-After.
   - Send delayed `invoice.payment_failed` from an old subscription: verify active subscription remains untouched.
5. **Browser Teardown & Cross-Account Isolation:**
   - Sign in as Alice on `https://staging.pooldocai.com/app`. Enter private technician field notes.
   - Click Sign Out.
   - Verify: `teardownAuthenticatedBrowserState()` wipes memory, form inputs, and DOM.
   - Sign in as Bob.
   - Verify: Storage key is `pooldocai.authenticatedCrossTabState.usr_bob.comp_beta.v1` and displays clean workspace.

### 6. Preview URL and Backend-Isolation Verification Plan
1. Check Vercel build log for PR #14 preview deployment:
   - Confirm step `node scripts/generate-config.cjs` executed.
   - Confirm log line: `[generate-config] Successfully generated ... pointing to https://<staging-project-ref>.supabase.co`.
2. Inspect network tab on `https://<preview-domain>.vercel.app`:
   - Inspect `/js/config.js` response: confirm `supabaseUrl` matches staging project ref.
   - Confirm zero requests to `owfeebydlyacssqpnmkq`.
3. Negative Test (Verification of Fail-Closed Defense):
   - In a disposable test branch, unset `STAGING_SUPABASE_URL` in Vercel.
   - Confirm: Build fails with exit code 1 (`[generate-config] FATAL: Vercel preview / staging build requires STAGING_SUPABASE_URL...`).

### 7. Rollback Procedure
If staging verification identifies a regression or unexpected behavior:
1. **Frontend Rollback:**
   - Revert PR #14 preview deployment or switch Vercel preview traffic to the previous commit SHA.
2. **Edge Function Rollback:**
   - Redeploy the previous verified commit SHA (`a7ab72a`) to the staging project:
     ```bash
     git checkout a7ab72a
     supabase functions deploy clever-handler --project-ref "<staging-project-ref>"
     supabase functions deploy stripe-webhook --project-ref "<staging-project-ref>"
     ```
3. **Database Migration Rollback:**
   - Migrations 001–033 are additive and forward-only.
   - If a rollback of Migration 033 is required on staging:
     ```sql
     DROP FUNCTION IF EXISTS public.pooldocai_claim_stripe_webhook_event(text, text, integer, integer);
     ALTER TABLE public.pooldocai_stripe_webhook_events DROP COLUMN IF EXISTS claimed_at;
     ALTER TABLE public.pooldocai_stripe_webhook_events DROP COLUMN IF EXISTS attempts;
     ```
4. **Data Isolation Check:**
   - Confirm production project `owfeebydlyacssqpnmkq` was never targeted during any staging deployment, verification, or rollback step.
