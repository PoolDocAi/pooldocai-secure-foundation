# Routing, secure troubleshooter, and app install release QA

## Included changes

- Public navigation uses `/demo` for the public demo and `/app` for the authenticated full troubleshooter.
- `/app` renders a sign-in gate first and only reveals the full troubleshooting UI after a valid Supabase session and active company membership in a `pilot` or `active` company are confirmed.
- The authenticated troubleshooting UI preserves the existing diagnostic workflow, water chemistry assistance, and photo identification control (`poolEquipmentPhotoInput`). Photo identification sends an authenticated request and remains unavailable in the public demo.
- `/demo` is labelled `PUBLIC DEMO · 3 TURNS`. It keeps the client-side three-turn indicator and the Edge Function enforces the three-turn backend limit. Photo identification is blocked there.
- `/technician` is the separate technician field-notes/job-record workspace.
- The technician service worker is scoped to `/technician` and only caches its own allowlisted paths. The app installer helper unregisters a known legacy root-scoped `technician-sw.js` worker and registers `app-sw.js` at `/`.
- The account portal provides an install action from the Account Overview and Troubleshooter tab. The manifest launches at `/app`.
- Website Supabase project URL and public key are centralized in `website/js/config.js`.

## Required step when updating an existing deployment

Before committing this bundle over the current repository, put the **existing public publishable/anon key for project `owfeebydlyacssqpnmkq`** into `website/js/config.js` as `publicAnonKey`. Do not use a `sb_secret_...` key, service-role JWT, or `sbp_...` Supabase personal access token in browser code.

## Static checks performed on this package

- 31 inline JavaScript blocks passed `node --check`.
- `document-worker/src/server.js`, `website/js/core.js`, `website/js/config.js`, `website/js/pwa-install.js`, `website/app-sw.js`, and `website/technician-sw.js` passed Node syntax checks.
- Authenticated app login gate, visibility CSS, photo-recognition handler, demo turn limit, install button, and expected local route targets were checked in source.
- No old Supabase project URL remains in source files.

## Not yet verified

This is a code-bundle/static QA report, not a live-browser or production security certification. After deployment, test `/admin`, `/app`, `/technician`, `/learning-review`, and `/demo`; test login with separate company-admin and technician accounts; confirm photo upload produces a response; test the fourth public-demo turn is rejected; and verify cross-company access is denied. API secrets must stay server-side.
