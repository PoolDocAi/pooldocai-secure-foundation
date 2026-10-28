# PoolDocAI Resources launch — late October 27, 2026 remote GO/NO-GO review

**Decision: NO-GO for Production domain/database migration tonight.** The owner approved the marketing, waitlist UI, and Formspree notification tests, and requested remote-only launch preparation. These approvals are not proof that Production can host and safely recover the CMS. No PowerShell or owner PC activity is needed for the completed checks.

## Verified remotely, without Production writes

| Gate | Observation | Outcome |
|---|---|---|
| Owner design acceptance | Owner reports visual mobile/desktop checks passed, and explicitly approved updated waitlist UX | PASS |
| Private marketing Preview | `dpl_661mMspSnH7tPFWdHF2meTqe5yqd`, Vercel READY; homepage, two guides, Resources Hub, collection, legal, sitemap, styles and script HTTP 200, unknown slug 404, noindex | PASS |
| Formspree form & notification | Explicitly confirmed `mrpppgkw`, expected inbox `support@pooldocai.com`; synthetic opt-in `yes` and `no` posts returned `Accepted: True`, owner confirmed both notifications arrived | PASS for submission + email delivery; stored consent field/export not separately inspected |
| Staging CMS | Project `rzkgmvyyeclrpomrlyft`: two published records, five total article rows, 21 schema tables, 26 routines, 50 policies, one active owner, 34 allowlisted imports, staging publication gate on; no Production publication policy | PASS for existing Staging condition, not new Production |
| PR #26 CI | Both "CMS security, publication, production-candidate checks" and "Marketing target isolation (partial-source review)" completed **success** for HEAD `0b5c43c04eb7d39212ecbaaf27000afdb0953b77`. "Supabase Preview" skipped. | PASS for available CI, not full hosted release |
| Core Production baseline | Read-only invariant query rerun against `owfeebydlyacssqpnmkq`: all nine unchanged counters/checksums **true** (44 application tables, 63 policies, 42 functions, 326 grants) | PASS |
| Production CMS present? | `to_regnamespace('resources_cms') IS NOT NULL` = **false** | **BLOCKED** |
| Production migration assembly | On the owner-provided isolated local review source, `node scripts/owner-production-proposal.mjs` generated 70,558-byte SQL, SHA256 `fee8352b2d2b697af2ebebf799e3ea174d1a23f94ccf45b34abcac5f5e720a56`; exactly 4 SET ROLE / 4 RESET ROLE, single transaction, release disabled, no hardcoded Staging owner | Prepared structurally; no disposable-hosted Postgres execution |
| Production restore rehearsal | Owner's prior private .dump verified by SHA-256, object metadata and decompression; **not** fully restored into an isolated database | **BLOCKED** |
| Authenticated Production owner & publication | Production owner Auth identity created but CMS membership/role not granted because schema absent | **BLOCKED** |
| Privacy marketing copy | Narrow proposed amendment recorded separately, not applied to previously approved legal text | Review pending |
| Real public domain & rollback smoke | Existing public `pooldocai.com` still serves pre-launch landing page; no Production cutover | **BLOCKED until prior gates pass** |

## Recovery path that does not need PowerShell

Supabase's official [Restore to a new project](https://supabase.com/docs/guides/platform/clone-project) can independently clone a project **if the plan/project has supported physical backups**. This method creates a new billable project, restores database-only state, and still requires separate consideration of Storage object bytes, Auth provider settings, secrets, and Edge Functions. Supabase's branch creation is another isolated testing option but creates billable usage and typically lacks Production data by default. **Neither may be initiated without the owner's explicit approval of the cost and recovery scope.** The current connected Supabase app provides no "Restore to new project" action, and existing projects have no independent branch with an actual Production backup.

Alternative: rehearse the owner's existing private backup in an isolated PostgreSQL environment under an approved secure operator/workflow. The existing private backup is on the owner's PC; it is not in this connected runtime. Do not request that backup be committed or uploaded publicly. The local archive checksum/decompression checks do not substitute for restore.

## Required sequence after backup/recovery gate

1. Use a disposable isolated environment to prove restore/recovery and rehearse the exact isolated CMS migrations, owner bootstrap, rollback behavior, and no-core-schema-drift checks.
2. Review and explicitly authorize the Production schema migrations; apply the two prerequisite CMS migrations then the reviewed disabled publication policy/owner provisioning, without ever targeting Staging data.
3. Validate Production owner login, editing of each of the two existing published articles, import of an approved new source as a private draft, exact-revision publication, withdrawal returning 404, and rollback. Keep withheld resources/asset-rights holds unpublished.
4. Confirm email marketing consent fields are recorded and that exports filter only opted-in users. Review the narrow Privacy Policy update before any optional newsletter campaign.
5. Obtain an exact production build/domain authorization; point Production website only at Production CMS, never Staging. Test two live articles, Hub, collections, RSS/sitemap if enabled, waitlist, legal, noindex removal, TLS, cache withdrawal and real rollback before announcing launch.

**Do not merge PR #26, deploy `--prod`, expose Staging RPCs on the public domain, alter DNS, change Formspree routing, or mutate the core Production schema to bypass these gates.**

This review is a snapshot of directly observed status, not a claim of background monitoring or future task completion.

## Owner decision — Full CMS only (October 28)

The owner expressly selected **"Full cms"** when offered a marketing-only launch. **Do not perform a public marketing-only cutover** or substitute static two-article delivery for a functioning owner CMS. The isolated Vercel production-mode marketing rehearsal remains valid test evidence but is **not approved for public promotion**.

Current verified remote findings:
- Staging CMS owner and public routes remain healthy: owner login and health API HTTP 200; two public articles, three private draft records (including one staging-only lifecycle test); active owner, 34 allowlist identities.
- Supabase organization `PoolDocAI` uses the **Free** plan, with two active projects `owfeebydlyacssqpnmkq` (core Production) and `rzkgmvyyeclrpomrlyft` (CMS Staging). Official Supabase Billing FAQ specifies a limit of **two active free projects**; adding a third in the same organization is not an assured no-cost path. Supabase's cost checker returned $0 for a project but does not override plan quota restrictions. A new dedicated Free organization, a paid upgrade, or a carefully authorized reuse of Staging would need a separate owner decision.
- A Supabase branch cost check returned **$0.01344/hour**. Branches do **not** copy core Production records by default and are not a verified restore of the owner's existing local PostgreSQL dump, so creating one does not solve the Production recovery requirement.
- The connected Supabase integration cannot create organizations or restore the owner's private local backup into a new database. No further Production DDL, CMS publishing switch, DNS changes, or marketing-only launch were made.

Recommended safest route: separate production CMS Supabase project, authenticated editor migration and full end-to-end tests, with source-reproducible rollback. Creating its organization/project and selecting any nonzero paid tier require explicit authorization. **Never silently repurpose Staging or mislabel it as Production**; doing so changes staging isolation, rollback and editorial source-of-truth semantics.
