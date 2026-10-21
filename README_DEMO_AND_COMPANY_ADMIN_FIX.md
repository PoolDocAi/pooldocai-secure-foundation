# PoolDocAI Demo Quota + Company Admin Release Fix

## What the CI failure was

The public demo RPC returns an output column named `turns_used`. The former SQL increment used an unqualified `turns_used` on the right-hand side of an UPDATE, which can conflict with the PL/pgSQL output variable. This release qualifies the table column as `demo_session.turns_used` and adds a regression assertion plus a forward migration. The database, not just browser storage, caps each mode-specific public demo session at eight turns. Homeowner Triage and Field Tech Mobile App use different opaque session IDs.

## Company documents

Company administrators and seats delegated `can_upload_documents` can upload supported PDFs, Word documents, text formats and images to the private `company-manuals` bucket, or register a public webpage. The worker extracts text, OCRs supported scanned/image sources, chunks and tags it, and indexes chunks to the database for private company retrieval. Each manual is reference-enabled independently of its shared-learning consent. If consent is off, content remains company-private. If consent is on, proposed lessons remain pending for PoolDocAI platform-owner approval; this is retrieval/knowledge distillation, not automatic model training.

## Platform-owner administration

The platform-owner portal lists companies, subscription metadata, active seat counts, recent page views and usage events. Platform owners can create companies, change plan/status/seat limits, cancel/restore companies (soft removal retains history), and view Auth/membership/permission status for accounts. Platform-owner changes require a row in `public.platform_admins`; never grant this role from browser code.

## Company-admin seat management

Company admins can invite or assign seats within the subscription limit, suspend/reactivate seats, and manage other members' job-note view/edit, document upload and extracted-document review permissions. Subscription limits and company status remain platform-owner-only. Suspending a seat preserves its job and audit history. The database enforces seat limits; the frontend is not the only control.

## Existing installation update order

For the existing PoolDocAI Supabase project, open a new SQL Editor query for each migration and run the complete files separately in numerical order: `202610210008_public_demo_eight_turns.sql`, `202610210009_company_member_permissions_management.sql`, `202610210010_company_admin_safety_fixups.sql`, then `202610210011_demo_quota_and_company_creation_fix.sql`. Run migration 011 even if migration 008 was already run because the prior function body must be replaced in the live database. Use the correct project `owfeebydlyacssqpnmkq`. Do not recreate accounts or re-run the provisioning INSERTs.

Then merge the contents of this bundle into the existing repository root, preserve the existing live `website/js/config.js`, commit and push to `main`, and review both GitHub Actions workflows. These code changes do not run SQL migrations on the live project automatically.

## Validation limits

Static JavaScript/TypeScript/config checks and ZIP integrity checks are performed when assembling the release. Live PostgreSQL execution, real two-company RLS tests, Render OCR, Gemini calls and Vercel production behavior must be verified in staging before real customer data is used.
