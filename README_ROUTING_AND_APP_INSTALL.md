# PoolDocAI routing, authentication, and install update

This release repairs the authenticated troubleshooter gate and routes, centralizes the public Supabase URL/key config, separates the eight-turn public demo from the full authenticated workspace, and makes the secure troubleshooter installable as a PWA from the account portal.

## Required one-time public-key setup

1. Open `website/js/config.js`.
2. Replace `REPLACE_WITH_SUPABASE_PUBLIC_KEY` with the **public publishable/anon key from project `owfeebydlyacssqpnmkq`**.
3. Do not use `sb_secret_...`, the legacy service-role key, or a Supabase personal access token here.
4. Commit the change to `main`. All website pages now read the same URL/key from this file.

## Routes

- `/` — public marketing homepage.
- `/demo` — public demo; eight turns per mode and browser session and photo identification disabled. The Edge Function additionally enforces the public turn budget server-side.
- `/admin` — account portal and app-install button (install the authenticated troubleshooter).
- `/app` — sign-in gated full troubleshooter with authenticated photo identification and no public-demo turn counter; backend usage/safety limits still apply. The secure workspace is revealed only after the logged-in user has an active membership in a pilot/active company.
- `/technician` — separate technician field-notes PWA.
- `/learning-review` — platform-owner review interface.

## PWA install

The account portal includes an Install PoolDocAI App action. On supported Chromium browsers it uses the browser install prompt. On iPhone/iPad, use Safari Share → Add to Home Screen. The installed app launches at `/app`, and sign-in remains required.

## Technician service worker

The technician service worker is now scoped to `/technician` and only handles its own allowlisted paths. It must not hijack `/app`, `/admin`, or public-site navigations. The PoolDocAI troubleshooter uses a separate app-shell worker.

## Validation

The Edge Function deployment workflow remains unchanged. The included GitHub security workflow runs the SQL test file using `psql` after a clean local Supabase migration reset, and the document worker uses Node 22 to match the deployed Render runtime.

Static HTML still cannot server-side protect the HTML source itself. Sensitive company records must remain protected by Edge Function authorization and Supabase RLS, and all account roles must be tested against the live backend before real customer information is used.

## Recovery from prior broken technician navigation

The current install helper detects and unregisters the legacy root-scoped `technician-sw.js` registration if one remains from an earlier deployment, then registers the app-shell worker at `/`. The technician field-notes worker itself is now scoped to `/technician` and cannot rewrite `/app` or `/admin` navigations. After updating, users should reload the website once while online so service-worker updates can activate.

## Updating an already deployed GitHub repository

Before copying these files over an existing repository, copy the current **public publishable/anon key only** from the deployed `website/admin.html` (the value used as `SUPABASE_ANON_KEY`). Paste that value into `website/js/config.js` as `publicAnonKey`. Do not copy an `sb_secret_...` key or a personal access token into the website. The public key must belong to `owfeebydlyacssqpnmkq`.

After deploying, first visit `/admin` while online and reload once. This new version retires the old root-scoped technician service worker that could have intercepted navigation and replaced other routes. Then verify `/app` shows the sign-in gate, `/technician` shows technician field notes, and `/demo` remains labelled as the limited public demo.


Public demo update: Homeowner Triage and Field Tech Mobile App each receive eight turns in separate mode-specific browser sessions. Apply `supabase/migrations/202610210008_public_demo_eight_turns.sql` after migrations 001–007 in Supabase; the security test file verifies the two independent limits.
