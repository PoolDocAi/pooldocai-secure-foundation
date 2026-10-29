# Vercel automatic-preview budget — PoolDocAI

Connected Hobby team: `bersonjoshua-8595` (`team_TJotFCCjbzGoL9LuGYPMM2z2`). Vercel allows **100 created deployments per rolling 24 hours shared across the team**. This does not reset at midnight.

## Selected-branch suppression

Both Vercel project configurations (`vercel.json` for the website and `resources-cms/vercel.json` for the private CMS) contain `git.deploymentEnabled` entries for the observed high-traffic development branches. These suppress **Git-push-triggered** preview deployments, not manually requested deployments from an exact commit SHA. Unlisted branches, including `main`, keep their current default behavior.

**Branch-local requirement:** Vercel evaluates configuration from the relevant branch. A rule committed only to a review PR does not establish suppression on another active branch. For each active branch, commit only the relevant config file(s) to that branch using compare-and-swap; do not merge unrelated application work. The first config-only push might still consume a preview attempt.

## Budget and release procedure

- Internal planning cap: **10 deployments per rolling 24 hours team-wide**, with normally **2 CMS previews**.
- Before an elective preview, count distinct deployment IDs from the **whole team** over the rolling 24-hour, one-hour and five-minute windows. Require **fewer than 80 visible 24-hour deployments** for 20+ slots of headroom; this is a safety heuristic, not Vercel's rate-limiter count.
- Batch edits and run GitHub CI tests before any deployment. Deploy one fully validated exact SHA to the **SSO-protected private CMS Preview** for owner acceptance, retaining the Staging Supabase target.
- If a create-deployment attempt returns HTTP `402 api-deployments-free-per-day`, stop trying. Inspect capacity using read-only APIs and wait for the rolling window.
- Do not modify Production, publishing holds, backup gates, SSO, billing or DNS as part of this policy.

Full audit and continuing deployment log: [GitHub issue #36](https://github.com/PoolDocAi/pooldocai-secure-foundation/issues/36).

Official docs: https://vercel.com/docs/project-configuration/git-configuration and https://vercel.com/docs/limits
