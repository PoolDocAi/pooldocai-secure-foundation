# PoolDocAI Resources — launch-critical gates (2026-10-27)

**Review-only plan. No Production DDL, data migration, PR merge or deployment authorized by this document.**

## Scope: launch the marketing Resources Hub with owner-managed content

Must launch:
- Existing approved marketing design, hero, mobile navigation, original legal pages, waitlist, two legacy Resources URLs.
- Footer: Resources · Privacy Policy · Terms of Service · Contact (mailto:hello@pooldocai.com). Neither legal document is a draft.
- Secure owner Resources Studio: edit the two historical articles and import any of the other 32 allowlisted approved resources. No re-deploy per article.
- Dynamic published-only delivery for **all** future articles, no static slug allowlist; sitemap/Hub updated on publication, immediate 404/index/sitemap removal on archive/unpublish.
- Explicit version-and-checksum owner release gate; private draft/revision isolation, rollback, permissions, observability, and live URL reachability.

Deferred, not blockers:
- Owner-managed Navigation & Folders database migration; temporary approved navigation snapshot remains available. No unpublished folder is exposed.
- Analytics persistence, additional resources import/publication, diagnostic-learning approval, external integrations.

## Verified now

- Supabase CMS Staging `rzkgmvyyeclrpomrlyft` has a tested owner lifecycle: new article -> review -> approve -> authorize exact revision -> live HTTP 200 -> Hub/sitemap -> archive HTTP 404 -> restore private draft HTTP 404. Two live legacy articles unaffected.
- Preview owner-review alias is protected and CMS routing corrected; PR #26 remains a draft.
- Existing Supabase **core Production** project `owfeebydlyacssqpnmkq` **does not contain** `resources_cms` or its public index/article RPCs. Supabase account lists only these two projects. No Production CMS exists yet.
- Marketing CMS bridge is code prepared under `resources-cms/marketing-review/`; its private, original marketing package must be preserved. The public GitHub mirror is NOT a deployable replacement for the complete approved marketing source.
- PR #25 contains legal/footer candidate; PR #26 contains owner publishing and dynamic marketing bridge; neither is merged. No Production deployment verified.

## Current Production preflight findings — read-only, verified

- **Approved architecture:** existing Production Supabase project `owfeebydlyacssqpnmkq`, new isolated `resources_cms` schema. This is **not** an authorization to apply SQL migrations or publish articles.
- Production Postgres **17.11**, nine recorded schema migrations, 44 existing public tables, four Auth users. Neither `resources_cms` schema nor `resources_cms_runtime` / `resources_cms_command_owner` database roles exists yet.
- The exact verified owner email/account in CMS Staging does **not** exist in Production Auth (compared by hash without disclosing email or credentials). Owner must create/invite and verify a Production Auth identity, then bootstrap only that Production UUID as CMS owner, with account acceptance and permissions checks. **Never copy Staging's user UUID or credentials into Production.**
- Existing `owner-publication.sql` is **Staging-specific**: it requires 46 recorded migrations, a Staging owner UUID, baseline function hashes, and seeds `owner_release_policy.destination='staging'`. **Do not run this unchanged against Production.** Produce and independently review a Production migration which uses the actual authenticated Production owner ID, avoids hardcoded Staging migration counts/hashes, and initializes an enabled `production` destination only after explicit owner release approval. Preserve the Staging migration separately.
- Supabase custom schema `resources_cms` must be explicitly listed in **Data API > Exposed schemas** before CMS RPCs work. Grant only minimal schema USAGE and carefully allowlisted function EXECUTE. Do **not** apply broad example SQL that grants ALL to anon/authenticated on CMS tables or routines.
- Production security advisors report existing core-application `SECURITY DEFINER` function-access warnings and RLS informational notices. These predate the CMS migration and must be reviewed, not swept away by adjusting production grants.
- Owner private ZIP: checksum verifier PASS; **34** catalog entries = 32 approved additions + two historical. Among the additional 32, **26** are not asset-gated, **5** require asset review (05/14/15/16/17), and **one** remains blocked (13). The catalog does not preauthorize public release or diagnostic knowledge use.
- Read-only SQL preflight: `PRODUCTION-CMS-PREFLIGHT-READONLY.sql`. Keep all change authorization separate from these checks.

