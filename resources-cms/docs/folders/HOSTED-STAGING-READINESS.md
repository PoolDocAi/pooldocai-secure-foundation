# Navigation & Folders — hosted Staging release gate

**State: NOT AUTHORIZED TO APPLY / NOT ENABLED.** This is a review runbook, not a migration execution record. Keep the CMS Preview protected and keep Production untouched. Publishing a menu never publishes an article.

## Verified Staging baseline (October 27, 2026)

Staging Supabase project: `rzkgmvyyeclrpomrlyft`. Read-only inspection confirmed:
- The `resources_cms_command_owner` role exists. Its pre-existing `postgres` membership is granted by `supabase_admin` with `admin_option=true, inherit_option=false, set_option=false`. Never revoke or overwrite that managed grant.
- `resources_cms.navigation_versions`, `navigation_state`, `navigation_receipts`, `navigation_query()`, and `navigation_command(jsonb)` are absent.
- The required `resources_cms.verified_public_catalog()` RPC is **absent**. Do not enable `CMS_DISCOVERY_V3` or `CMS_FOLDERS_ENABLED` until this independently verified publication gate is designed, reviewed, implemented and exercised. The existing `public_article` / `public_index` RPCs must not be silently redefined as verified-public functions.
- The two real published articles, dynamic Hub, sitemap, and withdrawal behavior have been verified in protected Preview. Their existing routes must remain functional while this feature is gated.
- No proposed Explore folder seed has been written to Staging.

## What is already prepared

- `PROPOSED-FOLDERS-V1.sql` — schema proposal with **ROLLBACK** as the final statement. It is not safe to treat this as an authorized migration or replace ROLLBACK with COMMIT without independent review.
- `PROPOSED-ANALYTICS-NAVIGATION-V1.sql` — separate optional analytics proposal, not a prerequisite for folder drafting.
- `VERIFY-READONLY.sql` and `ROLLBACK-UNTOUCHED-PROPOSAL.sql` — verification and pristine-only recovery proposals.
- `public/navigation-proposed.json` — proposed seed, which must be inserted only through a later explicit owner draft action.
- Feature gate: hosted folder flag cannot run without the discovery flag. This is a **configuration check**, not proof that the missing verified catalog or navigation RPCs have been installed. Endpoint-level authorization must still fail closed.

## Required order before any hosted enablement

1. **Review permissions and backups.** Snapshot Staging schema/grants and confirm baseline article counts and publication checksums; inventory migration history and inspect the current managed role grantor, `actor()`, and `has_role()`. Verify temporary grant ownership and cleanup instructions against Supabase's actual Postgres version.
2. **Verify the independent public catalog.** Design and approve `verified_public_catalog()` and any `verified_public_article/index/redirect/media` RPCs needed by discovery. Only genuinely authorized, independently verified published revisions may appear. Archive/unpublish must withdraw all public projections immediately, including redirects and collection assignments. Do not weaken existing owner publishing gates.
3. **Review the navigation proposal and its SQL tests.** Confirm schema isolation, least-privilege `SECURITY DEFINER` ownership, locked `search_path`, restricted EXECUTE, RLS, immutable history, cycle/path validation, stable folder IDs, owner-only commands, optimistic versioning, actor-scoped idempotency, direct redirects, and public-only surface projection. Use a disposable isolated clone first, including real Auth roles and anonymous requests.
4. **Obtain explicit approval for Staging migration application.** The code review alone or a protected Preview deployment is not authorization to execute SQL. Do not apply migrations in Production.
5. **Apply only reviewed migration(s) to Staging, with audited provenance.** Confirm no unexpected grants remain and table count/history/authorization invariants are intact. Do not import seed data, publish menus, or assign articles as part of migration.
6. **Enable protected Preview flags only after all dependent RPCs pass:** `CMS_DISCOVERY_V3=1` and `CMS_FOLDERS_ENABLED=1`. Keep the owner-review alias protected and do not touch `pooldocai.com`. Verify GET/POST navigation auth, Origin/CSRF, anonymous projection, and errors.
7. **Owner smoke test:** Save the proposed Explore structure as a *private navigation draft*, preview it, explicitly authorize publishing that exact version/checksum, then confirm only folders containing genuinely published articles appear. Verify missing/draft/withdrawn articles and empty folders stay hidden, folder redirects are one hop, breadcrumbs never change canonical article URLs, and restore of a prior navigation version remains a draft.
8. **Regression:** Both historical articles and the dynamic newly created article path still work; sitemap and Hub still honor withdrawal; authenticated drafts/private article IDs never leak to anonymous requests. Evaluate any analytics SQL as a separate gate.

## Fail-closed response

If any readiness step fails, leave both feature flags OFF. Roll back the *Preview deployment* if needed, without deleting used navigation history. Never apply `ROLLBACK-UNTOUCHED-PROPOSAL.sql` after an owner has edited navigation: preserve records and conduct a separate recovery review.

## Acceptance checklist

- [ ] Staging migration explicitly approved
- [ ] Verified-public catalog and independent publication checks validated
- [ ] Navigation DDL/RPCs reviewed on isolated clone
- [ ] Auth, RLS, grants, idempotency and HTML escaping tested
- [ ] Empty/draft/archived folder projections excluded
- [ ] Owner editing/preview/history works on protected Preview
- [ ] Exact owner menu publication works without article publication
- [ ] Existing Resources URLs and withdrawal tests remain green
- [ ] No Production migration, deployment, or public menu change
