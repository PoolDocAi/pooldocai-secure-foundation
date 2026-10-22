# PoolDocAI Start Here

## For your existing PoolDocAI pilot

Read [`README_FEATURE_EXPANSION_20261021.md`](README_FEATURE_EXPANSION_20261021.md). That guide provides the current exact steps for applying only missing migrations, copying files to your existing GitHub repository through GitHub Desktop, running the workflows, and configuring Supabase, Render, Vercel, invitations, Stripe preparation, usage, offline sync and retrieval.

## CI syntax-check fix

The security workflow runs esbuild with `--bundle` because esbuild requires bundling when `--external` is used. This is a workflow validation fix; it does not change the live database or apply migrations.

## Before uploading

- Copy the **contents** of `PoolDocAI_Release_Bundle/` into your existing GitHub repository root, not the outer folder.
- Preserve `website/js/config.js` from this bundle; it targets the correct project `owfeebydlyacssqpnmkq` and uses your public publishable key.
- Do not recreate your company, Auth users, memberships or platform-owner row.
- Do not rerun SQL migrations which already succeeded against the correct project. Migrations 012–014 are the feature-expansion migrations; apply only any of those that remain unapplied, one complete file per fresh SQL Editor query.
- Keep server/provider secrets out of browser code and repository files.

## Deployment order

1. Confirm the required migrations are applied in the correct Supabase project.
2. Commit/push the bundle contents to `main` using GitHub Desktop.
3. Wait for both GitHub Actions workflows to pass.
4. Confirm the Render document worker is Live and healthy.
5. Confirm Vercel redeploys the latest commit.
6. Follow `SECURITY_TEST_PLAN.md` with two test companies before real customer data is used.

Stripe checkout is prepared but intentionally disabled until you have an actual Stripe account, recurring Price IDs and a webhook secret. Invitation resend needs the optional Resend configuration. HVAC and Plumbing are still planned; Pool is the active module.

Latest conversational troubleshooting fix: see `README_CONVERSATIONAL_TROUBLESHOOTER_FIX.md`. This is a code-only update; it does not require an additional SQL migration.

## Latest update: Universal conversational troubleshooting

See `README_CONVERSATIONAL_TROUBLESHOOTER_FIX.md`. This update applies natural-language intent across equipment and water categories, reduces redundant intake gates, allows more time for source-grounded web fallback, and makes technician escalation large and high-contrast when recommended. It does not require a new SQL migration.

## Latest universal troubleshooting and large-print escalation

The newest conversational troubleshooting release treats ordinary wording and common typing errors as meaningful input across the pool-equipment and water-quality categories. If live sources cannot verify an applicable procedure, it gives a clearly labeled, numbered safe observation and displays a large technician-service card. The service handoff opens only after the user selects the prominent action. Run `node website/tests/troubleshooter-intent.test.cjs` after checkout.


### All-turn language normalization (latest update)

The same typo-tolerant conversational handling runs on initial descriptions and every continuation. It retains the raw user text, gives routing/retrieval a normalized copy, prioritizes the current observation in knowledge-base lookup, and carries the latest observation into backend context. No new database migration is required for this code update.
