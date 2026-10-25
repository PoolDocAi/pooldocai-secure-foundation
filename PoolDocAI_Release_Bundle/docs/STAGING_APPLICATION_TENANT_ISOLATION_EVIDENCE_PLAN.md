# PoolDocAI Staging Application Tenant Isolation Evidence Plan

**Document Version:** 1.0.0  
**Date:** 2026-10-25  
**Component:** Staging Verification, Release Gates, Tenant Isolation  
**Target Project:** `rzkgmvyyeclrpomrlyft` (PoolDocAI Staging)  
**Strict Safety Guardrail:** READ-ONLY ARTIFACT. ZERO LIVE MUTATIONS AUTHORIZED IN THIS STEP.

---

## 1. Overview & Objectives

This document establishes the evidence collection and verification plan for executing positive application-level tenant isolation tests on the live PoolDocAI Supabase staging environment (`rzkgmvyyeclrpomrlyft`).

In accordance with TASK-008 and TASK-009 requirements:
- Direct PostgREST table denials (`REVOKE ALL` returning HTTP 401/403) confirm schema-level defenses but do **not** verify positive application tenant isolation.
- To eliminate the release-gate blind spot, positive application-level controls (`4A-APP`, `4B-APP`, `4D-APP`, `4E-APP`) must be verified on live staging with genuine GoTrue session tokens and real application endpoints.
- **Strict Release Gate Policy:** Controls `4A-APP`, `4B-APP`, `4D-APP`, and `4E-APP` remain marked as `[LIVE NOT RUN]` until all owner approvals are granted and live staging execution is formally conducted and verified. No artificial flipping of `NOT RUN` to `PASS` is permitted.

---

## 2. Environment Preconditions

Before live staging verification can be executed, the following preconditions must be satisfied:

1. **Supabase Project Isolation:**
   - **Staging Project:** `rzkgmvyyeclrpomrlyft` (`us-east-2`, Postgres 17.11).
   - **Production Project:** `owfeebydlyacssqpnmkq` — **STRICTLY UNTOUCHED**. Zero reads, zero writes, zero deployments.
2. **Schema & Migration Alignment:**
   - All migrations up through migration `20261024110000` applied to staging.
   - Core tables `companies`, `company_members`, `technician_job_records`, `diagnostic_cases`, `diagnostic_case_steps`, `learning_review_queue`, and `pooldocai_legal_acceptances` exist with RLS enabled.
3. **Worker & Outbound Boundary Isolation:**
   - Staging Document Worker isolated from production queues and buckets.
   - Outbound notifications (email/push/SMS) configured to fail-closed or RFC-reserved `.test` endpoints (`push.staging.pooldocai.test`).
4. **Vercel / Edge Preview Deployment:**
   - Edge Function `clever-handler` deployed to staging with `STAGING_SUPABASE_URL` and staging service-role key.

---

## 3. Synthetic Test Identities

Four synthetic test accounts across two distinct organizations represent the multi-tenant isolation boundaries:

| Organization | Role | Synthetic Email | Deterministic UUID | Expected Scope |
| :--- | :--- | :--- | :--- | :--- |
| **AquaPure Commercial Pool Care** (`TENANT_A`) | Company Admin | `staging_admin_aquapure@pooldocai.test` | `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa` | Company A administrative management |
| **AquaPure Commercial Pool Care** (`TENANT_A`) | Technician | `staging_tech_aquapure@pooldocai.test` | `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb` | Company A job notes & diagnostic cases |
| **BlueWave Residential Pool Services** (`TENANT_B`) | Company Admin | `staging_admin_bluewave@pooldocai.test` | `cccccccc-cccc-4ccc-8ccc-cccccccccccc` | Company B administrative management |
| **BlueWave Residential Pool Services** (`TENANT_B`) | Technician | `staging_tech_bluewave@pooldocai.test` | `dddddddd-dddd-4ddd-8ddd-dddddddddddd` | Company B job notes & diagnostic cases |

---

## 4. Synthetic Fixture Management & Deterministic Teardown

To enable positive retrieval and negative cross-tenant testing without polluting persistent staging data:

### 4.1 Seed Fixtures (`supabase/staging/03_synthetic_diagnostic_and_job_fixtures.sql`)
Applies deterministic, synthetic test fixtures via Dashboard SQL Editor or administrative migration:
1. **Tenant A Diagnostic Case:**
   - ID: `11111111-4000-4111-8111-111111111111`
   - Tenant ID: `11111111-1111-4111-8111-111111111111`
   - Equipment: Pentair SuperFlo VST (`pump`)
2. **Tenant B Diagnostic Case:**
   - ID: `22222222-4000-4222-8222-222222222222`
   - Tenant ID: `22222222-2222-4222-8222-222222222222`
   - Equipment: Hayward AquaRite (`sanitizer`)
3. **Tenant A Technician Job Record:**
   - ID: `11111111-5000-4111-8111-111111111111`
   - Tenant ID: `11111111-1111-4111-8111-111111111111`
   - Technician ID: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`
4. **Tenant B Technician Job Record:**
   - ID: `22222222-5000-4222-8222-222222222222`
   - Tenant ID: `22222222-2222-4222-8222-222222222222`
   - Technician ID: `dddddddd-dddd-4ddd-8ddd-dddddddddddd`

### 4.2 Teardown Fixtures (`supabase/staging/04_teardown_diagnostic_and_job_fixtures.sql`)
Deterministic teardown executed immediately upon test suite completion:
```sql
DELETE FROM public.technician_job_records
WHERE id IN ('11111111-5000-4111-8111-111111111111', '22222222-5000-4222-8222-222222222222');

