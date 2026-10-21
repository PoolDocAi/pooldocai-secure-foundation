# PoolDocAI — clean-install deployment guide

This bundle is intended to be the full repository contents for a **new/empty** Supabase, GitHub and Vercel setup. It includes the public website, authenticated company portal and troubleshooter, technician PWA, Supabase migrations/Edge Function, a separate document worker, and a platform-owner learning review screen.

> **Release status:** code and static checks are included, but this package has not been applied to your live Supabase project or deployed/verified end-to-end. Deploy first to a new staging project and complete `SECURITY_TEST_PLAN.md`. Do not put real customer data in it until those tests pass.

## What is included

- Company-isolated RLS policies and active-membership/company-status checks.
- Private `company-manuals` Storage bucket; 25 MB per-upload limit.
- Durable document job queue (`queued`, `processing`, `ready`, `failed`), atomic worker claiming, deduplication, retry/backoff and safe error reporting.
- Worker extraction for PDF (OCR fallback for scanned PDFs), DOC/DOCX/DOCM, TXT/Markdown/CSV/JSON/XML/HTML and image formats JPEG, PNG, HEIC/HEIF, WebP, TIFF, BMP and GIF. Image OCR uses Gemini. Webpage fetching blocks private/local IP destinations and validates redirects.
- Tenant-specific document chunks. Private company reference is enabled by default and does not depend on shared-learning consent.
- Automatic, privacy-minimized case capture from authenticated troubleshooting and technician PWA job entry. Captured cases remain pending review.
- Platform-owner-only approval interface at `/learning-review.html`. Only approved lessons enter `shared_learning_knowledge`; this is retrieval, not model training.
- Consent and review audit tables, test checklist, and GitHub workflow for deploying the Edge Function.

## 1. Create the Supabase project

1. Create a new Supabase project and save its project URL, project reference and public anon key.
2. Keep the **service-role key** private. Never put it in website HTML, GitHub, Vercel client environment variables, or a screenshot.
3. In SQL Editor, run each file under `supabase/migrations/` in ascending numeric order (`202610210001` through `202610210006`). Use a fresh project for this sequence; do not apply it blindly to an existing production schema.
4. Run `supabase/tests/security_review.sql`. Review failures before continuing.
5. In Authentication settings, enable email/password sign-in. Turn off public sign-up unless you intentionally implement a reviewed invitation flow. Create individual user accounts for company admins/technicians.

### Provision the first company and platform owner

After creating the first users in Authentication → Users, copy their actual UUIDs. In SQL Editor, run a reviewed version of this template with real values:

```sql
insert into public.companies(name,status,plan_name,seat_limit)
values ('Your Pilot Company','pilot','pilot',10)
returning id;

-- Use the returned company UUID and the real Auth user UUIDs below.
insert into public.company_members(company_id,user_id,role,status,display_name)
values ('COMPANY_UUID','COMPANY_ADMIN_AUTH_UUID','company_admin','active','Company Admin');

-- Run this only for the actual PoolDocAI platform-owner account.
insert into public.platform_admins(user_id)
values ('PLATFORM_OWNER_AUTH_UUID');
```

Replace all placeholders; never execute the sample unchanged. The platform-owner row is privileged and must be inserted only through trusted SQL/admin tooling, never from browser code.

## 2. Deploy the Edge Function

