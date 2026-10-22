# PoolDocAI troubleshooting and analytics update — 2026-10-21

## Troubleshooter behavior
- An unknown pump manufacturer/model no longer blocks general, non-invasive troubleshooting when the reported issue is specific enough.
- Pump no-start issues receive a dedicated live Google Search fallback query when internal retrieval does not return a relevant procedure. Search citations are still required before a response can be described as source-verified.
- If neither internal procedures nor live search returns a verifiable applicable procedure, PoolDocAI clearly labels the guidance as general/safety-first rather than pretending it is manufacturer-specific. It offers one conservative first check and asks whether the pump is silent, humming/buzzing, or tripping a breaker.
- The safe first check is limited to observing the timer/automation run command and visible status from a dry location. It explicitly prohibits opening electrical panels, touching wiring, removing the motor cover, or repeatedly resetting a tripping breaker.
- Technician escalation labels now say **Request a Pool Service Technician** to make the next action more obvious.

## Platform owner site and API analytics
- Public HTML pages send a privacy-minimized page-view event: path, referrer hostname, and a hashed session identifier. Raw query strings, IP addresses, user-agent strings, and diagnostic prompts are not included in page-view analytics.
- Public demo AI/API attempts are separately logged as `public_api_request` events without storing the prompt. Authenticated AI request events and provider-reported token events continue to be logged separately.
- Platform analytics shows last-30-day page views, distinct browser sessions observed in the loaded event window, AI/API requests logged, input/output tokens, and estimated priced API cost, plus the detailed recent event table.
- Cost is an estimate based on configured rate cards when token counts and matching rates exist. It is not a replacement for the Gemini/provider billing console.
- No new database migration is required for this update; it reuses `platform_page_views` and `platform_usage_events` introduced by earlier migrations.

## Validation performed
- Inline JavaScript syntax checks passed for all inline scripts in the website HTML files.
- TypeScript syntax transpilation passed for `supabase/functions/clever-handler/index.ts`.
- Archive integrity should be verified after packaging.
- Live Google Search behavior, Supabase writes, live admin analytics, and the end-to-end pump case have **not** been tested against the deployed services in this environment. After deploying, test a pump no-start case with unknown make/model and confirm the answer's source panel only lists genuine returned sources.

## Deployment notes
1. Use this release ZIP as the single package; it includes the previous temporary trial credential update and migration 015.
2. Do not rerun migrations 001–014. Apply migration 015 only if the Supabase migration history shows it has not been applied. This update adds no migration.
3. Push the release to the existing `main` branch and allow GitHub Actions/Vercel/Render to finish.
4. Deploy the updated `clever-handler` Edge Function.
5. Sign in as the registered platform owner, open **Platform analytics**, and verify page views/API requests/tokens populate after using the public demo and authenticated troubleshooter.
6. Run the QA cases in `QA_CHECKLIST.md`; do not treat syntax checks as a substitute for live integration tests.


## Uniform fallback-search rule (updated)

For diagnostic requests with an equipment category, the Edge Function now attempts a second Google Search-grounded response whenever the initial pass fails to produce a complete, applicable step backed by an internal procedure or actual web citations. The fallback no longer requires triage to be complete, the operating state to be confirmed, or the symptom to pass the vague-symptom filter. Dedicated model-identification and explicit escalation actions remain separate. If search cannot return usable, relevant sources, the assistant must not pretend it searched successfully or invent a source-backed repair; it should explain uncertainty, ask a focused clarifying question where appropriate, and/or offer a service technician. This requires a configured Gemini API key and successful provider search support; end-to-end behavior still needs verification after deployment.
