# Staging deployment and migration evidence — October 28, 2026

## Checked revision and CI

PR #27 remains open, draft and unmerged. Inspected head:
`18512e8b0562278a2497b957de7328960121f706`.
GitHub Actions run [40755442778](https://github.com/PoolDocAi/pooldocai-secure-foundation/actions/runs/40755442778)
completed successfully. Both jobs passed: CMS security/publication/production-candidate checks
and marketing target isolation. Marketing's full private-package delivery remains a separate gate.

## Deployment source comparison: attestation fails

The owner-review hostname still resolves to READY CLI deployment
`dpl_Z6Au5cLbsYrABmLUz9B8CE8EPpai`. Metadata is empty and no Git source commit is supplied.
Project inspection confirms Vercel Authentication applies to all deployments.

The uploaded source inventory supplies file SHA-1 identifiers. Comparing these with
exact Git object bytes at the inspected PR head matched **52 of 60 selected files**.
Eight differ:

- `public/admin.js`
- `public/navigation-admin.js`
- `package-lock.json`
- `package.json`
- `src/production/app.mjs`
- `src/production/runtime.mjs`
- `src/production/validation.mjs`
- `vercel.json`

Evidence: `evidence/staging-deployment-source-inventory.json` and
`evidence/staging-deployment-source-comparison.json`. Reproduce from the CMS directory:

```sh
node scripts/attest-deployment-source.mjs evidence/staging-deployment-source-inventory.json 18512e8b0562278a2497b957de7328960121f706 evidence/staging-deployment-source-comparison.json
```

This compares selected uploaded source, not compiled execution. Private catalog, dependencies,
build outputs and environment settings are excluded. Do not label the existing preview as
running the PR head. No deployment, alias, protection or share-link change was made.
An exact-source private preview remains necessary to close this blocker.

## Read-only migration reconciliation

The Staging migration ledger contains 50 records: 45 core entries, isolated-v1 recorded as
`20261026042558`, and four October 28 private media repairs. The repository's isolated-v1
filename is `20261026035555`; command-v2 `20261026042156` and owner recovery have no separate
ledger entries. These are distinct version/history discrepancies, not evidence SQL is absent.

Reconstructed in disposable PGlite: isolated-v1, command-v2, ownerRecoveryProposal(),
private Storage policies, the exact identity repair, canonical object-key repair, and final
execution-grant repair. **All 31 live CMS function definitions match exactly** after trimming
outer whitespace and normalizing line endings. No body whitespace or SQL tokens are ignored.
The identity repair is needed to reproduce the exact installed Storage helper definition.

Evidence: `evidence/staging-function-reconciliation.json`. Full read-only function snapshot
is retained locally outside the repository at
`deliverables/staging-function-definitions-20261028.json` in the PoolDocAI workspace.

```sh
node scripts/reconcile-staging-functions.mjs ../../deliverables/staging-function-definitions-20261028.json evidence/staging-function-reconciliation.json
```

The rehearsal removes managed-role/preflight checks only in the disposable local database,
as existing fixtures do. It does not prove hosted role-grant behavior. Table definitions,
constraints, triggers, RLS policies, ownership and effective ACLs still require independent
comparison before authorizing any ledger repair or Production migration. No hosted SQL was
replayed and no migration history was modified. Do not push all pending historical migrations.

## Auth protection review

Fresh Staging security advisors still report leaked-password protection disabled.
The organization API reports plan `free`, tier `tier_free`. Supabase's current
[password-security documentation](https://supabase.com/docs/guides/auth/password-security)
states that leaked-password protection requires Pro or above. This is now a confirmed plan
dependency. No plan purchase, Auth configuration change, password reset or workaround was made.
The deployment's separate Vercel Authentication protection remains enabled.

## Validation and preserved state

Twelve owner-publication and media-rights tests passed on Node 24.22.1, including private
Storage role boundaries, exact-revision holds, release dependency denial and backup restoration.
Both offline evidence scripts completed successfully; deployment comparison intentionally
reports `attested: false` when source differs.

Fresh Staging counts: 33 articles, 57 revisions, 32 holds, 10 publication dependency blocks,
two historical published pointers, zero scheduled articles and no pg_cron extension. These
match the previous checkpoint. The enabled owner-release policy still targets Staging;
it is separate from scheduler activation. No content rows or policies were changed.
No publication or scheduler execution occurred. PDFs and gated features remain unchanged.
Production was neither queried nor changed. PR remains draft; no merge was performed.
