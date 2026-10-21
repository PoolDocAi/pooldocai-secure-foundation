# PoolDocAI Start Here

## For your existing PoolDocAI pilot

Read [`README_FEATURE_EXPANSION_20261021.md`](README_FEATURE_EXPANSION_20261021.md). That guide provides the current exact steps for applying only missing migrations, copying files to your existing GitHub repository through GitHub Desktop, running the workflows, and configuring Supabase, Render, Vercel, invitations, Stripe preparation, usage, offline sync and retrieval.

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
