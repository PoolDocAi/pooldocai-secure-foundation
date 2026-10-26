-- Migration 047: Learning Publication Safety Trust Boundary, Knowledge Typing, and Consent Lifecycle
-- Forward-only and additive.
-- Enforces:
-- 1) Schema extensions on shared_learning_knowledge:
--    - knowledge_type: verified_repair, manufacturer_manual, observed_diagnosis, unconfirmed_suggestion
--    - technician_verified: boolean flag
--    - publication_status: active, revoked, quarantined
--    - source_manual_id: uuid reference to company_manuals(id)
-- 2) Dedicated Durable Case-Specific Consent Record:
--    - case_learning_consents table tracking authenticated actor, company/case, purpose, terms version, and revocation lifecycle.
-- 3) Atomic Security-Definer Consent Withdrawal RPC:
--    - pooldocai_withdraw_case_learning_consent: single transactional operation updating diagnostic_cases,
--      recording withdrawal in case_learning_consents, soft-revoking shared_learning_knowledge,
--      rejecting review queue items, and logging immutable audit trail.
-- 4) Strict Server-Side Evidence & Tenant Match Gates on pooldocai_approve_learning_case:
--    - Asserts v_case.tenant_id = v_queue.tenant_id (cross-tenant mismatch strictly rejected).
--    - Asserts v_case.case_status = 'resolved' (unresolved cases cannot be published as verified repairs).
--    - Asserts authenticated contributor provenance (contributor_user_id IS NOT NULL).
--    - Asserts active granted record in case_learning_consents.
--    - Rejects model-generated authenticated_troubleshooter suggestions with technician_verified=false.
-- 5) Strict Read & Search Eligibility on search_shared_learning:
--    - Excludes revoked entries (publication_status = 'revoked')
--    - Restricts actionable procedure retrieval to verified repairs and eligible manufacturer manuals
--      (excludes observed_diagnosis and unconfirmed_suggestion)
--    - Enforces per-document company manual consent (joins company_manuals on source_manual_id;
--      if individual manual shared_learning_opt_in is revoked, excludes immediately even if company remains opted in)
--    - Enforces active case_learning_consents row for case-backed records.
-- 6) Historical Re-Review & Revocation Hygiene:
--    - Safely revokes historical unverified authenticated_troubleshooter rows from shared retrieval.
--    - Rejects pending review queue items lacking independent technician verification.
--
-- STRICT NOTE: Code-only task. This migration is committed to the repository for review and staging bundle parity.
-- DO NOT EXECUTE on staging or production databases without separate owner authorization.

BEGIN;

-- 1. Extend shared_learning_knowledge schema
ALTER TABLE public.shared_learning_knowledge
  ADD COLUMN IF NOT EXISTS knowledge_type text DEFAULT 'observed_diagnosis'
  CHECK (knowledge_type IN ('verified_repair', 'manufacturer_manual', 'observed_diagnosis', 'unconfirmed_suggestion'));

ALTER TABLE public.shared_learning_knowledge
  ADD COLUMN IF NOT EXISTS technician_verified boolean DEFAULT false;

ALTER TABLE public.shared_learning_knowledge
  ADD COLUMN IF NOT EXISTS publication_status text NOT NULL DEFAULT 'active'
  CHECK (publication_status IN ('active', 'revoked', 'quarantined'));