## Critical release sequence

### Gate A — Choose and authorize Production CMS isolation
Recommended lower-friction option: a separately protected `resources_cms` schema in the existing core Production Supabase project, **only if** a security/permission audit confirms isolation from the multi-tenant diagnostics schema and existing app tables. Alternative: a dedicated new Supabase Production CMS project for stronger operational separation, with any associated cost explicitly approved. Either way **Staging must remain separate**; do not use Staging as the permanent public origin.

Before DDL: capture backup, schema snapshot, table/RPC permissions, Auth and role invariants, and migration history. Review migrations as one explicit, independently approved Production change. No automatic copying of Staging Auth users/sessions.

### Gate B — Production owner and content
Bootstrap owner's verified CMS identity and least-privilege membership; verify hosted login, CSRF, password recovery, and session expiry. Import only the **two** already approved historical source snapshots with provenance and checksum verification. Re-authorize those exact revisions in Production; don't migrate the staging test article or automatically publish 32 additional draft resources. Verify owned source catalog can import any of the 32 as private drafts, respecting Resource 30 exclusion and asset rights holds.

### Gate C — Protected marketing Preview integration
Start from the owner-approved **complete marketing source** and legal PR #25 content (not a partially populated public mirror). Use `vercel.cms-preview.json` and preview build from existing marketing source; keep deployment protection. Set `CMS_PUBLISHED_DELIVERY_ENABLED=1`, `PUBLIC_RESOURCES_SUPABASE_URL` and publishable key to **Staging only for protected Preview testing**. No service-role/database credential.

Verify across desktop/mobile: homepage and assets unchanged, both published articles HTTP 200, novel published article HTTP 200, archived article HTTP 404, dynamic Hub/sitemap, links, headers, policies, and no stale cached fallback. Verify corrections to Vercel rewrite routing in actual hosted deployment.

### Gate D — Owner-authorized public cutover
Use the reviewed Production content target, not Staging. The marketing Production bridge requires `PUBLIC_RESOURCES_PRODUCTION_PROJECT_REF`, `PUBLIC_RESOURCES_STAGING_PROJECT_REF` (different valid project references), `PUBLIC_RESOURCES_SUPABASE_URL` matching the Production project, `PUBLIC_RESOURCES_PUBLISHABLE_KEY`, and `CMS_PUBLISHED_DELIVERY_ENABLED=1` before building and serving. The build and handler now reject a mismatched Production target.

Get explicit owner approval for exact production build/deployment and domain mapping. Validate current approved marketing design, policies, footer, waitlist/Formspree notification behavior, resource content provenance, and public owner-to-site editorial release with no redeploy. Confirm SSL, no duplicate static article shadowing, noindex only on protected Preview, and no unexpected redirects.

### Gate E — After launch
Observe logs for HTTP 5xx/404, API usage and security events. Add scheduled public health checks for the two articles, Hub, sitemap, and a deliberately unpublished slug. Keep backups and documented rollback/recovery. New approved imports proceed independently of the marketing release. Do not enable folder/taxonomy/discovery flags until independent RPCs and Staging migration gates are satisfied.

## Current blockers (not to paper over)

1. No Production CMS schema/project is configured.
2. The full approved marketing package and CMS integration are not yet verified together in a hosted marketing Preview.
3. PR #25/26 and code-only new URL verification still require test review. Preview branch is not Production.
4. Production Auth/owner migration, static-shadow removal, and real public domain smoke/regression checks are not complete.
5. Automated *external* reachability monitoring is not yet installed; the CMS owner-editor check catches same-origin HTTP/HTML failure after release but is not a substitute for testing `pooldocai.com`.

**No folder migration is required for the initial Resources release. Do not relax editorial holds or diagnostic-knowledge safeguards to accelerate release.**
