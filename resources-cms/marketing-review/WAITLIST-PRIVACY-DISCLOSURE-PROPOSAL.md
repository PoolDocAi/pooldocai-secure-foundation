# Proposal only: align approved Privacy Policy with optional marketing email consent

**Status:** awaiting separate owner approval. Do not overwrite or redeploy the previously approved legal text without that review.

## Why this is needed

The owner accepted the protected waitlist UI on October 27, 2026: a short point-of-collection notice, a separate default-off marketing email checkbox, and removal of the redundant header link. The live Preview code sends explicit `email_updates_opt_in` yes/no evidence to the existing Formspree endpoint. The approved October 27 Privacy Policy, however, does not currently describe waitlist signup records, marketing newsletters/new-article emails, or how users can opt out of those emails. Its existing service-provider section is generic.

## Narrow proposed text (not applied)

**Section 1 — Information we may process**: append an additional category:

> **Waitlist and communications:** name, email address, selected role, signup date, limited page/session information, and whether you opted in to optional PoolDocAI email updates.

**Section 2 — How information is used**: append:

> We use waitlist details to manage early-access interest and send launch or signup-status messages. Only if you select the separate optional checkbox may we also send product news, newsletters, and new articles. You can unsubscribe from those optional emails or contact hello@pooldocai.com to opt out. Our form and email providers process communications on our behalf.

Keep the approved 10-section policy's remaining text intact. The updated policy should be reviewed for accuracy against the live form provider, sending platform, unsubscribe mechanism and actual operations before approval; this proposal is not legal advice.

## Operational gates

1. Confirm **`mrpppgkw`** is the intended live waitlist Formspree endpoint; a separate historical account-transition handoff cites `xzedoqqq`. Do not reroute without explicit owner authorization.
2. Send two labeled synthetic submissions to the **intended** endpoint with consent `yes` and `no`. Confirm both are stored, notification delivery goes to the expected inbox, and only `yes` may be used for marketing exports. Formspree may apply domain restrictions or spam validation; do not turn those controls off simply for testing.
3. Before any marketing newsletter is actually sent, ensure it has a working unsubscribe path and legally required sender information.
4. Once approved, add the narrow text to the already approved Privacy Policy, then repeat protected Preview link/consent tests.

No change to Production Vercel, DNS, CMS migrations, Formspree configuration or recipient routing is authorized by this proposal.
