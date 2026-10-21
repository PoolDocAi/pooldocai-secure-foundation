# Edge Function action authorization matrix

The `clever-handler` endpoint is configured with gateway JWT verification disabled because it also serves the limited public demo. This makes the function's own checks mandatory. Do not remove the `auth.getUser()` and active membership lookup for protected operations.

| Action | Intended access | Server-side guard |
|---|---|---|
| Default troubleshooting / model triage / next step / skip / escalate | Public demo with server-enforced limited turns, or authenticated company member | Public quota for unauthenticated requests; authenticated calls require a verified bearer token and active membership/company |
| `public_page_view` | Public | Stores only sanitized path/referrer host and a one-way session hash; rate limited |
| `photo_recognition` | Authenticated company workspace | Requires `authenticatedApp: true` and a verified active company membership; image bytes are transient |
| `process_company_manual` | Company admin (or platform owner acting through a company membership) | Verified user, active company, active membership, company-admin/platform-owner role, manual ID constrained to authenticated company, server-side queue RPC |
| `import_company_webpage` | Company admin (or platform owner acting through a company membership) | Same document-admin guard; worker validates public URL and redirects against private/local network targets |
| `set_manual_learning_consent` | Company admin (or platform owner acting through a company membership) | Same company-scoped manual lookup; reference availability stays separate from shared-learning consent; consent change and revocation audit |
| `save_technician_job` | Active company admin or technician | Individual Supabase Auth required; no shared access-code/anonymous persistence; company ID comes from active membership; case is redacted and queued for review |
| `capture_learning_case` | Authenticated company member | Verified user and active company membership; issue/answer redaction; creates pending review record only |
| `list_learning_review_queue` | PoolDocAI platform owner only | Explicit `platform_admins` membership checked on every request |
| `review_learning_case` | PoolDocAI platform owner only | Explicit `platform_admins` membership; only pending item can be approved; manual consent rechecked at approval; writes audit; no model-training operation |

Unknown action strings do not grant a privileged operation; they fall through to the troubleshooting path and remain subject to public or authenticated quota/access checks. The service-role key is server-side and bypasses RLS by design, so every privileged Edge Function operation must keep its explicit user/tenant/role check.

## Review notes
- `authenticatedApp` is a client-supplied flag, not proof of identity. Identity comes from `supabase.auth.getUser(bearer)`.
- `companyId` is accepted only when it matches an active membership selected from the database.
- Membership and company status are re-read on each authenticated request; disabling a membership or suspending a company affects subsequent requests, even if the user still has a valid JWT.
- Direct access to the queue, extracted text, processing jobs and shared knowledge is revoked for `anon` and `authenticated`; only the service role can query these tables directly.
- Do not treat static route hiding, the PWA cache, or the public anon key as an authorization mechanism.
