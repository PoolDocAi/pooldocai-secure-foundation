# PoolDocAI Resources — Option B full-CMS Free-tier production-mode rehearsal

**Date:** 2026-10-28. **Decision:** owner selected Option B: permanently repurpose isolated CMS Staging `rzkgmvyyeclrpomrlyft` as the Production CMS. Keep core production `owfeebydlyacssqpnmkq` unchanged, stay on Supabase Free, no separate paid plan. **No public domain launch, database policy switch, production project merge or live CMS mutation has occurred.**

## Secure backup gate, in progress

Owner regained PowerShell access. An individually source-guarded, read-only `Backup-PoolDocAI-CMS.ps1` was created and delivered privately to user (SHA-256 `14fb4af4f23feb61e61645832c74598f19c3cff07eca0805ce3ce0473a1950a8`). It targets only `rzkgmvyyeclrpomrlyft`, asks for CMS credentials without logging them, runs a project identity check, creates both full-project and CMS-only `pg_dump` custom-format backups, validates expected CMS and Auth/Storage archive entries, decompresses both to NUL, computes SHA-256 manifests, and optionally encrypts both dumps using password-prompted 7-Zip AES-256 and verifies the archive. No database secrets or backup bytes belong in public GitHub.

**Awaiting owner-run backup PASS evidence.** Full restore to independent PostgreSQL and offsite copy are separate recovery gates. Storage object content is not in the SQL dump; current CMS project `storage.objects` count was 0 and CMS media count was 0, so no current CMS media object bytes are recorded.

## Pre-promotion read-only source audit

- 21 CMS tables have RLS enabled; 50 RLS policies. No direct `anon`, `authenticated`, or `service_role` table grants were listed by information_schema.
- Public read-only CMS RPCs and separately authenticated owner RPCs were enumerated.
- One active CMS owner, 5 article records: 2 published and 3 **private drafts**, including staging lifecycle test. Public index has exactly two records; 34 allowed import identities; 4 editorial holds; no CMS media.
- `owner_release_policy` currently has one row `destination='staging',enabled=true`. Its `release_info` RPC reads destination from that row, and `owner_publish` requires an enabled row with matching destination and explicit revision+checksum. A controlled production-mode publication transition **must not occur before backups**. Existing historical release records remain audit evidence.
- The Staging project also carries old **public** core application tables/functions. Supabase security lints warned about accessible `SECURITY DEFINER` RPCs and password-leak protection. None of the inspected CMS SQL functions referenced `public.` functions. These legacy APIs should be reviewed and access minimized as a separate controlled, backed-up step; do not blindly alter broad grants during launch.
- The CMS source project currently has 49 `public` tables with RLS, one anon-readable public table, 5 anon-executable and 17 authenticated-executable `SECURITY DEFINER` public functions. No CMS table lacks RLS. These are reasons to audit core API isolation, not proof of a working exploit.

## Code safeguards for explicit promotion

The historical Marketing public-delivery guard requires distinct Staging and Production project refs. The review branch now adds a **narrow exception** for owner-approved ref `rzkgmvyyeclrpomrlyft` only, requiring server-side `PUBLIC_RESOURCES_APPROVED_FREE_PROMOTION_REF` to match that exact ref alongside the exact HTTPS origin and original public delivery enable gate. It retains the default refusal of same-ref deployments. Three added tests cover missing/wrong approval, accepted exact ref, mismatched URLs, and disabled delivery. Do **not** use this exception for other deployments.

## Hosted protected production-mode dynamic CMS rehearsal

- Isolated Vercel rehearsal project: `prj_32JysC1hScWWcGPT7EWML1DTlXCX`, Vercel Authentication enabled for **all deployments**. No custom public domain.
- Owner-approved complete Marketing source reconstructed from immutable protected Preview source blobs; changed only the explicit guarded promotion target file and production Vercel routing config with runtime fixture includes. The production build removes stale static article shadow files and uses dynamic `api/cms-public.mjs` + Supabase public RPCs.
- Six encrypted Vercel **rehearsal-only production-target variables** were configured: CMS delivery enabled, exact CMS HTTPS URL, publishable API key, Production ref, former Staging ref, and exact promotion approval ref. No service-role key, no database password in the site.
- Deployment `dpl_6PM6T6MNYABpS2CrUcCAZxQ9uZ6W` at `https://pooldocai-marketing-launch-rehearsal-20261027-k6w0fkpmh.vercel.app` is **READY** (Node 24, no build failures).
- Authenticated Vercel hosted fetch: `/`, `/resources/`, `/resources/pool-pump-wont-start/`, `/resources/green-pool-first-checks/`, two collection routes, `/resources-sitemap.xml`, `/sitemap.xml`, `/llms.txt`, `/privacy.html`, `/terms.html`, `/api/public/resources`: **200**. The staging-only test draft and two other private drafts each returned **404**, no-store. Protected rehearsal has noindex headers, and the approved homepage contains the optional marketing checkbox. 
- This tests real dynamic published CMS reads under **production-mode build and runtime** but NOT authenticated owner edit/import/release, outage/rollback, or final production policy transition.

## Next mandatory gates

1. Owner reports a successful encrypted CMS database backup with SHA-256 and archive verification. Store encrypted archive offsite; verify restore in a separate environment if available.
2. Approve and execute an atomic `resources_cms.owner_release_policy` transition from `staging` to `production`; initially disable new publication and then test authenticated owner workflow before re-enabling. Preserve existing historical release records and private-draft isolation. Do not republish the 32 unreleased resources.
3. Narrow unused legacy `public` API exposure only after an independent permissions test and rollback plan, without disrupting Auth/CMS.
4. Owner exercises login, edit, revision approval, new import as draft, new production revision publication, sitemap appearance, and unpublish returning HTTP 404 on the protected linked CMS service.
5. Prepare public Vercel production build from complete approved source, but never expose the new site until recoverability and administrator publishing checks are confirmed. Explicit cutover authorization, TLS/SEO/robots check and rollback needed.

**No core Production database mutation, DNS/MX/DKIM changes, Formspree routing changes, PR merge or public domain cutover took place in this audit.**