ALTER TABLE public.shared_learning_knowledge
  ADD COLUMN IF NOT EXISTS source_manual_id uuid REFERENCES public.company_manuals(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS shared_learning_status_idx
  ON public.shared_learning_knowledge (publication_status, knowledge_type, technician_verified);

CREATE INDEX IF NOT EXISTS shared_learning_manual_idx
  ON public.shared_learning_knowledge (source_manual_id)
  WHERE source_manual_id IS NOT NULL;

-- 1b. Extend diagnostic_cases schema with authenticated contributor provenance and consent origin
ALTER TABLE public.diagnostic_cases
  ADD COLUMN IF NOT EXISTS contributor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contributor_accepted_at timestamptz,
  ADD COLUMN IF NOT EXISTS consent_origin text;

CREATE INDEX IF NOT EXISTS diagnostic_cases_contributor_idx
  ON public.diagnostic_cases (contributor_user_id, contributor_accepted_at)
  WHERE contributor_user_id IS NOT NULL;

-- 2. Durable Case-Specific Learning Consent Table
CREATE TABLE IF NOT EXISTS public.case_learning_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id uuid NOT NULL REFERENCES public.diagnostic_cases(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  purpose text NOT NULL DEFAULT 'shared_diagnostic_learning',
  terms_version text NOT NULL,
  consent_status text NOT NULL DEFAULT 'granted' CHECK (consent_status IN ('granted', 'withdrawn', 'revoked')),
  granted_at timestamptz NOT NULL DEFAULT now(),
  withdrawn_at timestamptz,
  revocation_reason text,
  UNIQUE (case_id, purpose)
);

ALTER TABLE public.case_learning_consents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.case_learning_consents FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.case_learning_consents TO service_role;

-- 3. Atomic Transactional Consent Withdrawal RPC
CREATE OR REPLACE FUNCTION public.pooldocai_withdraw_case_learning_consent(
  p_case_id uuid,
  p_company_id uuid,
  p_actor_user_id uuid,
  p_reason text DEFAULT 'Consent withdrawn by company'
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_case public.diagnostic_cases%ROWTYPE;
BEGIN
  -- Lock diagnostic case row
  SELECT * INTO v_case
  FROM public.diagnostic_cases
  WHERE id = p_case_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Diagnostic case % not found', p_case_id;
  END IF;

  IF v_case.tenant_id <> p_company_id THEN
    RAISE EXCEPTION 'You cannot modify another company''s case';
  END IF;

  -- 1. Update diagnostic case flags
  UPDATE public.diagnostic_cases
  SET case_learning_opt_in = false,
      approved_for_learning = false,
      privacy_reviewed_at = NULL
  WHERE id = p_case_id;

  -- 2. Update or insert durable case consent state
  INSERT INTO public.case_learning_consents (
    case_id, company_id, actor_user_id, purpose, terms_version, consent_status, granted_at, withdrawn_at, revocation_reason
  ) VALUES (
    p_case_id, p_company_id, p_actor_user_id, 'shared_diagnostic_learning',
    COALESCE(v_case.learning_terms_version, 'withdrawn'), 'withdrawn', now(), now(), p_reason
  )
  ON CONFLICT (case_id, purpose) DO UPDATE SET
    consent_status = 'withdrawn',
    withdrawn_at = now(),
    revocation_reason = EXCLUDED.revocation_reason;

  -- 3. Soft-revoke shared knowledge publications
  UPDATE public.shared_learning_knowledge
  SET publication_status = 'revoked',
      review_history = review_history || jsonb_build_array(jsonb_build_object(
        'action', 'consent_withdrawn',
        'actor', p_actor_user_id,
        'at', now(),
        'reason', p_reason
      ))
  WHERE source_case_id = p_case_id AND publication_status <> 'revoked';

  -- 4. Update review queue entries
  UPDATE public.learning_review_queue
  SET status = 'rejected', reviewed_at = now()
  WHERE case_id = p_case_id AND status IN ('pending', 'approved');

  -- 5. Immutable audit record
  INSERT INTO public.learning_review_audit (
    case_id, actor_user_id, action, note_redacted
  ) VALUES (
    p_case_id, p_actor_user_id, 'rejected', p_reason
  );

  RETURN jsonb_build_object(
    'ok', true,
    'case_id', p_case_id,
    'status', 'consent_withdrawn'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_withdraw_case_learning_consent(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_withdraw_case_learning_consent(uuid, uuid, uuid, text) TO service_role;

-- 4. Update pooldocai_approve_learning_case with tenant match, resolved outcome, and durable consent checks
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
  v_knowledge_type text;
  v_technician_verified boolean := false;
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

  -- P0 Evidence Gate 1: Public demo visitor-reported answers are unverified customer feedback signals
  -- and cannot be published as verified shared repair knowledge.
  IF v_queue.source_kind = 'public_demo' THEN
    RAISE EXCEPTION 'Public demo visitor-reported answers cannot be published as verified shared repair knowledge';
  END IF;

  -- P0 Evidence Gate 2: Company manual provenance and document consent
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

    -- Recheck governing company diagnostic learning opt-in
    SELECT diagnostic_learning_opt_in INTO v_company_opted_in
    FROM public.companies
    WHERE id = v_queue.tenant_id;

    IF NOT COALESCE(v_company_opted_in, false) THEN
      RAISE EXCEPTION 'Governing company diagnostic learning opt-in is required';
    END IF;

    v_equipment_category := COALESCE(v_manual.equipment_category, 'manual');
    v_manufacturer_normalized := v_manual.manufacturer_normalized;
    v_model_normalized := v_manual.model_normalized;
    v_knowledge_type := 'manufacturer_manual';
    v_technician_verified := false;

  ELSIF v_queue.case_id IS NOT NULL THEN
    -- Lock diagnostic case row
    SELECT * INTO v_case
    FROM public.diagnostic_cases
    WHERE id = v_queue.case_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Diagnostic case % not found', v_queue.case_id;
    END IF;

    -- Strict Tenant Match Check: Diagnostic case tenant must match review queue tenant
    IF v_case.tenant_id IS DISTINCT FROM v_queue.tenant_id THEN
      RAISE EXCEPTION 'Diagnostic case % tenant % does not match review queue tenant %', v_case.id, v_case.tenant_id, v_queue.tenant_id;
    END IF;

    -- Consent and verified contributor terms check:
    IF v_case.tenant_id IS NOT NULL THEN
      IF NOT COALESCE(v_case.case_learning_opt_in, false) THEN
        RAISE EXCEPTION 'Case-level learning consent was not granted or was withdrawn';
      END IF;

      IF v_case.learning_terms_version IS NULL AND v_case.legal_terms_version IS NULL THEN
        RAISE EXCEPTION 'Verified contributor terms acceptance is required for case learning approval';
      END IF;

      -- Check durable case-specific learning consent record
      IF NOT EXISTS (
        SELECT 1 FROM public.case_learning_consents
        WHERE case_id = v_case.id AND consent_status = 'granted' AND company_id = v_case.tenant_id
      ) THEN
        RAISE EXCEPTION 'Durable case-specific learning consent record is missing or withdrawn';
      END IF;

      -- Verify authenticated contributor provenance
      IF v_case.contributor_user_id IS NULL OR v_case.contributor_accepted_at IS NULL THEN
        RAISE EXCEPTION 'Authenticated contributor consent provenance is required for case learning approval';
      END IF;

      -- Recheck governing company consent
      SELECT diagnostic_learning_opt_in INTO v_company_opted_in
      FROM public.companies
      WHERE id = v_case.tenant_id;

      IF NOT COALESCE(v_company_opted_in, false) THEN
        RAISE EXCEPTION 'Governing company diagnostic learning opt-in is required';
      END IF;
    ELSE
      RAISE EXCEPTION 'Public demo visitor-reported answers cannot be published as verified shared repair knowledge';
    END IF;

    -- P0 Evidence Gate 3: Model-generated troubleshooter suggestions without technician verification
    -- CANNOT become established verified repairs solely because a platform reviewer approved it.
    IF v_queue.source_kind = 'authenticated_troubleshooter' AND NOT COALESCE(v_case.technician_verified, false) THEN
      RAISE EXCEPTION 'Model-generated authenticated_troubleshooter suggestion without technician verification cannot be published as shared repair knowledge';
    END IF;

    -- P0 Evidence Gate 4: Authoritative Outcome Check: Case status must be 'resolved'
    IF v_queue.source_kind IN ('technician_job', 'authenticated_troubleshooter') THEN
      IF v_case.case_status <> 'resolved' THEN
        RAISE EXCEPTION 'Only a resolved case with status resolved can become shared repair knowledge (current status: %)', v_case.case_status;
      END IF;
      IF NOT COALESCE(v_case.technician_verified, false) OR COALESCE(trim(v_case.resolution_summary_redacted), '') = '' THEN
        RAISE EXCEPTION 'Only a resolved technician-verified case with a recorded outcome can become shared repair knowledge';
      END IF;
    END IF;

    v_equipment_category := v_case.equipment_category;
    v_manufacturer_normalized := v_case.manufacturer_normalized;
    v_model_normalized := v_case.model_normalized;
    v_technician_verified := COALESCE(v_case.technician_verified, false);
    v_knowledge_type := CASE
      WHEN v_technician_verified THEN 'verified_repair'
      ELSE 'observed_diagnosis'
    END;
  ELSE
    RAISE EXCEPTION 'Review queue item % has no associated case or manual source', p_queue_id;
  END IF;

  -- Upsert into shared_learning_knowledge atomically with exact metadata provenance, manual ID, and verification status
  INSERT INTO public.shared_learning_knowledge (
    source_case_id,
    source_queue_id,
    source_company_id,
    source_manual_id,
    source_kind,
    equipment_category,
    manufacturer_normalized,
    model_normalized,
    lesson_redacted,
    approved_by,
    consent_snapshot,
    knowledge_type,
    technician_verified,
    publication_status,
    review_history
  ) VALUES (
    v_queue.case_id,
    v_queue.id,
    v_queue.tenant_id,
    v_manual_id,
    v_queue.source_kind,
    v_equipment_category,
    v_manufacturer_normalized,
    v_model_normalized,
    p_lesson,
    p_reviewed_by,
    true,
    v_knowledge_type,
    v_technician_verified,
    'active',
    jsonb_build_array(jsonb_build_object(
      'action', 'approved',
      'actor', p_reviewed_by,
      'at', now(),
      'note', p_review_note,
      'knowledge_type', v_knowledge_type,
      'technician_verified', v_technician_verified
    ))
  )
  ON CONFLICT (source_queue_id) DO UPDATE SET
    lesson_redacted = EXCLUDED.lesson_redacted,
    equipment_category = EXCLUDED.equipment_category,
    manufacturer_normalized = EXCLUDED.manufacturer_normalized,
    model_normalized = EXCLUDED.model_normalized,
    source_manual_id = EXCLUDED.source_manual_id,
    approved_by = EXCLUDED.approved_by,
    consent_snapshot = true,
    knowledge_type = EXCLUDED.knowledge_type,
    technician_verified = EXCLUDED.technician_verified,
    publication_status = 'active',
    review_history = public.shared_learning_knowledge.review_history || EXCLUDED.review_history;

  -- Mark case approved if present
  IF v_queue.case_id IS NOT NULL THEN
    UPDATE public.diagnostic_cases
    SET approved_for_learning = true, privacy_reviewed_at = now()
    WHERE id = v_queue.case_id;
  END IF;

  -- Mark queue item approved
  UPDATE public.learning_review_queue
  SET status = 'approved', reviewed_by = p_reviewed_by, reviewed_at = now()
  WHERE id = p_queue_id;

  -- Insert audit trail record
  INSERT INTO public.learning_review_audit (
    queue_id,
    case_id,
    actor_user_id,
    action,
    note_redacted
  ) VALUES (
    p_queue_id,
    v_queue.case_id,
    p_reviewed_by,
    'approved',
    p_review_note
  );

  RETURN jsonb_build_object(
    'ok', true,
    'queue_id', p_queue_id,
    'case_id', v_queue.case_id,
    'source_kind', v_queue.source_kind,
    'source_manual_id', v_manual_id,
    'equipment_category', v_equipment_category,
    'manufacturer_normalized', v_manufacturer_normalized,
    'model_normalized', v_model_normalized,
    'knowledge_type', v_knowledge_type,
    'technician_verified', v_technician_verified,
    'status', 'approved'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_approve_learning_case(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_approve_learning_case(uuid, text, uuid, text) TO service_role;

-- 5. Replace search_shared_learning:
--    - Enforces read-side verification, manual-level consent, and active case consent
--    - Restricts actionable procedure retrieval to verified repairs and eligible manufacturer manuals
--    - Excludes observed_diagnosis and unconfirmed_suggestion
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
  source_kind text,
  knowledge_type text,
  technician_verified boolean,
  publication_status text,
  rank real
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
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
    ts_rank(
      to_tsvector('english', coalesce(k.equipment_category, '') || ' ' || coalesce(k.manufacturer_normalized, '') || ' ' || coalesce(k.model_normalized, '') || ' ' || k.lesson_redacted),
      websearch_to_tsquery('english', coalesce(left(p_query, 1800), ''))
    ) AS rank
  FROM public.shared_learning_knowledge k
  LEFT JOIN public.companies c ON c.id = k.source_company_id
  LEFT JOIN public.diagnostic_cases dc ON dc.id = k.source_case_id
  LEFT JOIN public.company_manuals cm ON cm.id = k.source_manual_id
  WHERE
    to_tsvector('english', coalesce(k.equipment_category, '') || ' ' || coalesce(k.manufacturer_normalized, '') || ' ' || coalesce(k.model_normalized, '') || ' ' || k.lesson_redacted)
      @@ websearch_to_tsquery('english', coalesce(left(p_query, 1800), ''))
    -- Must be actively published (not revoked or quarantined)
    AND COALESCE(k.publication_status, 'active') = 'active'
    -- Actionable repair procedure retrieval is strictly restricted to verified repairs and manufacturer manuals
    AND k.knowledge_type IN ('verified_repair', 'manufacturer_manual')
    AND COALESCE(k.knowledge_type, 'observed_diagnosis') <> 'observed_diagnosis'
    AND COALESCE(k.knowledge_type, 'observed_diagnosis') <> 'unconfirmed_suggestion'
    -- Authenticated troubleshooter entries strictly require technician verification
    AND (k.source_kind <> 'authenticated_troubleshooter' OR COALESCE(k.technician_verified, false) = true)
    -- Company-backed knowledge strictly requires that the source company remains active and opted in
    AND (k.source_company_id IS NULL OR (c.status IN ('active', 'pilot') AND COALESCE(c.diagnostic_learning_opt_in, false) = true))
    -- Per-document company manual consent check: if manual consent is revoked or manual is disabled, exclude immediately
    AND (k.source_kind <> 'company_manual' OR (cm.id IS NOT NULL AND COALESCE(cm.shared_learning_opt_in, false) = true AND COALESCE(cm.reference_enabled, true) = true AND cm.extraction_status = 'ready'))
    -- Case-backed knowledge strictly requires active case-level learning consent and active durable consent record
    AND (k.source_case_id IS NULL OR (
      COALESCE(dc.case_learning_opt_in, false) = true
      AND EXISTS (
        SELECT 1 FROM public.case_learning_consents clc
        WHERE clc.case_id = k.source_case_id AND clc.consent_status = 'granted'
      )
    ))
  ORDER BY rank DESC
  LIMIT least(greatest(coalesce(p_limit, 4), 1), 8);
$$;

REVOKE ALL ON FUNCTION public.search_shared_learning(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_shared_learning(text, integer) TO service_role;

-- 6. Safe Historical Re-Review & Revocation Hygiene:
-- Revoke retrieval eligibility for any historical unverified authenticated_troubleshooter entries
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

-- Reject any pending review queue items for unverified AI suggestions
UPDATE public.learning_review_queue
SET
  status = 'rejected',
  reviewed_at = now()
WHERE
  source_kind = 'authenticated_troubleshooter'
  AND status = 'pending';

COMMIT;
