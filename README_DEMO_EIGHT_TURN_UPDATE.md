# PoolDocAI Public Demo — Eight Turns per Mode

This update raises the public demo allowance to eight turns for **Homeowner Triage** and a separate eight turns for the **Field Tech Mobile App** preview. The two modes use distinct session IDs, browser counters, and server-side quota entries. The public desktop header removes the direct Technician Troubleshooter link and uses consistent spacing for navigation tabs. The Try Live Demo link continues to open the page containing both demo modes.

## Apply to an existing deployment

1. In the correct PoolDocAI Supabase project (`owfeebydlyacssqpnmkq`), open SQL Editor and run the complete contents of `supabase/migrations/202610210008_public_demo_eight_turns.sql`. Apply it after migrations 001–007. This updates the server-enforced database cap; it does not delete company or user data.
2. Copy the changed files from this update into the matching folders of the existing local GitHub repository. This bundle deliberately does not include `website/js/config.js`; preserve the public Supabase configuration already set in that file.
3. Commit and push the changes to `main`. GitHub Actions will test the full migration chain and deploy the updated `clever-handler`. Vercel should redeploy the static website from the same commit.
4. Verify the live `/demo` page. Switch modes and confirm each counter starts from and maintains its own eight-turn allowance.

## Files changed

- `website/index.html`, `website/demo.html`, `website/how-it-works.html`, `website/pricing.html`, `website/faq.html`, `website/waitlist.html`: independent mode counters, turn meter, updated limit copy, cleaner navigation.
- `website/app.html`: updated public-demo copy and navigation header.
- `website/admin.html`: updated demo allowance information.
- `supabase/functions/clever-handler/index.ts`: server-side calls request the eight-turn allowance.
- `supabase/migrations/202610210008_public_demo_eight_turns.sql`: DB-level cap updated from three to eight.
- `supabase/tests/security_review.sql`: regression test verifies each mode receives eight turns and blocks the ninth.

This public demo still does not expose authenticated-only equipment photo recognition or company-private records. The client counter is a user-experience aid; the server-side database quota is the enforcement mechanism.
