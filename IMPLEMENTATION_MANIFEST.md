# Implementation manifest

## Included release
- Existing public multi-page site and demo.
- Supabase company portal, authenticated troubleshooter, technician PWA, and platform-owner review page.
- Migrations `202610210001`–`202610210006` for privacy-minimized case capture, technician job records, company portal, separated manual consent, document extraction/chunks, security hardening, durable document jobs, audit and approved shared retrieval.
- Supabase Edge Function `clever-handler` with explicit auth/membership checks for protected actions.
- Node document worker and Render/Docker configuration.
- Vercel configuration, GitHub workflow, clean-install instructions, action audit, security baseline, test plan and SQL smoke tests.

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


### Reliability update (2026-10-21)
The canonical Render service definition is `document-worker/render.yaml`; the redundant root-level `render.yaml` has been removed. The worker `/process` endpoint now requires an HMAC-SHA256 signature over `timestamp.rawBody` by default, with a 5-minute clock-skew window. Sign requests with `X-PoolDocAI-Timestamp` (Unix seconds) and `X-PoolDocAI-Signature` (lowercase hex HMAC-SHA256). Do not enable legacy shared-secret-only mode in production. The durable queue poller continues to process jobs internally. Apply migration `202610210007_reliability_review_safety.sql` after migrations 001–006.
