# PoolDocAI QA checklist

## Model routing
- [ ] “My heater is clicking” routes to Gemini 2.5 Flash-Lite.
- [ ] Simple error-code explanation routes to Flash-Lite.
- [ ] Ordinary troubleshooting routes to Gemini 2.5 Flash.
- [ ] Complex multi-symptom/repeated failure routes to Gemini 3.8 Flash.
- [ ] Model failure does not cause repeated costly retries.

## Cost abuse
- [ ] 19th call in rolling hour is rejected for same session.
- [ ] Daily cap is enforced atomically across concurrent requests.
- [ ] Quota database/RPC failure blocks model calls (fail closed).
- [ ] Fresh session bypass test documented; add auth/CAPTCHA for public launch.
- [ ] Provider spending alerts and hard quotas configured.

## Privacy
- [ ] Test email, phone, address, introduced name, structured identity keys.
- [ ] Ensure raw request body and image bytes are never logged.
- [ ] Ensure new learning tables reject anon/authenticated access.
- [ ] Confirm no raw conversation/photo is stored.
- [ ] Test false negatives for unusual names/addresses; fail closed if detection uncertain.
- [ ] Audit waitlist/Formspree, analytics, existing database tables and provider retention.

## Learning loop
- [ ] Save only redacted case metadata and redacted step outcomes.
- [ ] Resolve case with outcome code and technician verification.
- [ ] Unverified cases cannot enter approved knowledge retrieval.
- [ ] Admin review requires authenticated authorization.

## Chemistry and UI
- [ ] Negative values blocked; non-numeric and missing required fields blocked.
- [ ] pH < 6.2 or > 10.0 stops automatic treatment and recommends technician.
- [ ] Free chlorine > total chlorine rejects submission.
- [ ] Navigation reads Home / How It Works / Try the Demo / Pricing / Help & Safety / Join the Pilot.
- [ ] Mobile menu opens, links work, and closes after navigation.

## Photo recognition
- [ ] JPEG/PNG/WebP size limit enforced.
- [ ] Candidate brand/model is confirmed by user before being treated as known.
- [ ] Blurry/uncertain images request a clearer photo or typed label.
- [ ] No image bytes persisted or logged.


## Technician PWA checks
- [ ] Apply `202610210002_technician_job_records.sql` before deploying the Edge Function.
- [ ] Set `TECHNICIAN_ACCESS_CODE` as a Supabase Edge Function secret; verify wrong/missing codes are rejected.
- [ ] Test a manually entered job with notes only, steps only, resolution only, and a linked existing case.
- [ ] Test voice dictation on supported mobile browsers and typed fallback on unsupported browsers.
- [ ] Verify offline draft remains local and is not represented as database-saved.
- [ ] Confirm PII redaction limits, shared-code pilot limitation, and role-based auth are addressed before production launch.
- [ ] Install PWA on Android/iOS, verify icon, standalone launch, and update behavior.
- [ ] Check the website for feature-status labels that imply active functions are unavailable; retain planned labels only for genuinely inactive features.


## Company portal and demo gate
- [ ] Replace the public Supabase anon-key placeholder in `admin.html` and `app.html`; never paste a service-role key.
- [ ] Apply company portal migration and verify all RLS policies in Supabase.
- [ ] Create two test companies with separate admin and technician users. Confirm cross-company SELECT/UPDATE/storage access is denied.
- [ ] Confirm company admins can change member roles only within their company; seat-limit trigger rejects additional active seats.
- [ ] Confirm only platform admins can create companies or change plan/billing state.
- [ ] Confirm customer PII is not accessible to unauthenticated users or another company.
- [ ] Upload a sample PDF SOP and verify only company members can open its signed URL.
- [ ] Confirm `/app.html` requires login and the Edge Function rejects missing/invalid JWTs or inactive company membership.
- [ ] Confirm the public demo permits eight troubleshooting turns per demo mode and then shows the waitlist callout.
- [ ] Confirm selecting a photo on the public demo never sends the file and displays the waitlist callout.
- [ ] Confirm page-view counts appear in the platform-owner dashboard after deployment.
- [ ] Verify invitation queue workflow, billing-provider integration, and customer-data retention policy before production.

## Learning loop and manual consent additions
- [ ] Apply migrations 001–006 in order on a clean staging project. Run `supabase/tests/security_review.sql` and complete `SECURITY_TEST_PLAN.md`.
- [ ] Upload a company manual with the shared-learning checkbox unchecked; verify `reference_enabled=true`, `shared_learning_opt_in=false` in `company_manuals`.
- [ ] Opt the manual in and out; verify consent changes and that opting out never changes `reference_enabled`.
- [ ] Save a technician PWA job; verify a `diagnostic_cases` row and pending `learning_review_queue` item are created with `source_kind='technician_job'` and the company tenant.
- [ ] Submit an authenticated dashboard troubleshooter turn; verify a pending `learning_review_queue` item with `source_kind='authenticated_troubleshooter'`.
- [ ] Confirm queued records remain `pending` and are not treated as approved shared knowledge until reviewed.
- [ ] Do not sign off manual AI retrieval until document text extraction, company-scoped retrieval, and consent-aware manual ingestion have been implemented and tested.


## Company document extraction and retrieval

- [ ] Migration `202610210005_document_extraction_retrieval.sql` applied after migrations 001–004.
- [ ] Document worker `/health` returns healthy; worker service has its private Supabase and Gemini secrets; `DOC_WORKER_SECRET` stays server-side. Edge Function uses the database queue and does not require `DOC_WORKER_URL`.
- [ ] PDF with selectable text extracts successfully and becomes `ready`.
- [ ] Scanned PDF uses OCR; test image formats JPEG, PNG and HEIC/HEIF.
- [ ] DOCX and legacy DOC extract; HTML upload and public webpage URL import extract.
- [ ] Opted-out manual is retrievable only by its company and never enters `learning_review_queue`.
- [ ] Opted-in manual content enters pending review, not approved shared knowledge.
- [ ] Withdrawing consent rejects pending queue items while keeping `reference_enabled=true`.
- [ ] Authenticated troubleshooting returns company-specific source snippets where relevant.
- [ ] Cross-company retrieval test returns no chunks from another tenant.
- [ ] Invalid/private webpage URLs and redirects are rejected; worker secrets never appear in browser source or logs.

- [ ] Confirm the public demo counter displays the remaining turns for the selected mode and updates when switching modes.
- [ ] Confirm Homeowner Triage allows eight unique turns and blocks turn nine.
- [ ] Confirm Field Tech Mobile App allows its own eight unique turns and blocks turn nine, independent of Homeowner Triage usage.
- [ ] Confirm the header includes a Demo link and Account Login, no unauthenticated Technician Troubleshooter link, and evenly spaced navigation tabs.
