# PoolDocAI existing-install update — current feature expansion

For the latest complete instructions for the existing pilot, use [`README_FEATURE_EXPANSION_20261021.md`](README_FEATURE_EXPANSION_20261021.md). That guide supersedes the earlier partial 008–011 update instructions and covers migrations 012–014, invitations, Stripe-ready billing, usage metering, offline sync, hybrid retrieval, industry modules, and exact deployment configuration.

The existing correct Supabase project reference is `owfeebydlyacssqpnmkq`. Do not recreate users, companies, memberships, or platform-owner rows. Do not rerun any migration that has already successfully been applied to that project.

The site’s browser configuration is in `website/js/config.js` and uses the public publishable key for the correct project. Keep this public key paired with the same Supabase project. Never put `sb_secret_...`, service-role, Gemini, Render worker, Stripe secret, or `sbp_...` personal access tokens in browser code or public source.


## Temporary trial credentials update
Apply migration `202610210015_temporary_platform_trial_credentials.sql` after migrations 001–014. See `README_TEMPORARY_TRIAL_CREDENTIALS.md`.
