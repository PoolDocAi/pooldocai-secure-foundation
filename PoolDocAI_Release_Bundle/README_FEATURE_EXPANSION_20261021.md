# PoolDocAI feature expansion — existing pilot update

This guide applies to the existing PoolDocAI pilot, not a new database. Correct Supabase project reference: `owfeebydlyacssqpnmkq`. Existing Auth users, company, memberships, and platform-owner assignment should be retained.

## What's in this release

- Invitation lifecycle: trusted server-side invitation, membership suspended until acceptance, 7-day expiry, resend/revoke, audit history. Initial invitation email uses Supabase Auth mail; reliable resend needs the optional Resend configuration below.
- Stripe-ready subscription billing: Checkout, Billing Portal, verified webhook signature, event idempotency ledger, subscription status, Stripe billing period and seat quantity sync. Since no Stripe account exists yet, checkout intentionally fails closed until credentials and recurring Price IDs are configured. No card data is handled by PoolDocAI.
- Company usage metering: request counts, token reports, OCR/document characters, embedding counts, current storage bytes, estimate-only pricing from administrator-entered model rate cards, configurable usage threshold alerts, CSV export. A missing price card produces `not_priced`, not an invented dollar amount. Embedding-token usage is a character-based token estimate and is identified as such in event metadata.
- Technician offline sync: IndexedDB outbox with localStorage fallback, user/account binding, stable client UUID, automatic online retry, last successful sync display, idempotent saves, and a conflict response that retains the local queued job.
- Document retrieval: private company chunks, optional Gemini embeddings (`gemini-embedding-001`, 768 dimensions), hybrid keyword/vector query with keyword fallback, and preserved PDF page number/ranges for citations.
- Industry modules: shared configurable architecture for catalog, diagnostic workflows, safety rules, and source ranking. Pool is active. HVAC and Plumbing remain `planned`; they are deliberately blocked until their content/safety configuration has been reviewed and activated.
- Platform-only model rate-card editor; company seat permission controls; current billing-period usage window when Stripe data is present.

## 1. Migrations — apply only those not already applied

Open the correct SQL Editor: `https://supabase.com/dashboard/project/owfeebydlyacssqpnmkq/sql/new`.

For an existing database, do **not** rerun any migration that already completed. The feature migrations introduced in this expansion are:

1. `supabase/migrations/202610210012_invites_billing_usage_vector_industry.sql`
2. `supabase/migrations/202610210013_offline_sync_invitation_hardening.sql`
3. `supabase/migrations/202610210014_industry_activation_guard.sql`

If all three were already applied successfully to this correct project, do not run them again. If some were not applied, run each missing complete file in its own new SQL Editor query, in numerical order. These files create policies and triggers; they are not intended to be pasted/run as a repeated combined script. Back up production before applying schema changes and stop on any SQL error.

A read-only verification query after the feature migrations:

```sql
select
  to_regclass('public.industry_modules') as industry_modules,
  to_regclass('public.pooldocai_model_rate_cards') as model_rate_cards,
  to_regclass('public.pooldocai_usage_alerts') as usage_alerts,
  to_regclass('public.pooldocai_stripe_webhook_events') as stripe_webhook_ledger,
  to_regprocedure('public.search_company_manual_chunks_hybrid(uuid,text,extensions.vector,integer)') as hybrid_search_function;
```

Each item should be non-NULL. Also confirm the 202610210014 trigger exists:

```sql
select tgname from pg_trigger
where tgrelid = 'public.companies'::regclass
  and tgname = 'companies_industry_active_guard'
  and not tgisinternal;
```

The CLI CI workflow applies all migrations in a disposable local database; it does not apply them to the live Supabase project.

## 2. Update GitHub, Supabase Edge Functions, Render, and Vercel

1. Download/extract the ZIP; copy the **contents** of `PoolDocAI_Release_Bundle/` into the existing repository root, allowing files to be replaced.
2. Keep `website/js/config.js` from this configured bundle. It targets `https://owfeebydlyacssqpnmkq.supabase.co` and contains the public `sb_publishable_...` browser key. Never substitute a `sb_secret_...` or `sbp_...` key.
3. Preserve GitHub Actions secrets `SUPABASE_ACCESS_TOKEN` (the `sbp_...` Personal Access Token) and `SUPABASE_PROJECT_REF=owfeebydlyacssqpnmkq`.
4. Commit and push to `main`. GitHub Actions deploys `clever-handler` and `stripe-webhook` and runs the test suite against a clean local Supabase. It does not run SQL against live production.
5. Confirm Render is connected to the repository and running `document-worker/render.yaml` using `document-worker/Dockerfile` (Node 22). Render secrets: `SUPABASE_URL=https://owfeebydlyacssqpnmkq.supabase.co`, `SUPABASE_SERVICE_ROLE_KEY` containing the server-only Supabase Secret API key (`sb_secret_...`), a separate random `DOC_WORKER_SECRET`, and paid `GEMINI_API_KEY`. Optional `GEMINI_EMBEDDING_MODEL=gemini-embedding-001`; the worker defaults to this model. Keep `DOC_WORKER_REQUIRE_HMAC=true`.
6. Vercel should redeploy the `main` commit. Vercel project root should be the repository root; `vercel.json` serves `website/`.

Supabase provides `SUPABASE_URL` and the legacy `SUPABASE_SERVICE_ROLE_KEY` to hosted Edge Functions. The dashboard reserves names beginning with `SUPABASE_`; do not try to add those names as Edge Function custom secrets. Add `GEMINI_API_KEY` in Supabase Edge Function Secrets if not already there. `APP_BASE_URL=https://pooldocai.vercel.app` is optional but recommended for invitation/billing redirects.

## 3. Invitation emails and acceptance

