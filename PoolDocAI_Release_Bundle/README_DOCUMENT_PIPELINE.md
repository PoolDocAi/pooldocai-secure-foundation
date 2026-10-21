# PoolDocAI company document extraction and retrieval

This release adds a separate Node.js document worker plus tenant-isolated document chunks. The website and Supabase Edge Function do not expose the service-role key to browsers.

## Supported inputs

- Images: JPEG/JPG, PNG, HEIC/HEIF, WebP, TIFF, BMP and GIF. HEIC/HEIF is converted to JPEG before OCR. Gemini OCR transcribes visible labels, tables and warnings.
- PDF: text extraction first; scanned/image-only PDFs fall back to Gemini OCR.
- Word: `.docx`/`.docm` via Mammoth and legacy `.doc` via WordExtractor.
- Text-like uploads: TXT, Markdown, CSV, JSON and XML.
- HTML files and public webpage URLs. URLs behind logins are not supported. Webpage fetching blocks localhost/private IP ranges, limits redirects, and accepts only HTML/plain text.

Maximum upload/download size is 25 MB. Extracted text is capped at 1.5 million characters and 500 chunks per document. Password-protected or malformed documents can fail and display an extraction error in the company dashboard.

## Permissions model

1. Every document defaults to `reference_enabled=true`, independent of shared-learning consent.
2. Only company members' own company documents are searched; `search_company_manual_chunks` filters by the authenticated company and `reference_enabled=true`.
3. `shared_learning_opt_in` defaults to false. Opted-out content remains company-private and does not enter the shared learning review queue.
4. Opted-in extracted chunks enter `learning_review_queue` as **pending**, with PII-minimized text and a company/manual source marker. Pending is not approval: a trusted reviewer must approve a lesson before it is reused as shared guidance.
5. Turning consent off rejects that manual's pending review items. It does not disable private reference use. If content from a document was already approved into shared knowledge, platform owners must review/remove that approved lesson separately; consent withdrawal cannot automatically retract a lesson already merged into another shared source.
6. Direct technician job notes and authenticated troubleshooting cases are automatically submitted to the learning-review process by the Edge Function. They remain pending until review.

## Deployment (perform in this order)

### 1. Apply the new SQL migration

In Supabase Dashboard → SQL Editor, run `supabase/migrations/202610210005_document_extraction_retrieval.sql` after migrations `001` through `004`. This adds document status/source columns, the private chunk table, its search index/RPC, and supported storage MIME types. Do not run migration 005 before 003/004.

### 2. Deploy the document worker

Deploy the `document-worker` folder as a Docker web service. The included `document-worker/render.yaml` can be used as a Render blueprint; alternatively build with `document-worker/Dockerfile` on another Node 20+ host.

Configure these **worker environment variables** on the worker host:

- `SUPABASE_URL`: the project URL.
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase service-role key. Keep this secret on the worker host only; never paste it into HTML or GitHub source.
- `DOC_WORKER_SECRET`: a long random secret shared only with the Supabase Edge Function. Generate a new value (at least 32 random bytes).
- `GEMINI_API_KEY`: Google AI Studio API key used for OCR on images and scanned PDFs.
- `GEMINI_OCR_MODEL`: optional model name; defaults to `gemini-3.8-flash`. Verify the model is enabled for your Google AI account.
- `MAX_DOWNLOAD_BYTES`: `26214400` (optional; hard-capped to 25 MiB).

After deploy, verify the worker's `/health` endpoint returns `{"ok":true,...}`. Do not expose or log the worker secret. The worker accepts requests only with `x-pooldocai-worker-secret`.

### 3. Configure the Edge Function and durable queue

The current hardened version queues jobs in `document_processing_jobs`; the worker polls the database and claims jobs atomically. The Edge Function does not call the worker synchronously and does not need `DOC_WORKER_URL`. Keep `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `GEMINI_API_KEY`/`GOOGLE_API_KEY` in Supabase Edge Function secrets. Keep `DOC_WORKER_SECRET` on the worker host only for its protected internal endpoint; never put it in browser code.

Apply migrations `202610210001` through `202610210006` in order, then deploy `supabase/functions/clever-handler/` as `clever-handler`.

### 4. Publish the website changes

Copy the updated `website` folder contents into the actual Vercel project root (or the configured Vercel root directory), replacing the matching files. Set the Supabase **public anon key** in `website/admin.html`, `website/app.html`, and `website/technician.html` as documented in the main README. Never use the service-role key in website HTML. Commit and push to GitHub; confirm the Vercel deployment succeeded.

### 5. Verify in the company admin dashboard

1. Sign in as a company admin and open **Company SOPs and manuals**.
2. Upload a short PDF or PNG with readable text and leave shared-learning opt-in unchecked.
3. Confirm extraction status becomes `ready`, chunk count is nonzero, and shared learning shows `Opted out`.
4. Run an authenticated troubleshooting query that includes terms in the uploaded document. The company's extracted chunks should be searched first and cited in the response where applicable.
5. Opt the document into shared learning. Its chunks should appear as pending review items, not immediately approved shared guidance.
6. Opt it back out and confirm pending review items are rejected while the company reference remains enabled.
7. Test HEIC, scanned PDF, DOCX, legacy DOC, HTML file and a public webpage URL. Check extraction errors for password-protected/unsupported content.
8. Confirm a user from a different company cannot retrieve these chunks.

## Notes and limitations

- This pipeline performs text/OCR extraction and keyword/full-text retrieval, not vector embeddings. Search quality depends on wording and document text quality.
- PDF OCR uses Gemini's PDF input support; image OCR uses Gemini after image normalization. Configure the Gemini API key and monitor quota/cost.
- The worker performs basic DNS/private-network checks and manual redirect validation for webpage imports. For high-security production use, place it behind egress controls that block private/metadata IP ranges at the network layer too.
- Source page numbers are not yet mapped per chunk; the database has a nullable `page_number` field for a future page-aware PDF extractor.
- Webpage import snapshots extracted text at import time. Re-index the entry to refresh content.
- Large document processing runs asynchronously in a durable database queue with retries; the worker still needs enough memory/time for OCR and should be monitored.
- This pipeline is keyword/full-text retrieval, not vector embeddings. PII redaction is best-effort, not a guarantee.
- This source bundle has not been deployed or run against a live Supabase project. Test in a staging project before production; see `SECURITY_TEST_PLAN.md` and `README_START_HERE.md`.


### Reliability update (2026-10-21)
The canonical Render service definition is `document-worker/render.yaml`; the redundant root-level `render.yaml` has been removed. The worker `/process` endpoint now requires an HMAC-SHA256 signature over `timestamp.rawBody` by default, with a 5-minute clock-skew window. Sign requests with `X-PoolDocAI-Timestamp` (Unix seconds) and `X-PoolDocAI-Signature` (lowercase hex HMAC-SHA256). Do not enable legacy shared-secret-only mode in production. The durable queue poller continues to process jobs internally. Apply migration `202610210007_reliability_review_safety.sql` after migrations 001–006.