DELETE FROM public.diagnostic_cases
WHERE id IN ('11111111-4000-4111-8111-111111111111', '22222222-4000-4222-8222-222222222222');
```

---

## 5. Live Authentication & JWT Generation

Live staging verification requires genuine Supabase Auth tokens:
1. Four unique secure passwords generated and stored in a secure local encrypted file outside git (`$env:LOCALAPPDATA\PoolDocAI\staging_auth_vault.json`).
2. Authentication executed via standard GoTrue API (`POST /auth/v1/token?grant_type=password`) with the staging anon key.
3. Access tokens (`access_token`) extracted for each of the four synthetic users.
4. Tokens verified to contain matching `sub` (user UUID) and `aud: "authenticated"`.

---

## 6. Per-Tenant Control Checklist (Part-2 Execution Target)

| Control ID | Target Table / Path | User Session | Action / Endpoint | Expected Live Response |
| :--- | :--- | :--- | :--- | :--- |
| **4A-SCHEMA** | `diagnostic_cases` | Tech A (`AquaPure`) | `GET /rest/v1/diagnostic_cases` | HTTP 401/403 (Deny-by-design) |
| **4A-APP** | `diagnostic_cases` | Tech A (`AquaPure`) | `POST /clever-handler` (`save_technician_job` or `withdraw_case_learning_consent`) | HTTP 200 OK; scoped to Tenant A |
| **4A-CROSS-NEG** | `diagnostic_cases` | Tech B (`BlueWave`) | `POST /clever-handler` (`withdraw_case_learning_consent` targeting Case A) | HTTP 403 `TENANT_MISMATCH` |
| **4A-UUID-NEG** | `diagnostic_cases` | Tech B (`BlueWave`) | `POST /clever-handler` (`save_technician_job` with `relatedCaseId = Case A`) | HTTP 403 `TENANT_MISMATCH` |
| **4B-SCHEMA** | `diagnostic_cases` | Tech B (`BlueWave`) | `GET /rest/v1/diagnostic_cases` | HTTP 401/403 (Deny-by-design) |
| **4B-APP** | `diagnostic_cases` | Tech B (`BlueWave`) | `POST /clever-handler` (`save_technician_job` or `withdraw_case_learning_consent`) | HTTP 200 OK; scoped to Tenant B |
| **4B-CROSS-NEG** | `diagnostic_cases` | Tech A (`AquaPure`) | `POST /clever-handler` (`withdraw_case_learning_consent` targeting Case B) | HTTP 403 `TENANT_MISMATCH` |
| **4B-UUID-NEG** | `diagnostic_cases` | Tech A (`AquaPure`) | `POST /clever-handler` (`save_technician_job` with `relatedCaseId = Case B`) | HTTP 403 `TENANT_MISMATCH` |
| **4D-SCHEMA** | `technician_job_records` | Tech A (`AquaPure`) | `POST /rest/v1/technician_job_records` (direct insert) | HTTP 401/403 (Direct insert denied) |
| **4D-APP-SAVE** | `technician_job_records` | Tech A (`AquaPure`) | `POST /clever-handler` (`save_technician_job`) | HTTP 200 OK; stored with `tenant_id: A` |
| **4D-APP-READ** | `technician_job_records` | Tech A (`AquaPure`) | `GET /rest/v1/technician_job_records?tenant_id=eq.TENANT_A` | HTTP 200 OK; returns Tenant A rows |
| **4D-CROSS-READ** | `technician_job_records` | Tech B (`BlueWave`) | `GET /rest/v1/technician_job_records?tenant_id=eq.TENANT_A` | HTTP 200 OK with empty `[]` / 0 rows |
| **4E-SCHEMA** | `technician_job_records` | Tech B (`BlueWave`) | `POST /rest/v1/technician_job_records` (direct insert) | HTTP 401/403 (Direct insert denied) |
| **4E-APP-SAVE** | `technician_job_records` | Tech B (`BlueWave`) | `POST /clever-handler` (`save_technician_job`) | HTTP 200 OK; stored with `tenant_id: B` |
| **4E-APP-READ** | `technician_job_records` | Tech B (`BlueWave`) | `GET /rest/v1/technician_job_records?tenant_id=eq.TENANT_B` | HTTP 200 OK; returns Tenant B rows |
| **4E-CROSS-READ** | `technician_job_records` | Tech A (`AquaPure`) | `GET /rest/v1/technician_job_records?tenant_id=eq.TENANT_B` | HTTP 200 OK with empty `[]` / 0 rows |

---

## 7. Required Owner Approvals for Part-2 Execution

The following explicit owner authorizations are required prior to live execution:
1. **Live Password Rotation Approval (`-RotateOnly`):** Authorization to run `scripts/rotate_staging_synthetic_passwords.ps1 -RotateOnly` in a private Windows PowerShell terminal with the staging service key.
2. **Staging Fixture Application Approval:** Authorization to run `supabase/staging/03_synthetic_diagnostic_and_job_fixtures.sql` in the Supabase Staging SQL Editor to seed the test records.
3. **Live Tenant Isolation Test Execution Approval (`-RunLiveTests`):** Authorization to execute `node website/tests/staging-live-tenant-isolation.test.cjs` against `rzkgmvyyeclrpomrlyft`.
4. **Fixture Teardown Execution:** Authorization to execute `supabase/staging/04_teardown_diagnostic_and_job_fixtures.sql` immediately following the test run.

Until these authorizations are granted, all live positive controls remain `NOT RUN`, and all engineering work remains strictly code-only.