1. Install the Supabase CLI and sign in, or use the GitHub Actions workflow after configuring its secrets.
2. Set Edge Function secrets in Supabase Dashboard → Edge Functions → Secrets:
   - `SUPABASE_URL` — your project URL
   - `SUPABASE_SERVICE_ROLE_KEY` — server-side only
   - `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) — provider key used by troubleshooting and OCR
3. Deploy `supabase/functions/clever-handler/` as `clever-handler`.
4. `supabase/config.toml` disables gateway JWT verification for this mixed public-demo/authenticated function; protected operations must therefore keep validating the bearer token and membership/role inside the function. Never remove those checks.

## 3. Deploy the document worker

Deploy `document-worker/` as a Docker web service on Render (the included `render.yaml` is a starting point). Configure these Render environment variables as secrets:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `DOC_WORKER_SECRET` (random, long value)
- `GEMINI_API_KEY`
- Optional: `MAX_DOWNLOAD_BYTES` (hard-capped at 25 MB), `GEMINI_OCR_MODEL`

The worker polls the private queue and claims jobs using an atomic database function. Keep at least one worker instance running. The `/health` endpoint is for service health only; `/process` requires the worker secret. Never put that secret in the browser.

## 4. Publish to GitHub and Vercel

1. Create an empty GitHub repository and upload **the contents of this bundle's `PoolDocAI_Release_Bundle/` folder** to the repository root (not an extra nested folder).
2. In GitHub repository Settings → Secrets and variables → Actions, add `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF` if you want to use the included manual-dispatch deployment workflow. Restrict repository access.
3. Import that repository into Vercel. The included `vercel.json` serves the `website/` directory as the static output. Deploy the first production build.
4. In `website/admin.html`, `website/app.html`, `website/technician.html`, and `website/learning-review.html`, replace `REPLACE_WITH_SUPABASE_ANON_PUBLIC_KEY` with your **public anon key**. The public anon key is expected to be visible in browser code; service-role and provider keys are not.
5. Commit the public-key configuration and redeploy. Ensure Vercel's project root is the repository root.

## 5. Set up accounts and access

- Create a company row and active `company_members` rows through a trusted admin process.
- A company member must have `status='active'`, and the company must be `pilot` or `active`; suspended memberships and suspended companies are denied on the next server/database request.
- Company admins can manage their own company's manuals/customers/team records. Technicians can use their company workspace and save their own work as allowed by the UI/RLS policies.
- Add PoolDocAI platform owners only in `platform_admins`. A company admin who is not in that table cannot review/publish shared knowledge.
- Do not treat billing metadata as payment processing. This bundle does not charge cards or validate a payment provider webhook.

## 6. Document uploads and learning rules

1. Company admins upload directly into the private bucket under a path beginning with their company UUID. Storage RLS validates company membership/role.
2. The admin page registers the uploaded file in `company_manuals` and queues processing. It should show `queued`, `processing`, `ready`, or `failed` as the worker progresses.
3. Documents are private references by default. The shared-learning checkbox defaults off; when off, the file remains searchable by its own company but is not queued for shared learning.
4. Opted-in manual-derived material still starts as pending. A PoolDocAI platform owner must review it at `/learning-review.html`; approval checks current consent again before publishing.
5. PWA/dashboard cases are captured after best-effort PII redaction and remain pending until platform-owner review. This does not trigger model training or fine-tuning.
6. If a company withdraws a manual's consent, pending/approved manual-derived lessons are removed from shared retrieval and the revocation is audited. Company-private reference availability remains on unless an admin separately disables it.

## 7. Verify before production

Follow `SECURITY_TEST_PLAN.md` in full. In particular, create two real companies and test using separate accounts. Confirm Company A cannot retrieve Company B's jobs, customers, manuals, files or extracted text; ordinary company admins cannot list or approve the global review queue; revoked/inactive accounts lose access; and a suspended company is denied.

This bundle uses a static HTML/vanilla-JS frontend and can be migrated later, but frontend route hiding is never authorization. RLS and server-side membership checks are the security boundary.


### Reliability update (2026-10-21)
The canonical Render service definition is `document-worker/render.yaml`; the redundant root-level `render.yaml` has been removed. The worker `/process` endpoint now requires an HMAC-SHA256 signature over `timestamp.rawBody` by default, with a 5-minute clock-skew window. Sign requests with `X-PoolDocAI-Timestamp` (Unix seconds) and `X-PoolDocAI-Signature` (lowercase hex HMAC-SHA256). Do not enable legacy shared-secret-only mode in production. The durable queue poller continues to process jobs internally. Apply migration `202610210007_reliability_review_safety.sql` after migrations 001–006.
