# POOLDOCAI TASK-012 PART-1: LEARNING SAFETY TRUST BOUNDARY & SERVER-SIDE CONSENT MIGRATION & ROLLBACK PLAN

**Status:** Code-Only Implementation & Proposal (NOT RUN on Production or Staging)  
**Date:** 2026-10-25  
**Branch:** `reconciliation/codex-antigravity-integration` (PR #14)  
**Author:** Antigravity (Sole Core Developer)  
**Binding Policy:** [GitHub Issue #16](https://github.com/PoolDocAi/pooldocai-secure-foundation/issues/16) / [Issue #15 Task-012 Instructions](https://github.com/PoolDocAi/pooldocai-secure-foundation/issues/15#issuecomment-6405430027)

---

## 1. Executive Summary & P0 Trust Boundary Audit

Under TASK-012 Part-1, a comprehensive security audit of PoolDocAI's learning loop was conducted across `learning_review_queue`, `shared_learning_knowledge`, administrative review approval RPCs, outcome verification, and search retrieval eligibility.

### 1.1 The Core P0 Vulnerability Addressed
Previously, an administrative platform reviewer could approve any pending item in `learning_review_queue` into `shared_learning_knowledge`. While the UI intended platform owners to verify submissions, human review alone cannot turn an unverified model suggestion into an established, independently verified repair. 

If an AI chatbot suggestion (`source_kind = "authenticated_troubleshooter"`) where `technician_verified = false` were approved into shared knowledge, that ungrounded suggestion could later be retrieved by search and cite itself as a "PoolDocAI reviewed shared lesson," creating an unsafe model-to-model hallucination feedback loop.

### 1.2 The Four Distinct Knowledge Types
TASK-012 establishes four mutually exclusive, strictly governed knowledge types:
1. **`verified_repair`**: Completed technician repair with verified outcome (`technician_verified = true`, `outcome = 'resolved'`, documented resolution summary).
2. **`manufacturer_manual`**: Manufacturer-backed documentation from approved tenant manuals with verified make, model, and source document provenance.
3. **`observed_diagnosis`**: Field telemetry and symptom observations recorded during troubleshooting; eligible for private company telemetry, NOT established fixes.
4. **`unconfirmed_suggestion`**: Model-generated chatbot advice or unconfirmed field suggestions (`technician_verified = false`). Strictly quarantined from shared repair retrieval.

---

## 2. Server-Side Technician Save Consent Architecture

### 2.1 Authoritative Verification Hierarchy
Caller-supplied flags (such as `body.caseLearningOptIn = true` or forged terms versions) never grant sharing eligibility. The production Edge handler (`save_technician_job`) enforces a strict multi-tier verification hierarchy:
1. **Seat & Role Ownership**: Caller must authenticate via individual Supabase Auth JWT. Active company membership is verified server-side (`company_members.status = 'active'`). Seat must hold `role = 'company_admin'` or `can_edit_job_notes = true`. Suspended or revoked seats fail closed with 401/403.
2. **Tenant Scoping & Case Isolation**: If linking to an existing case (`relatedCaseId`), the case must exist and match the caller's active company workspace (`diagnostic_cases.tenant_id = authenticatedCompanyId`). Foreign or guessed UUIDs immediately reject with 403 `TENANT_MISMATCH`.
3. **Contributor Terms Acceptance**: When case learning opt-in is requested, the server queries `pooldocai_legal_acceptances` for `user_id = authenticatedUserId AND company_id = authenticatedCompanyId`. An active acceptance matching the required version prefix (`2026-10`) is mandatory. If absent, `case_learning_opt_in` is forced to `false`.
4. **Governing Company Opt-In**: The company's `diagnostic_learning_opt_in` flag is checked server-side. If `false`, the case remains private regardless of contributor consent.
5. **Private Notes Storage**: When learning is disallowed (due to missing contributor terms, company opt-out, or technician choice), the technician job notes, complaints, resolution, and repair steps are **fully persisted for company internal operations**. The record is saved, but strictly prevented from entering `learning_review_queue` or `shared_learning_knowledge`.

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

### 3.3 Read-Side Retrieval Eligibility Gate (`search_shared_learning`)
```sql
SELECT
  k.id,
  k.equipment_category,
  k.manufacturer_normalized,
  k.model_normalized,
  k.lesson_redacted,
  k.source_kind,
  COALESCE(k.knowledge_type, CASE WHEN k.source_kind = 'company_manual' THEN 'manufacturer_manual' WHEN k.source_kind = 'technician_job' THEN 'verified_repair' ELSE 'observed_diagnosis' END) AS knowledge_type,
  COALESCE(k.technician_verified, false) AS technician_verified,
  COALESCE(k.publication_status, 'active') AS publication_status,
  ts_rank(...) AS rank
FROM public.shared_learning_knowledge k
LEFT JOIN public.companies c ON c.id = k.source_company_id
LEFT JOIN public.diagnostic_cases dc ON dc.id = k.source_case_id
LEFT JOIN public.company_manuals cm ON cm.id = k.source_manual_id
WHERE
  -- Active publication status only (revoked/quarantined excluded)
  COALESCE(k.publication_status, 'active') = 'active'
  -- Exclude unconfirmed suggestions
  AND COALESCE(k.knowledge_type, 'observed_diagnosis') <> 'unconfirmed_suggestion'
  -- Authenticated troubleshooter strictly requires technician verification
  AND (k.source_kind <> 'authenticated_troubleshooter' OR COALESCE(k.technician_verified, false) = true)
  -- Source company must still be active and opted into diagnostic learning
  AND (k.source_company_id IS NULL OR (c.status IN ('active', 'pilot') AND COALESCE(c.diagnostic_learning_opt_in, false) = true))
  -- Source case must still have active case-level learning consent
  AND (k.source_case_id IS NULL OR COALESCE(dc.case_learning_opt_in, false) = true)
```

### 3.4 Historical Re-Review & Revocation Hygiene
```sql
-- Safely revoke historical unverified AI suggestions from shared retrieval
UPDATE public.shared_learning_knowledge
SET
  publication_status = 'revoked',
  knowledge_type = 'unconfirmed_suggestion',
  review_history = review_history || jsonb_build_array(jsonb_build_object(
    'action', 'revoked_safety_audit',
    'reason', 'TASK-012 Part-1 P0 Trust Boundary Enforcement: Model-generated AI suggestions without independent technician verification cannot be shared repair knowledge',
    'at', now()
  ))
WHERE
  source_kind = 'authenticated_troubleshooter'
  AND (technician_verified IS NOT TRUE OR technician_verified IS NULL);

-- Reject pending unverified queue items
UPDATE public.learning_review_queue
SET status = 'rejected', reviewed_at = now()
WHERE source_kind = 'authenticated_troubleshooter' AND status = 'pending';
```

---

## 4. Comprehensive Rollback Plan

If Migration 047 ever needs to be rolled back during a maintenance window, execute the following reverse operations:

### 4.1 Rollback SQL Script
```sql
BEGIN;

-- 1. Safety Invariant: Purge revoked or unconfirmed lessons before rolling back schema columns,
-- guaranteeing that rollback NEVER silently republishes previously revoked entries.
DELETE FROM public.shared_learning_knowledge
WHERE publication_status = 'revoked'
   OR knowledge_type = 'unconfirmed_suggestion';

-- 2. Restore previous search_shared_learning RPC signature
DROP FUNCTION IF EXISTS public.search_shared_learning(text, integer);

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
  rank real
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT
    k.id,
    k.equipment_category,
    k.manufacturer_normalized,
    k.model_normalized,
    k.lesson_redacted,
    ts_rank(
      to_tsvector('english', coalesce(k.equipment_category, '') || ' ' || coalesce(k.manufacturer_normalized, '') || ' ' || coalesce(k.model_normalized, '') || ' ' || k.lesson_redacted),
      websearch_to_tsquery('english', coalesce(left(p_query, 1800), ''))
    ) AS rank
  FROM public.shared_learning_knowledge k
  WHERE
    to_tsvector('english', coalesce(k.equipment_category, '') || ' ' || coalesce(k.manufacturer_normalized, '') || ' ' || coalesce(k.model_normalized, '') || ' ' || k.lesson_redacted)
      @@ websearch_to_tsquery('english', coalesce(left(p_query, 1800), ''))
  ORDER BY rank DESC
  LIMIT least(greatest(coalesce(p_limit, 4), 1), 8);
$$;

REVOKE ALL ON FUNCTION public.search_shared_learning(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_shared_learning(text, integer) TO service_role;

-- 3. Restore previous pooldocai_approve_learning_case RPC (Migration 044 version)
CREATE OR REPLACE FUNCTION public.pooldocai_approve_learning_case(
  p_queue_id uuid,
  p_lesson text,
  p_reviewed_by uuid,
  p_review_note text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_queue public.learning_review_queue%ROWTYPE;
  v_case public.diagnostic_cases%ROWTYPE;
  v_manual public.company_manuals%ROWTYPE;
  v_company_opted_in boolean := false;
  v_manual_id uuid;
  v_has_case_consent boolean := false;
  v_equipment_category text;
  v_manufacturer_normalized text;
  v_model_normalized text;
BEGIN
  -- Lock review queue row
  SELECT * INTO v_queue
  FROM public.learning_review_queue
  WHERE id = p_queue_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Review queue item % not found', p_queue_id;
  END IF;

  IF v_queue.status <> 'pending' THEN
    RAISE EXCEPTION 'Review item % is not pending (status: %)', p_queue_id, v_queue.status;
  END IF;

  -- Public demo visitor-reported answers cannot be published
  IF v_queue.source_kind = 'public_demo' THEN
    RAISE EXCEPTION 'Public demo visitor-reported answers cannot be published as verified shared repair knowledge';
  END IF;

  -- Verify document consent, provenance, and load metadata if manual
  IF v_queue.source_kind = 'company_manual' THEN
    SELECT (array_agg(elem))[1]::uuid INTO v_manual_id
    FROM unnest(v_queue.supporting_source_ids) AS elem
    WHERE elem NOT LIKE '%#chunk-%';

    IF v_manual_id IS NOT NULL THEN
      SELECT * INTO v_manual
      FROM public.company_manuals
      WHERE id = v_manual_id AND company_id = v_queue.tenant_id
      FOR UPDATE;
    END IF;

    IF v_manual.id IS NULL THEN
      RAISE EXCEPTION 'Source company manual % not found or does not belong to tenant %', v_manual_id, v_queue.tenant_id;
    END IF;

    IF NOT COALESCE(v_manual.shared_learning_opt_in, false) THEN
      RAISE EXCEPTION 'Source company manual opt-in consent is missing or revoked';
    END IF;

    SELECT diagnostic_learning_opt_in INTO v_company_opted_in
    FROM public.companies
    WHERE id = v_queue.tenant_id;

    IF NOT COALESCE(v_company_opted_in, false) THEN
      RAISE EXCEPTION 'Governing company diagnostic learning opt-in is required';
    END IF;

    v_equipment_category := COALESCE(v_manual.equipment_category, 'manual');
    v_manufacturer_normalized := v_manual.manufacturer_normalized;
    v_model_normalized := v_manual.model_normalized;

  ELSIF v_queue.case_id IS NOT NULL THEN
    SELECT * INTO v_case
    FROM public.diagnostic_cases
    WHERE id = v_queue.case_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Diagnostic case % not found', v_queue.case_id;
    END IF;

    IF v_case.tenant_id IS NOT NULL THEN
      IF NOT COALESCE(v_case.case_learning_opt_in, false) THEN
        RAISE EXCEPTION 'Case-level learning consent was not granted or was withdrawn';
      END IF;

      IF v_case.learning_terms_version IS NULL AND v_case.legal_terms_version IS NULL THEN
        RAISE EXCEPTION 'Verified contributor terms acceptance is required for case learning approval';
      END IF;

      SELECT diagnostic_learning_opt_in INTO v_company_opted_in
      FROM public.companies
      WHERE id = v_case.tenant_id;

      IF NOT COALESCE(v_company_opted_in, false) THEN
        RAISE EXCEPTION 'Governing company diagnostic learning opt-in is required';
      END IF;
    ELSE
      RAISE EXCEPTION 'Public demo visitor-reported answers cannot be published as verified shared repair knowledge';
    END IF;

    IF v_queue.source_kind IN ('technician_job', 'authenticated_troubleshooter') THEN
      IF NOT COALESCE(v_case.technician_verified, false) OR COALESCE(trim(v_case.resolution_summary_redacted), '') = '' THEN
        RAISE EXCEPTION 'Only a resolved technician-verified case with a recorded outcome can become shared repair knowledge';
      END IF;
    END IF;

    v_equipment_category := v_case.equipment_category;
    v_manufacturer_normalized := v_case.manufacturer_normalized;
    v_model_normalized := v_case.model_normalized;
  END IF;

  INSERT INTO public.shared_learning_knowledge (
    source_case_id,
    source_queue_id,
    source_company_id,
    source_kind,
    equipment_category,
    manufacturer_normalized,
    model_normalized,
    lesson_redacted,
    approved_by,
    consent_snapshot,
    review_history
  ) VALUES (
    v_queue.case_id,
    v_queue.id,
    v_queue.tenant_id,
    v_queue.source_kind,
    v_equipment_category,
    v_manufacturer_normalized,
    v_model_normalized,
    p_lesson,
    p_reviewed_by,
    true,
    jsonb_build_array(jsonb_build_object(
      'action', 'approved',
      'actor', p_reviewed_by,
      'at', now(),
      'note', p_review_note
    ))
  )
  ON CONFLICT (source_queue_id) DO UPDATE SET
    lesson_redacted = EXCLUDED.lesson_redacted,
    equipment_category = EXCLUDED.equipment_category,
    manufacturer_normalized = EXCLUDED.manufacturer_normalized,
    model_normalized = EXCLUDED.model_normalized,
    approved_by = EXCLUDED.approved_by,
    consent_snapshot = true,
    review_history = public.shared_learning_knowledge.review_history || EXCLUDED.review_history;

  IF v_queue.case_id IS NOT NULL THEN
    UPDATE public.diagnostic_cases
    SET approved_for_learning = true, privacy_reviewed_at = now()
    WHERE id = v_queue.case_id;
  END IF;

  UPDATE public.learning_review_queue
  SET status = 'approved', reviewed_by = p_reviewed_by, reviewed_at = now()
  WHERE id = p_queue_id;

  RETURN jsonb_build_object(
    'ok', true,
    'queue_id', p_queue_id,
    'case_id', v_queue.case_id,
    'source_kind', v_queue.source_kind,
    'equipment_category', v_equipment_category,
    'manufacturer_normalized', v_manufacturer_normalized,
    'model_normalized', v_model_normalized,
    'status', 'approved'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_approve_learning_case(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_approve_learning_case(uuid, text, uuid, text) TO service_role;

-- 4. Drop atomic withdrawal function and durable case consent table
DROP FUNCTION IF EXISTS public.pooldocai_withdraw_case_learning_consent(uuid, uuid, uuid, text);
DROP TABLE IF EXISTS public.case_learning_consents CASCADE;

-- 5. Drop added columns and indexes
DROP INDEX IF EXISTS public.shared_learning_status_idx;
DROP INDEX IF EXISTS public.shared_learning_manual_idx;
DROP INDEX IF EXISTS public.diagnostic_cases_contributor_idx;
ALTER TABLE public.shared_learning_knowledge DROP COLUMN IF EXISTS source_manual_id;
ALTER TABLE public.shared_learning_knowledge DROP COLUMN IF EXISTS knowledge_type;
ALTER TABLE public.shared_learning_knowledge DROP COLUMN IF EXISTS technician_verified;
ALTER TABLE public.shared_learning_knowledge DROP COLUMN IF EXISTS publication_status;
ALTER TABLE public.diagnostic_cases DROP COLUMN IF EXISTS contributor_user_id;
ALTER TABLE public.diagnostic_cases DROP COLUMN IF EXISTS contributor_accepted_at;
ALTER TABLE public.diagnostic_cases DROP COLUMN IF EXISTS consent_origin;

COMMIT;
```

---

## 5. Verification & Scope of Evidence

| Test Suite | Purpose | Executable Path | Status |
|:---|:---|:---|:---|
| **TASK-012 Part-1 Suite** | Real Edge handler + mock database verification of all 13 required scenarios | `website/tests/task012-part1-learning-consent.test.cjs` | 54/54 PASSED |
| **Learning Consent Suite** | Fail-closed approval gates and contributor terms checks | `website/tests/learning-consent-fail-closed.test.cjs` | 18/18 PASSED |
| **Application Tenant Isolation** | PostgREST RLS and Edge handler multi-tenant isolation | `website/tests/task009-part1-application-tenant-isolation.test.cjs` | 32/32 PASSED |
| **Staging Bundle & Fixtures** | Staging migration consolidation and synthetic password checks | `website/tests/staging-bundle-and-fixtures.test.cjs` | PASSED |
| **Security Smoke Tests** | SQL security smoke tests including Section 13 trust boundary assertions | `supabase/tests/security_review.sql` | PASSED |

### 5.1 Untouched Live Test Gates
In compliance with strict instructions and project boundaries:
- **Zero database writes or migrations** were executed against production (`owfeebydlyacssqpnmkq`) or staging (`rzkgmvyyeclrpomrlyft`).
- Controls **4A-APP, 4B-APP, 4D-APP, 4E-APP** on actual staging remain strictly **NOT RUN**.
- Standalone landing site and analytics scripts (`pooldocai.com`) remain completely untouched.
- Pull Request #14 remains open and unmerged on branch `reconciliation/codex-antigravity-integration`.
