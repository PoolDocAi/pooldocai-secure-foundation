-- Migration 047: Learning Publication Safety Trust Boundary, Knowledge Typing, and Consent Lifecycle
-- Forward-only and additive.
-- Enforces:
-- 1) Schema extensions on shared_learning_knowledge:
--    - knowledge_type: verified_repair, manufacturer_manual, observed_diagnosis, unconfirmed_suggestion
--    - technician_verified: boolean flag
--    - publication_status: active, revoked, quarantined
-- 2) Strict Server-Side Evidence Gate on pooldocai_approve_learning_case:
--    - Model-generated authenticated_troubleshooter suggestions with technician_verified=false
--      CANNOT be published as verified shared repair knowledge, even if approved by a platform owner.
--    - Technician jobs must have technician_verified=true and non-empty resolution outcome.
--    - Sets exact knowledge_type and publication_status='active'.
-- 3) Strict Read & Search Eligibility on search_shared_learning:
--    - Excludes revoked entries (publication_status = 'revoked')
--    - Excludes unconfirmed suggestions (knowledge_type = 'unconfirmed_suggestion')
--    - Excludes unverified authenticated_troubleshooter records
--    - Excludes records from companies that are inactive or opted out of diagnostic learning
--    - Excludes records from cases whose consent was withdrawn
-- 4) Historical Re-Review & Revocation Hygiene:
--    - Safely revokes historical unverified authenticated_troubleshooter rows from shared retrieval.
--    - Rejects pending review queue items lacking independent technician verification.
--
-- STRICT NOTE: Code-only task. This migration is committed to the repository for review and staging bundle parity.
-- DO NOT EXECUTE on staging or production databases without separate owner authorization.

BEGIN;

-- 1. Extend shared_learning_knowledge schema with knowledge classification, verification status, and publication lifecycle
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

-- 2. Update pooldocai_approve_learning_case with explicit evidence gates independent of reviewer status
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

    -- Consent and verified contributor terms check:
    IF v_case.tenant_id IS NOT NULL THEN
      IF NOT COALESCE(v_case.case_learning_opt_in, false) THEN
        RAISE EXCEPTION 'Case-level learning consent was not granted or was withdrawn';
      END IF;

      IF v_case.learning_terms_version IS NULL AND v_case.legal_terms_version IS NULL THEN
        RAISE EXCEPTION 'Verified contributor terms acceptance is required for case learning approval';
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

    -- P0 Evidence Gate 4: Technician jobs must be technician_verified and have recorded resolution summary
    IF v_queue.source_kind IN ('technician_job', 'authenticated_troubleshooter') THEN
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

  -- Upsert into shared_learning_knowledge atomically with exact metadata provenance and verification status
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
    knowledge_type,
    technician_verified,
    publication_status,
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

-- 3. Replace search_shared_learning to enforce read-side verification and consent eligibility
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
  WHERE
    to_tsvector('english', coalesce(k.equipment_category, '') || ' ' || coalesce(k.manufacturer_normalized, '') || ' ' || coalesce(k.model_normalized, '') || ' ' || k.lesson_redacted)
      @@ websearch_to_tsquery('english', coalesce(left(p_query, 1800), ''))
    -- Must be actively published (not revoked or quarantined)
    AND COALESCE(k.publication_status, 'active') = 'active'
    -- Unconfirmed suggestions are excluded from retrieval eligibility
    AND COALESCE(k.knowledge_type, 'observed_diagnosis') <> 'unconfirmed_suggestion'
    -- Authenticated troubleshooter entries strictly require technician verification
    AND (k.source_kind <> 'authenticated_troubleshooter' OR COALESCE(k.technician_verified, false) = true)
    -- Company-backed knowledge strictly requires that the source company remains active and opted in
    AND (k.source_company_id IS NULL OR (c.status IN ('active', 'pilot') AND COALESCE(c.diagnostic_learning_opt_in, false) = true))
    -- Case-backed knowledge strictly requires active case-level learning consent
    AND (k.source_case_id IS NULL OR COALESCE(dc.case_learning_opt_in, false) = true)
  ORDER BY rank DESC
  LIMIT least(greatest(coalesce(p_limit, 4), 1), 8);
$$;

REVOKE ALL ON FUNCTION public.search_shared_learning(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_shared_learning(text, integer) TO service_role;

-- 4. Safe Historical Re-Review & Revocation Hygiene:
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
