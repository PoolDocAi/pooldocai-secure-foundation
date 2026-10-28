# Approved import revision mapping

An approved source file retains its original immutable revision UUIDs and source revision numbers in `owner_import_sources.envelope.history`. Those source ordinals are not assumed to be the current CMS article version: review, publication, subsequent edits and rollback may already have advanced the article.

When an approved source revision UUID is not yet present, `owner_import` appends it at `greatest(article.version + 1, max(existing revision_number) + 1)`. Its UUID, editable content, rendered HTML, original checksum and source date remain unchanged. The import audit event records an explicit `revisionMapping` with `revisionId`, `sourceRevisionNumber` and `storedRevisionNumber`. Existing database revision rows are never updated, deleted, or renumbered. An existing UUID must match the same article, editable content, rendered HTML and checksum; otherwise the entire import fails.

The working pointer moves to a protected draft only when new approved source revisions are appended. The published pointer remains unchanged. Importing an already recorded source is idempotent and does not reset a newer working draft. Importing a source must not grant publication or diagnostic knowledge approval.

The local acceptance test covers original pump import → review/approval → explicit owner publication → owner edit and publication → rollback as private draft → approved Resource 01 import. It verifies monotonic versions, unchanged earlier revision rows, the source UUID retained under its mapped database ordinal, the original source ordinal retained in provenance, explicit audit mapping, unchanged current public output, and repeat-import no-op behavior.

This is local loopback HTTP plus real PGlite database evidence with synthetic Supabase Auth/PostgREST transport. It is not a hosted Supabase validation claim.
