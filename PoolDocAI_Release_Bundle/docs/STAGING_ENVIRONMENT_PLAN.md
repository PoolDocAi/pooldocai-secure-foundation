# PoolDocAI Isolated Staging Environment Plan & Execution Guide

> [!IMPORTANT]
> **Strict Isolation & Production Guardrails**:
> - **Staging Project**: `PoolDocAI Staging` (`rzkgmvyyeclrpomrlyft`, `us-east-2`, Postgres 17.11)
> - **Production Project**: `PoolDocAI Complete` (`owfeebydlyacssqpnmkq`, `us-east-2`) — **STRICTLY UNTOUCHED**
> - **Zero Live Production Writes**: No production migrations, seed scripts, or schema adjustments.
> - **Zero Production Deployments**: `--prod` unused; PR #14 remains open and unmerged.
> - **Zero Real Outbound Dispatches**: Document worker operates with fail-closed unconfigured email/push adapters.

---

## 1. Staging Architecture & Overview

The owner has authorized the setup of a dedicated, completely isolated staging project under the existing PoolDocAI Supabase organization:

| Property | Staging Environment | Production Environment (Untouched) |
| :--- | :--- | :--- |
| **Project Name** | `PoolDocAI Staging` | `PoolDocAI Complete` |
| **Project Ref** | `rzkgmvyyeclrpomrlyft` | `owfeebydlyacssqpnmkq` |
| **Region** | `us-east-2` | `us-east-2` |
| **Monthly Cost** | $0.00/month (Free Tier Org) | Existing tier |
| **Dashboard URL** | [Supabase Staging Dashboard](https://supabase.com/dashboard/project/rzkgmvyyeclrpomrlyft) | [Supabase Production Dashboard](https://supabase.com/dashboard/project/owfeebydlyacssqpnmkq) |
| **Vercel Target** | Preview Deployments (`STAGING_SUPABASE_URL`) | Production (`pooldocai-secure-foundation.vercel.app`) |

---

## 2. Staging Execution Artifacts

Three SQL artifacts have been prepared in `supabase/staging/`:

1. **`supabase/staging/00_apply_staging_migrations.sql`**:
   - Contains all 45 migrations (001 through 045) consolidated in exact chronological order.
   - Standard PostgreSQL syntax: zero psql meta-commands (`\set`), allowing direct execution in the Supabase Dashboard Web SQL Editor.
   - Idempotently creates schemas, tables, functions, triggers, and RLS policies.
2. **`supabase/staging/01_synthetic_staging_fixtures.sql`**:
   - Seeds two independent synthetic organizations to verify multi-tenant isolation:
     - **Company A (Commercial)**: `AquaPure Commercial Pool Care` (`11111111-1111-4111-8111-111111111111`)
       - Admin: `staging_admin_aquapure@pooldocai.test`
       - Tech: `staging_tech_aquapure@pooldocai.test`
     - **Company B (Residential)**: `BlueWave Residential Pool Services` (`22222222-2222-4222-8222-222222222222`)
       - Admin: `staging_admin_bluewave@pooldocai.test`
       - Tech: `staging_tech_bluewave@pooldocai.test`
   - Authentic GoTrue Password Authentication: Uses PostgreSQL `pgcrypto` `crypt('PoolDocStaging2026!', gen_salt('bf', 10))` and inserts corresponding records into `auth.identities` so synthetic users can authenticate via the standard Supabase UI and SDK.
   - Sanitized Outbound Push Subscriptions: Uses RFC-reserved `.test` endpoints (`https://push.staging.pooldocai.test/...`) to prevent accidental outbound requests to external push gateways.
   - Zero real customer/business PII.
3. **`supabase/staging/02_staging_verification_tests.sql`**:
   - Automated post-migration verification script.
   - Asserts:
     - All 13 core tables exist (including `company_manual_chunks` and `pooldocai_grounded_answer_cache`);
     - 100% of public tables have Row-Level Security (`relrowsecurity = true`);
     - Required security RPCs exist (`pooldocai_register_push_subscription`, `pooldocai_claim_push_delivery_batch`, `pooldocai_claim_email_delivery_batch`, `pooldocai_check_manual_duplicate`, `search_company_manual_chunks_hybrid`);
     - Strict bi-directional tenant isolation (AquaPure tech cannot view BlueWave service requests or push subscriptions).

---

## 3. Migration Application Procedure

To apply the schema migrations and synthetic fixtures to project `rzkgmvyyeclrpomrlyft`:

### Method A: Supabase Dashboard SQL Editor (Recommended)
1. Open the [Supabase Staging Dashboard](https://supabase.com/dashboard/project/rzkgmvyyeclrpomrlyft/sql).
2. Create a new query: copy and paste the contents of [`supabase/staging/00_apply_staging_migrations.sql`](file:///C:/Users/berso/Desktop/pooldocai-secure-foundation/supabase/staging/00_apply_staging_migrations.sql).
3. Click **Run**. Verify that all statements execute successfully.
4. Create a second query: copy and paste [`supabase/staging/01_synthetic_staging_fixtures.sql`](file:///C:/Users/berso/Desktop/pooldocai-secure-foundation/supabase/staging/01_synthetic_staging_fixtures.sql). Click **Run**.
5. Create a third query: copy and paste [`supabase/staging/02_staging_verification_tests.sql`](file:///C:/Users/berso/Desktop/pooldocai-secure-foundation/supabase/staging/02_staging_verification_tests.sql). Click **Run**.
   - Confirm output logs: `PASS: Bi-directional multi-tenant tenant isolation verified.` and `=== ALL STAGING CHECKS PASSED SUCCESSFULLY ===`.

### Method B: PostgreSQL Client via Connection Pooler
```bash
psql "postgres://postgres.rzkgmvyyeclrpomrlyft:[YOUR-DB-PASSWORD]@aws-0-us-east-2.pooler.supabase.com:6543/postgres" \
  --set ON_ERROR_STOP=1 \
  --file supabase/staging/00_apply_staging_migrations.sql

psql "postgres://postgres.rzkgmvyyeclrpomrlyft:[YOUR-DB-PASSWORD]@aws-0-us-east-2.pooler.supabase.com:6543/postgres" \
  --set ON_ERROR_STOP=1 \
  --file supabase/staging/01_synthetic_staging_fixtures.sql

psql "postgres://postgres.rzkgmvyyeclrpomrlyft:[YOUR-DB-PASSWORD]@aws-0-us-east-2.pooler.supabase.com:6543/postgres" \
  --set ON_ERROR_STOP=1 \
  --file supabase/staging/02_staging_verification_tests.sql
```

---

## 4. Vercel Preview Configuration (Secure Provider UI)

To link Vercel Preview deployments to staging without touching production:

1. Navigate to **Vercel Dashboard** -> **pooldocai-secure-foundation** -> **Settings** -> **Environment Variables**.
2. Add the following environment variables scoped **ONLY to the Preview environment**:
   - `STAGING_SUPABASE_URL`: `https://rzkgmvyyeclrpomrlyft.supabase.co`
   - `STAGING_SUPABASE_ANON_KEY`: `<staging_publishable_anon_key>` (retrieve from [Staging API Settings](https://supabase.com/dashboard/project/rzkgmvyyeclrpomrlyft/settings/api))
   - Ensure the **Production** environment checkbox is **UNCHECKED**.
3. **Fail-Closed Protection**:
   - [`scripts/generate-config.cjs`](file:///C:/Users/berso/Desktop/pooldocai-secure-foundation/scripts/generate-config.cjs) automatically verifies that `STAGING_SUPABASE_URL` does NOT contain `owfeebydlyacssqpnmkq`.
   - If a preview build ever attempts to use production credentials, the build will immediately abort with:
     `[generate-config] FATAL SECURITY VIOLATION: Preview may not connect to production Supabase project owfeebydlyacssqpnmkq.`

---

## 5. Staging Document Worker Configuration

The background document worker (`document-worker/src/server.js`) can be run against staging for end-to-end queue and notification validation:

```env
SUPABASE_URL=https://rzkgmvyyeclrpomrlyft.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<staging_service_role_key>
# Omit RESEND_API_KEY and VAPID keys to enforce fail-closed unconfigured adapters:
# EMAIL_PROVIDER will default to UnconfiguredEmailAdapter
# PUSH_PROVIDER will default to UnconfiguredPushAdapter
```

Under this configuration:
- Queue rows in `public.notification_delivery_queue` remain intact.
- The worker claims batches with unguessable lease tokens (`claim_<uuid>`) and verifies lease fencing.
- Zero external emails or Web Push messages are sent to real networks.

---

## 6. End-to-End Acceptance Verification Checklist

Once staging migrations are applied and Vercel preview variables are configured:
- [ ] **Staging Auth**: Sign up / log in with synthetic admin (`staging_admin_aquapure@pooldocai.test`).
- [ ] **Multi-Tenant Isolation**: Confirm AquaPure admin/tech cannot view BlueWave service requests or members.
- [ ] **Technician PWA Offline Cold-Start**:
  - Visit `/technician` on preview domain using Android Chrome;
  - Install PWA to home screen;
  - Enter Airplane Mode;
  - Kill app from app switcher;
  - Cold-launch PWA from home screen: confirm app shell loads immediately without dinosaur error.
- [ ] **Web Push Opt-in**:
  - Click "Enable Device Alerts" on technician portal;
  - Verify subscription is registered in `public.user_push_subscriptions` for staging tenant.
- [ ] **Decoupled Inbox**:
  - Verify in-app inbox functions independently of push notification permission state.
