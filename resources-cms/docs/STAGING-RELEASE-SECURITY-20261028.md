# Staging release security checkpoint — October 28, 2026

## Verified scope

PR #27 remains an unmerged draft against `review/owner-publishing-recovery`.
Initial head: `2e76261021323b78594952d0735a85680d095944`. No submitted reviews or inline review threads.
The only reported check was Supabase Preview, skipped because per-PR branches are disabled. No GitHub Actions runs were associated with that head. The CMS workflow omitted pull requests to this base; this change adds that event and owner/media authorization tests. It contains no deployment steps or application secrets.

Vercel project `pooldocai-resources-cms-private` is READY with Vercel Authentication enabled for all deployments. Owner-review alias resolves to deployment `dpl_Z6Au5cLbsYrABmLUz9B8CE8EPpai`. It is a CLI deployment without Git source metadata; exact correspondence to a repository commit is unproven. No replacement deployment, protection change, or share link was created.

## Security repair applied only to Staging

Project: `rzkgmvyyeclrpomrlyft`. Recorded migration:
`20261028193132 resources_cms_private_media_execute_grants`.
Exact applied transaction: `supabase/schema-proposals/private-media-execute-grants-hosted.sql`.

Live ACL inspection found PUBLIC execution on four media-rights functions and three Storage helpers, contrary to the intended source grants. Rights read/write functions already check verified identity and membership; this is excessive exposure, not demonstrated anonymous write access. ACLs are now repaired as the actual NOLOGIN function owner. Authenticated rights commands/reads and Storage policy helpers retain their intended grants; anonymous rights read/write and orphan-helper execution are denied. The release-readiness and rights-validation helpers are internal only.

The repair changes no function bodies, table contents, Storage policies, content release, or feature flags. Temporary postgres SET membership was removed; the existing supabase_admin grant was preserved; no CREATE privilege was granted. Source proposal fragments now finalize grants before ownership transfer to avoid depending on managed postgres having superuser rights.

All six before/after fingerprints match:

| Object | Before and after MD5 (change detection only) |
| --- | --- |
| CMS function definitions | `c56c470112db63d0d8aeeac96fe12d28` |
| All Storage policies | `8e078b28b8088df74173c9039f0f493a` |
| Articles | `83991ede6b31fb638996131d21ebaccc` |
| Revisions | `5fdf3a5f7d1606e8d1d610b32db92ca1` |
| Editorial holds | `72db1e38868cccd4e3821362a591b591` |
| Publication dependency blocks | `f4f892650b2b91f27e4637c22e7af3c0` |

Staging baseline: 33 articles, 32 holds, 10 dependency blocks, two historical published pointers, zero scheduled articles, zero active knowledge grants, zero direct anon/authenticated CMS table grants. Bucket remains private, WebP only, 4 MiB limit. Owner release destination remains Staging; no pg_cron extension is installed.

## Validation and remaining gates

59 local checks passed: 26 owner/media/login/production-assembly tests, 30 production adapter/HTTP/migration/reachability tests, and three disabled-folder gate tests. New regression coverage recreates broad PUBLIC grants, repairs as the non-superuser function owner, checks actual API-role denials, verifies authenticated rights submission/read, and exercises private Storage upload/orphan cleanup and registered-object immutability. These use disposable PGlite databases; they do not execute the hosted scheduler or release content.

After the repair, the existing authenticated hosted browser loaded the owner dashboard (32 working drafts, one article with published working state, zero scheduled) and the private media library without an authorization error. Dashboard working-state counts differ from the two historical published pointers because a published article can have a newer private working draft. No hosted content edits, uploads, rights approvals, or releases were performed during this checkpoint; the earlier upload/archive acceptance remains the most recent full hosted write test.

Fresh Staging security advisors no longer flag anonymous media-rights read/write or the internal release helper. Remaining CMS function warnings include intentional public projections, required Storage policy helpers, and authenticated membership-guarded commands; warning count alone is not evidence of a vulnerability. Legacy core RPC warnings were not remediated by this CMS-only change. Leaked-password protection remains disabled and needs an Auth configuration/plan review before Production readiness can be claimed.

Older commands/owner-publishing migration-history gaps remain: do not replay historical SQL to manufacture entries. Reconcile installed definitions/grants to reviewed source in an isolated rehearsal before a Production migration. Scheduler remains disabled pending a fresh exact-revision owner-release design and explicit execution authorization. Folder/discovery features remain gated pending a verified-public catalog and separate migration approval. PDFs remain disabled. Production was neither queried nor changed.
