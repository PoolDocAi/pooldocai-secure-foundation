# Automatic draft SEO descriptions

The authoring engine is `deterministic-extractive-v1`, not an LLM. Existing automated review remains deterministic screening, not factual verification. No new provider, model credential, external fact lookup, equipment specification, safety claim, citation or SEO outcome is introduced.

New uploads and create/save commands populate an absent description from complete article introduction sentences, choosing natural article-specific prose near 150 characters (90–200 accepted without forcing padding or truncation). Missing adequate prose produces a clear review warning. Existing nonempty descriptions survive article changes and empty/omitted incoming metadata; explicit nonempty editor changes remain supported. Automatic regeneration of existing descriptions is deliberately excluded.

Running automated review on a held draft with missing metadata appends a version-checked `save` revision for owners/editors when a proposal is adequate. Reviewers cannot author this correction. The returned report and editor use the newly saved version/checksum. Review never approves or publishes content or grants diagnostic knowledge access. Metadata is editable in Search & social. Preview uses saved metadata with noindex; later authorized publication uses canonical SEO/OG metadata, including legacy HTML pages whose frozen head previously bypassed revision metadata.

## Resources 06 and 10: live correction still pending

Read-only Staging inspection on October 28, 2026 confirmed both are version 1, held drafts with null published pointers and empty descriptions:

| Resource | Article | Working revision |
|---|---|---|
| 06 | cc200189-9882-4aa6-9ee2-4e9329998021 | c35ce05a-57e7-4873-8b2f-ddbf9ddcd544 |
| 10 | e517a233-aed3-418b-9cee-145f49ece512 | 43ca3923-15b8-4d1e-bb3e-6f96655de1ee |

The generator run against their actual saved bodies produced these distinct descriptions:

- 06: You test your pool, look at the results, and see a bunch of numbers: chlorine, pH, alkalinity, calcium, and more. What do they all mean?
- 10: You test your pool water, add the right chemicals, and expect clear water. But what happens when the water stays cloudy or algae keeps returning?

Both are verbatim introductory prose, not new claims. Immutable source envelopes/history are untouched.

The live save was **not executed**: Staging's actor function requires `session_user=authenticator` plus authenticated JWT claims. The operator SQL connection is not an authenticated CMS owner session. Browser session discovery timed out. Do not change that guard, forge an owner session or write directly to revision/article tables.

After this correction is available in the protected private preview, the exact supported operation is an authenticated, same-origin, CSRF-protected `POST /api/content/{article-id}/automated-review` with `{ "version": 1 }` for each article above. It re-reads the article and saves only the missing metadata using the existing command/revision workflow; a stale version fails with 409. Re-read first if version has changed. Confirm version 2, distinct revision ID, identical body, original revision unchanged, saved description, held draft state and null published pointer. Check private preview description and OG description against the saved field. No publication or authorization operation is part of this correction.

## Targeted proof

- `node --test tests/seo-description.test.mjs tests/article-intake.test.mjs tests/serverless-app.test.mjs`: 17 passed.
- `node --test tests/seo-description-postgres.test.mjs`: 1 passed; actual local PostgreSQL-compatible adapter, immutable original, new metadata revision, no public reachability. Synthetic identity transport only.
- `node tests/seo-description-browser.mjs`: passed at 390px and 1440px using installed Edge; generated field visible/editable, human description persists through save, review version updates, accessibility checks pass, no page errors. Local synthetic identity/database; not hosted owner acceptance.

No Production database, DNS/public deployment, publication authorization, 2FA, PDFs, scheduler, billing, backup or Formspree changes/checks. Existing owner acceptance and unrelated CI were not repeated. PR #34 checkbox/sanitizer files were not edited.
