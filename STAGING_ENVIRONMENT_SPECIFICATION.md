# PoolDocAI — Staging Environment & Infrastructure Isolation Specification

## 1. Executive Summary & Zero-Production Contact Mandate

Testing multi-tenant boundaries, payment webhooks, document processing, and administrative actions must never take place against live production infrastructure or real customer records. 

Production Project: `owfeebydlyacssqpnmkq.supabase.co` (**STRICTLY OFF-LIMITS FOR AD-HOC TESTING**)

This specification defines the dedicated, fully isolated staging equivalents across all six service pillars.

---

## 2. Infrastructure Inventory & Staging Equivalents

| Component | Production Environment | Isolated Staging Equivalent | Isolation Mechanism |
| :--- | :--- | :--- | :--- |
| **Database & Auth (Supabase)** | Project `owfeebydlyacssqpnmkq` (US East) | Disposable local container (`supabase start`) OR dedicated staging project `pooldocai-staging-east` | Separate database cluster, distinct JWT secret, forward migrations 001–032, independent storage bucket |
| **Frontend Surface (Vercel)** | `pooldocai.com`, `app.pooldocai.com` | `staging.pooldocai.com` or Vercel preview environments | Dynamic build injection of `window.POOLDOCAI_CONFIG`; `X-Robots-Tag: noindex, nofollow` headers |
| **Document Processing Worker** | Render Private Worker (Production) | Render Background Worker (`pooldocai-worker-staging`) | Docker container with staging Supabase URL and service key; separate webhook secret; isolated job queue |
| **AI Inference (Google Gemini)** | Production Cloud Project (Tier 1 Quotas) | Dedicated Google AI Project (`pooldocai-ai-staging`) | Separate `GEMINI_API_KEY`; strict $50 monthly budget hard cap; isolated model rate cards |
| **Payment & Billing (Stripe)** | Stripe Live Account (`pk_live_*`) | Stripe Test Mode (`pk_test_*`, `sk_test_*`) | Stripe test-clock simulation; test card numbers (4242...); dedicated `whsec_test_*` webhook secret |
| **Email & Lead Intake** | Formspree endpoint `xzedoqqq` | Mailpit / Formspree staging form | Catch-all test mailbox; dummy recipient domains (`@test.pooldocai.com`) |

---

## 3. Staging Configuration Details by Component

### A. Supabase Database & Edge Functions
- **Migrations:** Applied sequentially via `supabase db push` or CI `supabase db reset`. Migration 030 (Storage expiry guard), Migration 031 (Case-level dual opt-in), and Migration 032 (Public demo consent reconciliation) are active.
- **Client Configuration (`website/js/config.js`):**
  ```javascript
  window.POOLDOCAI_CONFIG = Object.freeze({
    supabaseUrl: "https://<staging-project-ref>.supabase.co",
    publicAnonKey: "sb_publishable_staging_key_here..."
  });
  ```
- **Secrets Management:**
  - `SUPABASE_SERVICE_ROLE_KEY`: Staging key only.
  - `STRIPE_WEBHOOK_SECRET`: Staging test secret (`whsec_test_...`).
  - `STRIPE_SECRET_KEY`: Staging test key (`sk_test_...`).
  - `GEMINI_API_KEY`: Staging project key.
  - `DOCUMENT_WORKER_SECRET`: Staging worker HMAC key.

### B. Vercel Web Deployment
- Previews must not inherit production `website/js/config.js`.
- Pre-build script generates `config.js` based on `VERCEL_ENV`:
  - `production` -> Production Supabase URL & Anon Key.
  - `preview` / `development` -> Staging Supabase URL & Anon Key.
- Prevent crawler indexing with security headers in `vercel.json`:
  ```json
  {
    "source": "/(.*)",
    "headers": [
      { "key": "X-Robots-Tag", "value": "noindex, nofollow, noarchive" }
    ]
  }
  ```

### C. Document Worker (Render / Docker)
- Deploy identical container image from `document-worker/Dockerfile`.
- Environment Variables:
  ```env
  PORT=8080
  NODE_ENV=staging
  SUPABASE_URL=https://<staging-project-ref>.supabase.co
  SUPABASE_SERVICE_ROLE_KEY=sb_secret_staging_service_role_key...
  ALLOWED_STORAGE_BUCKET=company-manuals-private
  WORKER_SHARED_SECRET=staging_worker_shared_secret_12345
  ALLOWED_OUTBOUND_DOMAINS=*.supabase.co,generativelanguage.googleapis.com
  MAX_FILE_BYTES=26214400
  ```
- Outbound network egress policy strictly drops non-whitelisted destinations and blocks `169.254.169.254`.

### D. Stripe Test-Mode Integration
- Configure the six canonical plans in Stripe Test Mode:
  - `solo_tech` ($49/mo, 1 seat default, fixed)
  - `solo_complete` ($89/mo, 1 seat default, fixed)
  - `pro_tech` ($149/mo, 5 seats included, fixed)
  - `pro_complete` ($249/mo, 5 seats included, fixed)
  - `fleet_tech` ($349/mo, 15 seats included, fixed)
  - `fleet_complete` ($549/mo, 15 seats included, fixed)
- Enable Stripe Test Clock to simulate subscription transitions:
  - Billing cycle renewal and invoice creation
  - Payment failure (`invoice.payment_failed` -> `past_due`)
  - Subscription cancellation and resubscription
  - Stale invoice replay testing without financial risk

### E. AI Inference Guardrails
- Model: `gemini-2.5-flash` for equipment recognition and query triage.
- Staging quota configuration:
  - Rate limit: 60 requests per minute (RPM).
  - Hard spend limit: $50/month with billing alerts at 50% and 80%.

---

## 4. Pre-Deployment Staging Verification Checklist

Prior to approving any production release from PR #14:

1. [ ] **Clean Migration Run:** Staging project successfully applies migrations 001–032 without manual intervention.
2. [ ] **Cross-Tenant Boundary Test:** Company A technician attempting to read Company B manual chunks receives 0 rows.
3. [ ] **Dual-Opt-In Verification:** Authenticated troubleshooting case with unverified contributor terms saves as `company_private` and is not queued.
4. [ ] **Fail-Closed Approval:** Simulated database error during `pooldocai_approve_learning_case` aborts without publishing to `shared_learning_knowledge`.
5. [ ] **Stale Invoice Replay:** Delayed invoice from superseded subscription does not degrade active subscription status.
6. [ ] **Browser Teardown:** Sign-out wipes `conversationHistory`, field notes forms, and cross-tab storage keys.
7. [ ] **Worker Quarantine:** Document worker successfully rejects password-protected, oversized, or malicious files.
