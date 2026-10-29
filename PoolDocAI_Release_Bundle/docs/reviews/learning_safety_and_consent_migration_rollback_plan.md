# POOLDOCAI TASK-012 / TASK-013B: LEARNING SAFETY TRUST BOUNDARY & SERVER-SIDE CONSENT MIGRATION & ROLLBACK PLAN

**Status:** Code-Only Implementation & Proposal (NOT RUN on Production or Staging)  
**Date:** 2026-10-29  
**Branch:** `reconciliation/codex-antigravity-integration` (PR #14)  
**Author:** Antigravity (Sole Core Developer)  
**Binding Policy:** [GitHub Issue #16](https://github.com/PoolDocAi/pooldocai-secure-foundation/issues/16) / [Issue #15 Task-012 & Task-013B Instructions](https://github.com/PoolDocAi/pooldocai-secure-foundation/issues/15)

---

## 1. Executive Summary & P0 Trust Boundary Audit

Under TASK-012 Part-1 and TASK-013B, a comprehensive security remediation of PoolDocAI's learning loop was conducted across `case_learning_consents`, `learning_review_queue`, `shared_learning_knowledge`, administrative review approval RPCs, outcome verification, and search retrieval eligibility.

### 1.1 The Core P0 Vulnerabilities Addressed
1. **Unverified Model Suggestions:** Previously, an administrative platform reviewer could approve any pending item in `learning_review_queue` into `shared_learning_knowledge`. Human review alone cannot turn an unverified model suggestion into an established, independently verified repair.
2. **Explicit Case-Specific Learning Consent:** Generic workspace Terms acceptance (`pooldocai_legal_acceptances`) plus a client boolean (`caseLearningOptIn: true` during `save_technician_job`) never independently creates authoritative case-sharing consent (`case_learning_consents`). Creating a new job saves private notes first (`case_learning_opt_in = false`), and sharing requires a separate, authenticated, purpose-specific `grant_case_learning_consent` transition bound to the case, company, authenticated contributor, purpose (`shared_diagnostic_learning`), consent version (`2026-10-case-learning-v1`), and timestamp.
3. **Fail-Closed Consent Error Handling:** Every consent-related PostgREST read, write, and RPC (`case_learning_consents`, `pooldocai_legal_acceptances`, `diagnostic_cases`, `companies`, `learning_review_queue`) explicitly checks `{ error }` and fails closed without creating review candidates or reporting false opt-in success.

### 1.2 The Four Distinct Knowledge Types
TASK-012 establishes four mutually exclusive, strictly governed knowledge types:
1. **`verified_repair`**: Completed technician repair with verified outcome (`technician_verified = true`, `outcome = 'resolved'`, documented resolution summary).
2. **`manufacturer_manual`**: Manufacturer-backed documentation from approved tenant manuals with verified make, model, and source document provenance.
3. **`observed_diagnosis`**: Field telemetry and symptom observations recorded during troubleshooting; eligible for private company telemetry, NOT established fixes.
4. **`unconfirmed_suggestion`**: Model-generated chatbot advice or unconfirmed field suggestions (`technician_verified = false`). Strictly quarantined from shared repair retrieval.

---

## 2. Server-Side Technician Save & Explicit Case Consent Architecture

### 2.1 Authoritative Verification Hierarchy
Caller-supplied flags (such as `body.caseLearningOptIn = true` or forged terms versions/user IDs) never grant sharing eligibility. The production Edge handler enforces a strict multi-tier verification hierarchy across `save_technician_job` and `grant_case_learning_consent`:
1. **Seat & Role Ownership**: Caller must authenticate via individual Supabase Auth JWT. Active company membership is verified server-side (`company_members.status = 'active'`). Seat must hold `role = 'company_admin'` or `can_edit_job_notes = true`. Suspended or revoked seats fail closed with 401/403.
2. **Tenant Scoping & Case Isolation**: If linking to or consenting on an existing case (`relatedCaseId` / `caseId`), the case must exist and match the caller's active company workspace (`diagnostic_cases.tenant_id = authenticatedCompanyId`). Foreign or guessed UUIDs immediately reject with 403 `TENANT_MISMATCH`.
3. **Purpose-Specific Explicit Case Consent (`grant_case_learning_consent`)**:
   - Generic workspace Terms acceptance in `pooldocai_legal_acceptances` is a prerequisite check, never a substitute for case-specific consent.
   - `save_technician_job` never inserts or upserts rows in `case_learning_consents`. New cases created during `save_technician_job` are persisted privately (`case_learning_opt_in = false`, `contributor_user_id = authenticatedUserId`) and return `caseId` so the authenticated contributor can invoke `grant_case_learning_consent` as an explicit, separate action.
   - `grant_case_learning_consent` verifies `caseLearningConsentAttested === true`, `purpose === "shared_diagnostic_learning"`, current `2026-10` contributor legal terms, case ownership (`contributor_user_id === authenticatedUserId`), and absence of prior withdrawal (`409 CONSENT_WITHDRAWN_LOCKED` if `'withdrawn'` or `'revoked'`), then durably records the `'granted'` row in `case_learning_consents`.
4. **Fail-Closed Database Error Handling**: If any lookup or write on `case_learning_consents`, `pooldocai_legal_acceptances`, `diagnostic_cases`, `companies`, or `learning_review_queue` returns `{ error }`, the handler fails closed (`effectiveCaseOptIn = false`, no queue insertion, explicit failure status/code returned).
5. **Private Notes Storage**: When shared-learning consent is absent or consent verification fails closed, authorized private technician job notes, complaints, resolution, and repair steps are still preserved for company-internal operations without entering `learning_review_queue` or `shared_learning_knowledge`.

---

## 3. Migration Proposal (Migration 047)

**File:** `supabase/migrations/20261025210000_learning_safety_and_consent_lifecycle.sql`  
**Staging Bundle:** Consolidated into `supabase/staging/00_apply_staging_migrations.sql`  
**Status:** **NOT RUN on live production (`owfeebydlyacssqpnmkq`) or staging (`rzkgmvyyeclrpomrlyft`)**.

### 3.1 Schema Additions
```sql
ALTER TABLE public.shared_learning_knowledge
  ADD COLUMN IF NOT EXISTS knowledge_type text DEFAULT 'observed_diagnosis'
  CHECK (knowledge_type IN ('verified_repair', 'manufacturer_manual', 'observed_diagnosis', 'unconfirmed_suggestion'));

ALTER TABLE public.shared_learning_knowledge
  ADD COLUMN IF NOT EXISTS technician_verified boolean DEFAULT false;

ALTER TABLE public.shared_learning_knowledge
  ADD COLUMN IF NOT EXISTS publication_status text NOT NULL DEFAULT 'active'
  CHECK (publication_status IN ('active', 'revoked', 'quarantined'));

CREATE INDEX IF NOT EXISTS shared_learning_status_idx
  ON public.shared_learning_knowledge (publication_status, knowledge_type, technician_verified);
```

### 3.2 Server-Side Hard Evidence Gate (`pooldocai_approve_learning_case`)
```sql
-- Hard Evidence Gate: Model-generated AI suggestions without technician verification cannot be published
IF v_queue.source_kind = 'authenticated_troubleshooter' AND NOT COALESCE(v_case.technician_verified, false) THEN
  RAISE EXCEPTION 'Model-generated authenticated_troubleshooter suggestion without technician verification cannot be published as shared repair knowledge';
END IF;

-- Technician jobs must be technician_verified and have recorded resolution summary
IF v_queue.source_kind IN ('technician_job', 'authenticated_troubleshooter') THEN
  IF NOT COALESCE(v_case.technician_verified, false) OR COALESCE(trim(v_case.resolution_summary_redacted), '') = '' THEN
    RAISE EXCEPTION 'Only a resolved technician-verified case with a recorded outcome can become shared repair knowledge';
  END IF;
END IF;
```

---

## 4. Comprehensive Rollback & Fail-Closed Recovery Plan

> [!CAUTION]
> **DESTRUCTIVE SCHEMA REVERSAL IS BLOCKED:** Dropping `public.case_learning_consents`, dropping columns (`publication_status`, `knowledge_type`, `source_manual_id`, `technician_verified`, `contributor_user_id`, `contributor_accepted_at`, `consent_origin`), or executing `DELETE FROM public.shared_learning_knowledge` is **STRICTLY BLOCKED** without a verified point-in-time backup and separate written Owner authorization. Reversing schema columns or restoring a pre-044 `search_shared_learning` function would strip company, manual, case-consent, and publication-status predicates and destroy audit history.

If Migration 047 experiences an operational incident during a maintenance window, operators MUST execute the **Non-Destructive Fail-Closed Recovery & Quarantine Script** below. This procedure:
1. Retains 100% of audit records (`learning_review_audit`, `case_learning_consents`, `shared_learning_knowledge.review_history`) with zero `DELETE` statements and zero `DROP TABLE` / `DROP COLUMN` statements.
2. Non-destructively transitions (`publication_status = 'quarantined'`) any row that is `revoked`, `quarantined`, `observed_diagnosis`, `unconfirmed_suggestion`, `public_demo`, unverified `authenticated_troubleshooter`, or missing active company, manual, or durable case-specific consent.
3. Re-applies the fail-closed `search_shared_learning` retrieval function preserving every company, tenant, manual-sharing, case-consent (`case_learning_consents.consent_status = 'granted'`), publication-status (`'active'`), and knowledge-type (`'verified_repair'`, `'manufacturer_manual'`) safeguard.

### 4.1 Rollback SQL Script
```sql
BEGIN;

-- 1. Non-Destructive Fail-Closed Quarantine:
-- Never delete rows or audit history. Quarantine any entry whose consent, verification,
-- manual permission, company opt-in, or knowledge_type is ineligible for shared retrieval.
UPDATE public.shared_learning_knowledge k
SET
  publication_status = 'quarantined',
  consent_snapshot = false,
  review_history = COALESCE(k.review_history, '[]'::jsonb) || jsonb_build_array(
    jsonb_build_object(
      'action', 'fail_closed_recovery_quarantine',
      'at', now(),
      'reason', 'Non-destructive recovery quarantine check enforced'
    )
  )
WHERE k.publication_status <> 'revoked'
  AND (
    k.publication_status = 'quarantined'
    OR k.knowledge_type IN ('unconfirmed_suggestion', 'observed_diagnosis')
    OR k.knowledge_type NOT IN ('verified_repair', 'manufacturer_manual')
    OR k.source_kind = 'public_demo'
    OR COALESCE(k.consent_snapshot, false) = false
    OR k.source_company_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM public.companies c
      WHERE c.id = k.source_company_id
        AND c.status = 'active'
        AND COALESCE(c.diagnostic_learning_opt_in, false) = true
    )
    OR (
      k.source_kind = 'company_manual'
      AND (
        k.source_manual_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.company_manuals m
          WHERE m.id = k.source_manual_id
            AND m.company_id = k.source_company_id
            AND COALESCE(m.shared_learning_opt_in, false) = true
            AND COALESCE(m.reference_enabled, false) = true
            AND m.extraction_status = 'ready'
        )
      )
    )
    OR (
      k.source_kind IN ('technician_job', 'authenticated_troubleshooter')
      AND (
        k.source_case_id IS NULL
        OR COALESCE(k.technician_verified, false) = false
        OR NOT EXISTS (
          SELECT 1
          FROM public.diagnostic_cases dc
          JOIN public.case_learning_consents clc
            ON clc.case_id = dc.id
           AND clc.purpose = 'shared_diagnostic_learning'
          WHERE dc.id = k.source_case_id
            AND dc.tenant_id = k.source_company_id
            AND dc.case_status = 'resolved'
            AND COALESCE(dc.technician_verified, false) = true
            AND COALESCE(dc.case_learning_opt_in, false) = true
            AND COALESCE(dc.approved_for_learning, false) = true
            AND clc.company_id = dc.tenant_id
            AND clc.consent_status = 'granted'
            AND clc.terms_version LIKE '2026-10%'
            AND (dc.contributor_user_id IS NULL OR clc.actor_user_id = dc.contributor_user_id)
        )
      )
    )
  );

-- 2. Re-assert fail-closed search_shared_learning RPC with full company, manual,
-- durable case-consent, publication_status, and knowledge_type predicates.
CREATE OR REPLACE FUNCTION public.search_shared_learning(
  p_query text,
  p_limit integer DEFAULT 4
)
RETURNS TABLE(
  id uuid,
  equipment_category text,
  manufacturer_normalized text,
  model_normalized text,
  lesson_redacted text,
  knowledge_type text,
  rank real
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT
    k.id,
    k.equipment_category,
    k.manufacturer_normalized,
    k.model_normalized,
    k.lesson_redacted,
    k.knowledge_type,
    ts_rank(
      to_tsvector('english', coalesce(k.equipment_category, '') || ' ' || coalesce(k.manufacturer_normalized, '') || ' ' || coalesce(k.model_normalized, '') || ' ' || coalesce(k.lesson_redacted),
      websearch_to_tsquery('english', coalesce(left(p_query, 1800), ''))
    ) AS rank
  FROM public.shared_learning_knowledge k
  JOIN public.companies c
    ON c.id = k.source_company_id
  LEFT JOIN public.diagnostic_cases dc
    ON dc.id = k.source_case_id
  LEFT JOIN public.case_learning_consents clc
    ON clc.case_id = dc.id
   AND clc.purpose = 'shared_diagnostic_learning'
  WHERE
    k.publication_status = 'active'
    AND k.consent_snapshot = true
    AND k.knowledge_type IN ('verified_repair', 'manufacturer_manual')
    AND k.source_kind IN ('technician_job', 'company_manual', 'authenticated_troubleshooter')
    AND c.status = 'active'
    AND c.diagnostic_learning_opt_in = true
    AND (
      (
        k.source_kind = 'company_manual'
        AND k.knowledge_type = 'manufacturer_manual'
        AND (
          (
            k.source_manual_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM public.company_manuals m
              WHERE m.id = k.source_manual_id
                AND m.company_id = k.source_company_id
                AND m.shared_learning_opt_in = true
                AND m.reference_enabled = true
                AND m.extraction_status = 'ready'
            )
          )
          OR (
            k.source_manual_id IS NULL
            AND EXISTS (
              SELECT 1
              FROM public.learning_review_queue q
              JOIN public.company_manuals m
                ON m.company_id = q.tenant_id
               AND m.id::text = ANY(q.supporting_source_ids)
              WHERE q.id = k.source_queue_id
                AND m.shared_learning_opt_in = true
                AND m.reference_enabled = true
                AND m.extraction_status = 'ready'
            )
          )
        )
      )
      OR (
        k.source_kind IN ('technician_job', 'authenticated_troubleshooter')
        AND k.knowledge_type = 'verified_repair'
        AND k.technician_verified = true
        AND dc.id IS NOT NULL
        AND dc.tenant_id = k.source_company_id
        AND dc.case_status = 'resolved'
        AND dc.technician_verified = true
        AND dc.case_learning_opt_in = true
        AND dc.approved_for_learning = true
        AND clc.consent_status = 'granted'
        AND clc.company_id = dc.tenant_id
        AND clc.terms_version LIKE '2026-10%'
      )
    )
    AND to_tsvector('english', coalesce(k.equipment_category, '') || ' ' || coalesce(k.manufacturer_normalized, '') || ' ' || coalesce(k.model_normalized, '') || ' ' || coalesce(k.lesson_redacted)
      @@ websearch_to_tsquery('english', coalesce(left(p_query, 1800), ''))
  ORDER BY rank DESC
  LIMIT least(greatest(coalesce(p_limit, 4), 1), 8);
$$;

REVOKE ALL ON FUNCTION public.search_shared_learning(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_shared_learning(text, integer) TO service_role;

COMMIT;
```

---

## 5. Verification & Scope of Evidence

| Test Suite | Purpose | Executable Path | Status |
|:---|:---|:---|:---|
| **TASK-012 / TASK-013B Suite** | Real Edge handler + mock database verification of explicit case consent, fail-closed DB errors, and non-destructive rollback simulation | `website/tests/task012-part1-learning-consent.test.cjs` | PASSED |
| **Learning Consent Suite** | Fail-closed approval gates and contributor terms checks | `website/tests/learning-consent-fail-closed.test.cjs` | PASSED |
| **Application Tenant Isolation** | PostgREST RLS and Edge handler multi-tenant isolation | `website/tests/task009-part1-application-tenant-isolation.test.cjs` | PASSED |
| **Staging Bundle & Fixtures** | Staging migration consolidation and synthetic password checks | `website/tests/staging-bundle-and-fixtures.test.cjs` | PASSED |
| **Security Smoke Tests** | SQL security smoke tests including Section 13 trust boundary & rollback simulation assertions | `supabase/tests/security_review.sql` | PASSED |

### 5.1 Untouched Live Test Gates
In compliance with strict instructions and project boundaries:
- **Zero database writes or migrations** were executed against production (`owfeebydlyacssqpnmkq`) or staging (`rzkgmvyyeclrpomrlyft`).
- Controls **4A-APP, 4B-APP, 4D-APP, 4E-APP** on actual staging remain strictly **NOT RUN**.
- Standalone landing site and analytics scripts (`pooldocai.com`) remain completely untouched.
- Pull Request #14 remains open and unmerged on branch `reconciliation/codex-antigravity-integration`.
