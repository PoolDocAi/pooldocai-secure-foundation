# PoolDocAI — current release

For the existing PoolDocAI pilot, start with **[`README_FEATURE_EXPANSION_20261021.md`](README_FEATURE_EXPANSION_20261021.md)**. It is the source of truth for migrations, GitHub Desktop upload, deployment, invitation email setup, Stripe preparation, metering, technician offline sync, retrieval, industry modules, and production acceptance tests.

## Current architecture

- Static multi-page website and installable PWA under `website/`, hosted by Vercel.
- Supabase Auth, PostgreSQL with RLS, private Storage and Edge Functions under `supabase/`.
- `clever-handler` for authenticated application actions and a signature-verified `stripe-webhook` endpoint.
- Separate Node 22 Docker document worker under `document-worker/`, normally hosted on Render.
- GitHub Actions deploys Edge Functions and runs migration/security smoke tests on a clean local Supabase database.

## Included feature areas

- Company-scoped troubleshooting, customers, jobs, seats and granular job/document permissions.
- Private upload/extraction/OCR/wording/page-citation and hybrid keyword/vector retrieval for company documents.
- Expiring invitation/accept/resend/revoke lifecycle with trusted server-side operations.
- Platform-owner company management, account states, usage events and versioned model rate cards.
- Stripe Checkout/Billing Portal/webhook integration scaffolding. **Payments are not active until a real Stripe account, Price IDs and verified webhook signing secret are configured and tested.**
- Per-company event/token/document/storage metering. Dollar figures are estimates only, based on model rate cards. Unknown rates remain unpriced.
- Technician PWA offline outbox with idempotent sync, last-synced state and conflict retention.
- Configurable industry layer. Pool is active; HVAC and Plumbing remain planned pending reviewed equipment catalogs, diagnostics, sources and safety rules.

## Security and release limitations

A green GitHub check proves the committed local migration/test suite passed in CI; it does not prove the live Supabase project, Render worker, or Vercel pages are fully tested. Follow the two-company acceptance tests in `SECURITY_TEST_PLAN.md` before putting real customer data into the service. Use only synthetic test data until those tests pass.

The website config `website/js/config.js` contains the public publishable key for project `owfeebydlyacssqpnmkq`. This key is designed to be public. **Never include `sb_secret_...`, legacy service-role keys, Gemini keys, Stripe secrets, `DOC_WORKER_SECRET`, or `sbp_...` Supabase personal access tokens in HTML, browser JavaScript, or public commits.**

## Other guides

- [`README_START_HERE.md`](README_START_HERE.md) — quick entry point.
- [`README_FEATURE_EXPANSION_20261021.md`](README_FEATURE_EXPANSION_20261021.md) — exact existing-install instructions.
- [`README_DOCUMENT_PIPELINE.md`](README_DOCUMENT_PIPELINE.md) — document processing technical notes.
- [`SECURITY_TEST_PLAN.md`](SECURITY_TEST_PLAN.md) — security test checklist.
- [`EDGE_FUNCTION_ACTION_AUDIT.md`](EDGE_FUNCTION_ACTION_AUDIT.md) — protected action inventory.
- [`IMPLEMENTATION_MANIFEST.md`](IMPLEMENTATION_MANIFEST.md) — included component manifest.