- Add `https://pooldocai.vercel.app/accept-invite` and `https://pooldocai.vercel.app/**` (or the precise URLs appropriate to your project) under Supabase Authentication URL Configuration / Redirect URLs. Use the exact allow-list feature in the dashboard rather than a wildcard where a precise path will work.
- The initial invite is sent through Supabase Auth `inviteUserByEmail`; configure custom SMTP before real customer invitations because the default mail service has restrictive rate limits.
- For resend, add server-side Edge Function Secrets `RESEND_API_KEY` and `INVITATION_FROM_EMAIL`, using a verified sender/domain in Resend. Without these, resending returns a clear configuration error; invitations can still be revoked and audited.
- Acceptance validates the authenticated account, invite record, expiry and status before activating its membership. Expired/revoked invites must not be used to activate a seat. Revoke retains history and leaves newly invited seats suspended.

## 4. Stripe preparation (no Stripe account yet)

Billing code is present, but payments are intentionally not live until Stripe is configured. Do not add placeholder/fake credentials.

After you create a Stripe account:

1. Start in Stripe **Test mode**.
2. Create a product/recurring Price for every plan that you intend to sell. Seat count is currently represented by the quantity of the selected recurring Price, so ensure your Stripe pricing design matches that model.
3. In Supabase Edge Function Secrets, add `STRIPE_SECRET_KEY` (test key first) and the corresponding `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PROFESSIONAL`, `STRIPE_PRICE_ENTERPRISE`; configure `STRIPE_PRICE_PILOT` only if a Stripe-billed pilot plan is actually intended.
4. Register a Stripe webhook endpoint at `https://owfeebydlyacssqpnmkq.supabase.co/functions/v1/stripe-webhook`, then add the endpoint's signing secret as `STRIPE_WEBHOOK_SECRET` in Supabase Edge Function Secrets.
5. Subscribe to: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, `invoice.payment_succeeded`, and `invoice.paid`.
6. Configure the Stripe Customer Portal in Stripe Dashboard before using Manage Subscription. Test checkout, cancellation, renewal, past due, seat quantity changes and webhook duplicate delivery in Test mode. Only after verification should you consider switching the Stripe keys/prices to live mode.

Until `STRIPE_SECRET_KEY`, price IDs, webhook secret and the actual Stripe account are configured, checkout/portal is expected to return `BILLING_NOT_CONFIGURED` or a precise missing-price error. This is intentional; no unverified subscription metadata activates paid billing.

## 5. Usage, cost-rate cards, and export

- Platform owners should open the admin portal's Model Cost Rate Cards area and enter provider-verified current input/output price per million tokens for each model used. Do not guess rates. Cost is labelled as an estimate and historical events are not retroactively repriced.
- Company admins see company-specific usage. Platform owners can review/export usage across companies. Data include AI requests, provider-reported input/output tokens, document extraction characters/counts, embedding chunks, current library bytes, billing-cycle dates where known and usage-limit alerts.
- When Stripe billing-period data is unavailable, usage-period reporting falls back to the UTC calendar month. Cost remains `not_priced` until a model rate card exists. Embedding usage uses character-length-derived token estimation because that API response does not consistently report token usage.
- Metering is observability/budgeting, not a payment invoice or a substitute for Google/Stripe billing statements.

## 6. Technician offline sync

- Job entries are stored in IndexedDB first, with a localStorage fallback when IndexedDB is unavailable. When connectivity returns and the same account is signed in, the outbox retries automatically using `client_job_id` for idempotency.
- After a successful server response, the queued record is removed and `last synced` updates. If local content conflicts with an existing server job that shares the same sync ID, the UI retains the local queue item and reports a conflict rather than silently overwriting it.
- Until a conflict-resolution screen is completed, the user must manually preserve/resolve that conflicting record. Do not clear site data or uninstall the PWA while the offline queue contains unsynced jobs. Test offline creation, reload/reopen, different-user sign-in, reconnect, duplicate replay, and conflict preservation on actual mobile devices.

## 7. Retrieval, citations, and modular industry scope

- PDF parsing preserves the page number when available; scanned-PDF OCR asks Gemini to return explicit page markers. Chunks retain page start/end and the authenticated app displays these in source citations where available. Unreliable page numbers remain blank rather than invented.
- Document embeddings use `gemini-embedding-001` at 768 dimensions. If embedding generation fails, the worker logs a safe error and keeps keyword retrieval active. Hybrid retrieval always filters by company/private reference eligibility and active industry. Vector search quality must be tested with real sample manuals before relying on it exclusively.
- The Pool industry module is active. HVAC and Plumbing are schema/configuration placeholders with `planned` status. The active-industry guard intentionally blocks their workflows until appropriate OEM/manual sources, diagnostics and safety rules have been reviewed and the module explicitly activated. This release does not claim full HVAC/plumbing diagnostic competence.

## 8. Acceptance tests before production

- Run GitHub Actions workflows; the migration test must pass from a clean local Supabase reset.
- Live test invitation send, accept, expired invite rejection, resend after `RESEND_API_KEY` setup, revocation, and seat limit.
- Test Stripe webhook signature rejection, repeated event idempotency, failed payment, renewal and cancellation in Test mode after Stripe exists.
- Test rate-card-based cost estimates and confirm absent rates remain unpriced.
- Test offline queued saves and conflict retention on a real mobile browser.
- Upload a text-native PDF and a scanned PDF; check source-page citations and ensure retrieval never returns another company's source.
- Confirm Company A cannot see Company B's users, service jobs, manuals, chunks, usage or documents; company admins cannot access platform-only functions; suspended accounts/companies are denied.
- Use only synthetic data until these tests pass. Syntax checks and a green workflow do not prove live deployment correctness.
