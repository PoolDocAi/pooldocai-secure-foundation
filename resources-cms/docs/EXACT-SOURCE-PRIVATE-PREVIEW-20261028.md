# Owner CMS — exact-source private review and prepublication release gate

Date: October 28, 2026. This is a **read-only Staging validation checkpoint**, not Production approval or publication.

## GitHub-sourced private preview

- **Source:** GitHub `PoolDocAi/pooldocai-secure-foundation`, branch `fix/cms-private-staging-media`, exact commit `fe6d59c399bb290dfddabb488c932fe4de6d4f69`.
- **Isolated Vercel preview:** deployment `dpl_2mAjBEhtcYDZa8xiizDF5Hrq3N3a`, READY, `https://pooldocai-resources-cms-private-git-fi-36a720-bersonjoshua-8595.vercel.app`.
- **GitHub Actions:** run `40781934808`, success, including CMS security, publication tests, marketing isolation and new Staging prepublication invariant checks.
- **Vercel protection:** target project `pooldocai-resources-cms-private` retains SSO protection for all deployments.
- **Original owner login untouched:** `pooldocai-resources-cms-private-owner-review.vercel.app` still targets existing deployment `dpl_Z6Au5cLbsYrABmLUz9B8CE8EPpai`; no aliases switched.
- **Actual build provenance:** Vercel build log confirms clone of GitHub commit `fe6d59c`. This establishes the new preview's Git commit provenance; it does not retroactively attest the older CLI deployment. Historical 52/60 source correspondence for the older deployment remains in `evidence/staging-deployment-source-comparison.json` as a separate finding.

## Verified unauthenticated route behavior (on new protected preview)

- `/api/health/resources` — 200, `{"ok":true}`.
- `/admin/login` — 200 (sign-in page).
- `/admin/` without session — shows sign-in page.
- `/resources/` — 200.
- `/resources/green-pool-first-checks/` — 200.
- `/resources/staging-publication-lifecycle-test/` — 404 (synthetic private draft unavailable).
- No private-media, owner-edit, password-reset, article-publish or content-changing route was invoked for this validation.

## Content and privilege invariants

New `scripts/verify-staging-release-gates.mjs` and `tests/staging-content-gates.test.mjs` are wired into the PR's CI and fail closed on changes to the initial private/public baseline.
`evidence/staging-content-gate-20261028.json` is a **sanitized snapshot from read-only SQL**; it is NOT continuous live monitoring, and must be refreshed after any authorized staging content changes.

Snapshot: 33 article rows, 32 working drafts, 31 **held** owner-review drafts, 1 published-state article with an editorial hold, 2 historical published pointers, 32 total holds, 0 scheduled releases, 0 knowledge grants. The unheld 32nd draft is the synthetic `staging-publication-lifecycle-test`; it has no published pointer. The actual Staging `resources_cms.public_index()` returns exactly the two previously live guide slugs: `green-pool-first-checks` and `pool-pump-wont-start`; the synthetic draft is not included.

All **21/21** resources_cms base tables have RLS enabled; `anon` and `authenticated` hold **zero direct table SELECT/INSERT/UPDATE/DELETE grants**. These catalog checks do not by themselves prove every SECURITY DEFINER/RPC and Storage policy is safe.

## Known blocker for authenticated new preview

Current Preview environment has a shared `CMS_ORIGIN` for the existing owner-review login. The Git-branch preview has a different hostname. To preserve same-origin CSRF protection, it requires a **branch-specific, exact HTTPS CMS_ORIGIN override** for `fix/cms-private-staging-media`, scoped ONLY to Preview:

`https://pooldocai-resources-cms-private-git-fi-36a720-bersonjoshua-8595.vercel.app`

An attempted branch-only environment update was **blocked by platform safety checks**, so no override was installed and no authenticated hosted login was performed on the new preview. Do **not** loosen origin validation, reuse session cookies cross-origin or change the global owner-review variable to work around this. Once an authorized Vercel operator supplies the scoped override, redeploy this reviewed commit and run an owner-controlled login and full browser acceptance.

## Still required before Production publication

1. Finish separate schema/trigger/ACL/role history reconciliation (function definitions match across 31 functions, but historical ledger versions and full hosted table/trigger/role comparison remain unresolved). Do not replay older migrations simply to fill history.
2. Owner accepts private CMS browser flows: existing login, dashboard, authoring/revisions, permissions, protected previews/media, approval and revocation, mobile UX, and backup/restore.
3. Test all secured writer and public-reader paths in isolated Staging, including source matching and content-release guards. No 2FA code deployment or change: owner explicitly deferred 2FA until later.
4. Establish **a recoverable, encrypted Production Supabase Free-plan backup** with an actual restore rehearsal and private durable storage before any Production CMS migration. Existing `backup-production-free-plan.ps1` only produces an unencrypted dump and `pg_restore --list` check; that is **not an accepted Production backup**.
5. Separately approve the Production CMS migration and published-only public delivery integration. Live `pooldocai.com` still uses a static two-guide Resources Hub; Staging edits do not automatically publish there.
6. Keep owner-held drafts unpublished, PDFs off, and scheduled publication disabled unless explicitly cleared through independent release gates.

No Production database, live domain, owner-auth settings, private media grants, or article publication was modified by this checkpoint.
