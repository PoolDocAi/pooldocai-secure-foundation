# PoolDocAI security and release test plan

Do these checks in a **disposable local Supabase container or dedicated staging project** before production. The included SQL test is a static/grant smoke test, not a substitute for two-user integration tests.

> [!WARNING]
> **Staging and Customer Data Isolation**
> `website/js/config.js` currently specifies the live production project URL (`owfeebydlyacssqpnmkq`). Vercel preview environments default to this configuration unless explicitly overridden.
> **Never run isolation tests, destructive queries, test user provisioning, or Storage testing against the live production project.**
> All multi-tenant boundary verifications must run against the local Supabase container (`supabase start` / `supabase db reset`) or an isolated staging instance.

## Required identities and fixtures
1. Create Company A and Company B with distinct test customers, service jobs, manuals and at least one extracted chunk each.
2. Create active Company A admin/technician and Company B admin/technician users. Create one ordinary company admin who is **not** in `platform_admins`; create a separate platform owner through the trusted SQL Editor.
3. Use fresh login sessions for every test. Do not copy service-role credentials into the browser.

## Expected-deny tests
- Company A technician cannot SELECT, UPDATE, DELETE, or obtain Storage download URLs for Company B customers, jobs, manuals, chunks or document-processing jobs.
- Company A admin cannot approve/reject learning queue items, list the global review queue, read shared-learning audit logs, or insert into `platform_admins`.
- A suspended company and a suspended membership lose access on the next API/database request. Sign out/in to test the browser UI, too.
- After a membership is deactivated or removed, an already-open session cannot continue using the Edge Function for company operations.
- A user with no active company membership cannot invoke authenticated company operations by changing `companyId` in request JSON.
- An anonymous user cannot call the document worker queue RPC, read private extracted text, access the private bucket, or call platform-owner review operations.
- Attempt to change `companyId`, `manualId`, `tenant_id`, `source_company_id`, `queueId`, and `decision` in browser requests; server-side checks must still enforce ownership and platform role.

## Storage temporary-access expiry guard (Migration 030)
- Temporary trial users authenticate via Supabase Auth.
- While the trial is active (`temporary_access_is_valid(auth.uid())` returns true), authenticated users can upload and download objects within their permitted path.
- Upon expiration or revocation of the trial:
  - Direct REST/SDK requests to Supabase Storage `storage.objects` are rejected by the restrictive policy `temporary_access_storage_expiry_guard`.
  - Storage download URLs and upload attempts immediately fail closed even if the JWT has not yet expired.

## Case-level learning consent & dual-opt-in (Migration 031)
- Explicit case-level permission (`case_learning_opt_in: boolean`) and applicable terms version (`learning_terms_version`) are persisted on `diagnostic_cases`.
- Queueing for shared-learning review requires **both** the governing company to have opted in (`companies.diagnostic_learning_opt_in === true`) **and** the case to have explicit opt-in (`diagnostic_cases.case_learning_opt_in === true`).
- Publishing via `review_learning_case` atomically rechecks both opt-ins before publishing to `shared_learning_knowledge`.
- Case consent withdrawal:
  - Invoking `withdraw_case_learning_consent` or updating `case_learning_opt_in` to false immediately triggers `pooldocai_audit_case_learning_consent()`.
  - The trigger deletes any published lesson derived from this case from `shared_learning_knowledge`, resets `approved_for_learning = false`, and rejects pending review queue items.
  - The private diagnostic case record in `diagnostic_cases` remains completely intact for internal company workspace use.

## Authenticated browser state teardown & cross-account isolation
- On sign-out or session expiration, `teardownAuthenticatedBrowserState()` is executed immediately:
  - `conversationHistory = []` and `sessionContext` are wiped in memory.
  - Private technician field notes form inputs (`#integratedTechNotesForm`) are reset.
  - Chat DOM container (`#walkthroughBody`) is emptied.
- Account switching:
  - Storage keys are scoped to `pooldocai.authenticatedCrossTabState.${userId}.${companyId}.v1`.
  - Switching from User A to User B loads only User B's state and displays a clean workspace if none exists.
  - User A's private diagnostic turns and equipment context never appear in User B's session.
- Public demo separation:
  - `demo.html` uses `pooldocai.crossTabState.v1`.
  - Authenticated `app.html` uses `pooldocai.authenticatedCrossTabState.*`.
  - The two keys are isolated and never cross-pollinate.

## Document processing
- Upload valid PDF, scanned PDF, DOC/DOCX, JPEG, PNG and HEIC under the 25 MB limit; confirm a job appears and moves `queued → processing → ready`.
- Upload unsupported format, malformed file, password-protected file, >25 MB file, and unreadable scan; each ends in `failed` after retries with a safe error message.
- Submit the same processing request repeatedly; active duplicate jobs must not multiply.
- Stop the worker mid-job; verify retries/recovery behavior before production. Monitor Render logs without logging document contents or secrets.
- Company A retrieval must never return Company B chunks. Disable `reference_enabled` and confirm the document disappears from private retrieval without changing learning consent.

## Learning loop
- Document reference access defaults on while shared learning opt-in defaults off.
- With opt-in off, extracted content remains private company reference material but creates no shared-manual review entries.
- With opt-in on, manual-derived lessons remain pending and are not used by shared retrieval until a PoolDocAI platform owner approves them.
- Revoke consent before approval; approval must fail. Revoke after approval; associated shared material must be removed from shared retrieval and pending items rejected.
- PWA/dashboard technician entries and authenticated troubleshooting cases enter a pending review queue after PII minimization; they do not directly publish to shared knowledge.
- Approve a case and verify it becomes available only via the approved shared retrieval RPC. Confirm no model-training job or fine-tuning operation is triggered.
- Confirm audit rows include source company, source kind, consent snapshot for manual-derived knowledge, reviewer, timestamps, and review decision history.

## Release gate
- Apply migrations 001 through 031 to an empty staging project in order and run `supabase/tests/security_review.sql`.
- Deploy Edge Function and worker; run all tests above with browser network inspection and Supabase logs.
- Confirm `SUPABASE_SERVICE_ROLE_KEY`, `DOC_WORKER_SECRET`, and AI provider keys exist only in Supabase/Render secret stores. The public anon key may appear in browser code; it is not a service secret.
- Test Android Chrome and iOS Safari, including upload cancellation, login expiry and session revocation.
