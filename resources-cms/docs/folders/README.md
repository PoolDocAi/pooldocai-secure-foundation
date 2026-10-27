# Resources folders and visual release

This package adds a separate navigation model; tags remain unchanged. Stable folder UUIDs survive renames, moves and ordering changes. Article canonical URLs never contain folder paths. Configurations contain the three entry paths, arbitrary folders and multi-folder assignments with one primary breadcrumb folder.

Draft navigation is saved as immutable revisions. Publication requires an owner, the exact current version/checksum and explicit `PUBLISH NAVIGATION` approval. Optimistic concurrency, an advisory transaction lock and actor-bound idempotency receipts prevent partial or replayed commands. Restoring history creates a new draft; later folder identities are retained as archived. Draft saves and restore do not change the published pointer or article publication/knowledge approval.

## Database gate — not executed

`PROPOSED-FOLDERS-V1.sql` is a versioned migration proposal, defaults to ROLLBACK and must remain separate from the unchanged Gate 3B files. It introduces only three resources_cms tables, six narrowly scoped functions, their RLS policies and immutable trigger. It changes no existing article/diagnostic tables or Auth configuration. The initial singleton state is empty; the Explore seed JSON requires a later explicit owner action. No cloud seed is included in this release.

The proposal requires a separately reviewed temporary command-owner SET-only membership and temporary schema CREATE for ownership transfer, both revoked before transaction end. Do not assume Staging grant provenance is identical to PGlite. Independently reverify current managed memberships, actor() definition, permissions, backup and migration history before seeking execution approval. No service-role or database runtime credentials are introduced.

Authenticated roles have no base-table permissions. Only CMS owners can mutate navigation; other CMS members can inspect private configurations. Anonymous access is limited to the surface-specific published projection, joined to independently verified public articles. Hidden/empty folders and draft article identifiers are removed inside the SQL RPC, before HTTP rendering. All functions use empty search_path and restricted EXECUTE; runtime roles gain no tenant access.

`CMS_FOLDERS_ENABLED` remains absent/OFF on the hosted CMS. The Navigation & Folders page explains the backend gate and exposes no writes. Do not enable until authorized migration, real Auth/RLS tests, backup/restore and exact configuration approval pass. Gate 3B alone does not enable folders or taxonomy/analytics RPCs.

## Protected marketing review

The marketing review uses a versioned release-only navigation snapshot, shared by the Hub and assistant. It associates only the two genuinely live article snapshots with two review collections. Proposed Explore folders have no published article assignments and remain absent from public projections. This snapshot is NOT the authoritative owner-managed database and is not stored in browser localStorage. After the database gate, replace the adapter's release snapshot with the public navigation RPC. Do not make a public rollout from this review source.

## Paths, limits and rollback

Duplicate sibling paths, cycles, invalid parents, malformed slugs, unknown article IDs and active children/article assignments on archive are rejected. Depth is bounded to eight levels for usability and abuse resistance; there is no fixed folder-count or name allowlist. The bounded HTTP document size is 256 KiB; scale by paginated commands before exceeding it. Reordering has explicit Earlier/Later buttons, so drag/drop is unnecessary.

Old published folder paths redirect directly to stable folder IDs, preventing redirect chains. Reuse of a reserved path by another folder is blocked. Archived or empty targets return 404, without leaking content. Article canonicals are unchanged. Folder pages remain noindex in protected Previews; future indexable collection pages require substantial editorial value.

First response to an application defect: turn the new flag OFF and return to the previous protected deployment. This preserves database navigation history. Do not roll back/drop tables after owner edits. The guarded rollback proposal is only for a pristine, untouched migration; otherwise export and preserve all revisions before independent recovery review. Backup exports include navigation snapshots. Offline restore resets navigation publication and redirects and does not replay old command receipts; fresh menu approval is required.

## Remaining integration gates

Separate permission review is required for the navigation-aware analytics SQL extension. JS event contracts are implemented, but the existing cloud analytics SQL does not yet accept folder fields. Retention/dashboard/conversion delivery remain disconnected. Preview event validation is nonpersistent. Exact Staging permission and metering authorization must be obtained before any of these proposals are run. No new paid infrastructure is required by this local release; future revision storage and events consume existing Supabase quotas.
