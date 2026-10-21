# Security baseline and boundaries

## Trust boundaries
- Browser: public anon key only. It is not a secret. The browser never receives the Supabase service-role key, Gemini key, or worker secret.
- Edge Function: validates Supabase bearer tokens with `auth.getUser`, resolves the caller's active membership from the database, and rejects suspended company/member state for company actions. It does not trust a client-supplied tenant ID by itself.
- Database: tenant-aware RLS and company-status helper functions protect company tables. Extracted chunks, document jobs, diagnostic case records, pending review queue, consent audit, shared knowledge, and review audit are denied to `anon`/`authenticated` direct access and are accessed by the trusted service role only.
- Document worker: runs separately and holds the service-role key only in its server environment. It claims jobs atomically via restricted database RPCs; clients cannot call those RPCs.
- Shared learning: private company reference chunks and pending cases are separate from `shared_learning_knowledge`. A platform owner must explicitly approve. Approval is retrieval-only, not model training.

## Authorization notes
- `platform_admins` is a trusted provisioning table. Never expose a browser action that inserts a row into it.
- Platform-owner review actions check `platform_admins` on the server on every request. A company-admin role alone is insufficient.
- Company status and membership status are checked by the Edge Function and the database membership helpers. Revocation is enforced on the next request; already-issued signed storage URLs remain valid until their short expiry, so use short TTLs and revoke access by preventing new URLs.
- RLS policy presence does not prove tenant isolation. Execute the two-company tests in `SECURITY_TEST_PLAN.md`.

## Remaining deployment responsibilities
- Configure Auth policies, email templates, MFA for platform owners, backups, monitoring/alerts and least-privilege project access.
- Test current Supabase policy semantics against the exact schema in a fresh staging project.
- Add provider spending caps, retention policy, malware scanning, richer PII detection and human QA before a broad customer launch. Regex redaction is best effort, not a guarantee.
