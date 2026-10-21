# Implementation manifest

## Included release
- Existing public multi-page site and demo.
- Supabase company portal, authenticated troubleshooter, technician PWA, and platform-owner review page.
- Migrations `202610210001`–`202610210011` for privacy-minimized case capture, technician job records, company portal, separated manual consent, document extraction/chunks, security hardening, durable document jobs, audit and approved shared retrieval.
- Supabase Edge Function `clever-handler` with explicit auth/membership/seat permission checks, server-side eight-turn demo counters, company invitation/seat management, document processing and global account-status actions.
- Node document worker and Render/Docker configuration.
- Vercel configuration, GitHub workflow, clean-install instructions, action audit, security baseline, test plan and SQL smoke tests.
- Platform-owner portal for company/subscription state, global Auth/membership status, page/usage events, company creation/cancellation/restoration and subscription seat limits.
- Company-admin seat management with plan-capped membership invites, safe seat suspension/reactivation, per-seat job-note view/edit and document upload/extracted-text review permissions.
- Private company document upload/import, extraction/OCR/chunk indexing, company-private retrieval, and opted-in lesson distillation into a pending human-review queue.

## Checks completed while assembling this ZIP
- 31 inline website JavaScript blocks passed `node --check`.
- `document-worker/src/server.js` passed `node --check`.
- `vercel.json`, `document-worker/package.json`, and technician web manifest passed JSON parsing.
- TypeScript parser reported no syntax diagnostics for the Edge Function; type-checking was not possible in this environment because Deno globals and the `npm:` Supabase import are provided by the Supabase Edge Runtime.
- Browser source scan found no service-role key, Gemini key, or worker secret in `website/`.

## Not yet verified
- SQL migrations have not been executed against a live Supabase/Postgres instance in this environment.
- No live Supabase Auth/RLS two-company test was run.
- No real PDF/OCR upload, Render worker runtime, Gemini request, Vercel deployment or production smoke test was performed.
- The security test plan is therefore a required staging gate, not a claim that production security has been certified.


### Reliability and company administration update (2026-10-21)
The canonical Render service definition is `document-worker/render.yaml`; the redundant root-level `render.yaml` has been removed. The worker `/process` endpoint now requires an HMAC-SHA256 signature over `timestamp.rawBody` by default, with a 5-minute clock-skew window. Sign requests with `X-PoolDocAI-Timestamp` (Unix seconds) and `X-PoolDocAI-Signature` (lowercase hex HMAC-SHA256). Do not enable legacy shared-secret-only mode in production. The durable queue poller continues to process jobs internally. Existing installs should apply migrations 008–011 after 001–007. Migration 011 repairs the public demo quota function and adds the explicit platform-owner-only company creation policy. Migration 009 provides company-member note/document permissions and subscription seat enforcement; 010 repairs trigger/policy setup idempotently. See `README_UPDATE_20261021_EXISTING_INSTALL.md`.
