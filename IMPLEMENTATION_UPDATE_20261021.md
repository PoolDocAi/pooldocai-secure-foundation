# PoolDocAI implementation update — 2026-10-21

This update preserves the existing vanilla HTML troubleshooting UI, Edge Function action router, document worker, Supabase schema, PWA, and public marketing pages. It is additive except for removing the duplicate root Render service definition; `document-worker/render.yaml` is the canonical worker deployment file.

## Included in this update
- Shared `website/js/core.js` navigation and UI helpers are loaded by the app, admin, technician, learning review, demo, pricing, and how-it-works pages. Existing inline logic remains intact. Client-side UI is not an authorization boundary.
- Learning review supports editing the proposed lesson, a source-excerpt placeholder when the backend does not return a distinct excerpt, keyboard shortcuts outside text fields (A approve, R reject, E edit), and a chemical/water-balance safety warning. Server-side approval also checks for a reviewer note indicating qualified senior/manager sign-off for detected chemical/dosing lessons.
- Additive migration 007 adds constrained queue states, review queue and job indexes, safety flag metadata, and updated_at maintenance. Apply after 001–006.
- Worker `/process` uses HMAC-SHA256 signatures by default: `HMAC(secret, timestamp + '.' + rawRequestBody)`, timestamp is Unix seconds, signature is 64-character hex, and maximum clock skew is five minutes. `DOC_WORKER_REQUIRE_HMAC=false` is only for controlled local compatibility testing and must not be used in production. The internal database queue poller is unchanged.
- GitHub Actions workflow runs worker syntax checks, starts a clean local Supabase stack, applies migrations, and executes `supabase/tests/security_review.sql`.

## Safety and governance decisions
- No SMS/email approvals were added.
- No automatic approval of troubleshooting or chemical dosing advice was added. Confidence scores are not treated as proof of safety. Low-risk metadata can be categorized/indexed within existing access permissions; lessons still require platform-owner approval.
- Shared knowledge remains a separate table and does not train or fine-tune a model. Company manual reference availability is separate from shared-learning consent.
- Document processing now conservatively tags recognized manufacturers (Pentair, Hayward, Jandy/Fluidra, Raypak) and equipment categories when evidence is present; unknown values remain null. These tags support future warranty/service trend filters without claiming warranty status. Sales pages now explain the privacy and approval model and describe Pro/Enterprise workflow direction without inventing finalized prices.
- Offline status UI should only claim records are synced when a real durable outbox and server acknowledgement exist. This update deliberately does not show a misleading sync count based solely on service-worker cache state.

## Validation status
Run the included CI workflow and `SECURITY_TEST_PLAN.md` before production use. Local syntax and static checks are not proof of live tenant isolation. Validate HMAC signatures with a real integration test before exposing `/process` to any caller.
