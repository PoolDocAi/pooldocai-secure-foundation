# Hosted permissions acceptance: exact setup handoff

October 28, 2026. Staging only: `rzkgmvyyeclrpomrlyft`. Coverage remains blocked; no hosted role or cross-tenant pass is claimed.

## Fresh evidence and practical blocker

A read-only query returned exactly one active CMS membership (`owner`) and no editor/reviewer/viewer memberships. Auth users whose email ends in `@example.test` or `.invalid`: zero. This narrow email check does not classify every Auth account or prove that no other test users exist. No email addresses, Auth secrets, tokens, or owner credentials were retrieved.

The available Supabase connector exposes SQL/project tools but no Auth-admin create-user or session-provisioning capability. No CMS/SUPABASE/VERCEL environment variable names were available. A fresh browser inventory request timed out; this does **not** establish that browsers or sessions do not exist. It supplied no usable independent session for this task. Earlier reports of an empty browser inventory remain historical evidence.

## Minimal owner/operator setup

1. Open [Staging Authentication Users](https://supabase.com/dashboard/project/rzkgmvyyeclrpomrlyft/auth/users). Using **Add user / Create new user**, provision five disposable, non-anonymous email/password identities: editor, reviewer, viewer, authenticated nonmember, and tenant-B user. Use synthetic names and passwords held in the owner's password manager. Confirm their email state through the normal supported Auth workflow. Do not use an invite to an invented mailbox or send credentials in chat. If existing approved test users already exist, provide their UUIDs and intended roles instead of creating duplicates.
2. Supply the five Auth UUIDs and approve their exact Staging assignment roster. CMS access comes from `resources_cms.members(user_id, role, active)`; it is separate from `public.company_members`. The first three require active CMS roles `editor`, `reviewer`, and `viewer`. Both nonmember and tenant-B users must have **no CMS membership**. The inspected CMS code has no general member-administration endpoint, and the Production owner-bootstrap script is unsuitable. An authorized Staging operator must apply a narrowly reviewed, UUID-bound membership assignment through [Staging SQL Editor](https://supabase.com/dashboard/project/rzkgmvyyeclrpomrlyft/sql/new) after checking existing rows and Auth UUID existence. No executable grant SQL is supplied while UUIDs and the assignment approval are missing; never insert into `auth.users` or construct JWTs via SQL.
3. Provide synthetic tenant A/B company IDs, approved active `public.company_members` assignments and disposable tenant-owned record IDs/private object paths through the application's existing company administration workflow. This schema uses `company_id`, `user_id`, `role`, `status` and explicit document/job permission flags. A CMS role alone establishes no tenant fixture. Do not reuse real customer records or guess allowed company-role values. If that administration workflow cannot create a disposable second tenant, identify the operator and approve a separately reviewed fixture transaction before execution.
4. Make five separate browser profiles/contexts available to the agent, each permitted through the existing Vercel Authentication perimeter for the exact protected Staging Preview. Sign each into the CMS using its own test identity. Also provide one perimeter-authenticated context with **no CMS session**. Do not reduce protection or use the owner's CMS session. Share only Preview URL, context labels, UUID/role roster and disposable fixture IDs; no cookies, access tokens or passwords.

These four steps can be performed by one trusted operator. The immediate owner handoff is the five-UUID roster plus access to the isolated contexts and synthetic tenant fixtures. Merely creating Auth users does not close membership, tenant or browser-session prerequisites.

## Tests unlocked by that setup

The pinned source at `5717210` verifies non-anonymous identities through Supabase `/auth/v1/user`, signs in with the password grant, and checks active CMS membership independently. Compatibility routes enforce exact Origin and matching CSRF cookie/header **before** their member/command checks. A 403 caused by Origin or CSRF is not role-denial evidence. Reconcile paths against the exact deployed revision because another task is changing CMS workflows.

| Context | Positive evidence required | Denial evidence required |
| --- | --- | --- |
| Editor | `/api/me` reports editor; private dashboard/content/history/preview/media reads; save and submit disposable draft | Publish, owner rights/release, knowledge approval; tenant-B access |
| Reviewer | `/api/me` reports reviewer; private reads; review/knowledge command on eligible synthetic revision when prerequisites permit | Editorial save and publication; tenant-B access |
| Viewer | `/api/me` reports viewer; private reads | All editorial, media, knowledge, rights and publication mutations |
| Authenticated nonmember | Genuine Auth sign-in succeeds | CMS me/dashboard/article/history/preview/media reads and writes |
| Tenant-B user | Genuine Auth sign-in and explicitly permitted own-tenant row/object operations | Tenant-A row/object read/write and CMS access without CMS membership |
| Perimeter-only context | Vercel perimeter accepts context | CMS private endpoints deny without CMS session |

Use only disposable records. Positive publication, rights approval, held-draft mutation, scheduling, PDF activation and Production requests are excluded. If a positive review needs an owner-controlled prerequisite, record it as blocked rather than clearing rights or publishing to manufacture coverage.

For each request record method, origin/path, expected/actual status, response classification and disposable fixture ID. Verify denied writes change no fixture row/version, release or rights state and create no successful-mutation audit event; legitimate denial audit events may be recorded. Test direct Supabase row/Storage access using each user's actual session; privileged connector SQL cannot demonstrate RLS isolation. Sanitize all evidence: omit query strings, bodies, credentials, cookie/authorization/CSRF values and signed URLs. No raw HAR export. Revoke test sessions and remove only approved disposable fixture state through normal workflows when finished.

No hosted provisioning, membership changes, tenant changes, acceptance HTTP tests, owner-session use or Vercel-protection change occurred in this work.
