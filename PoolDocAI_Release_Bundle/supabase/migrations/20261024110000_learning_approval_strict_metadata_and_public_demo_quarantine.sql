-- Migration 039: Strict metadata preservation for company manuals and public demo quarantine in learning approval
-- Forward-only and additive.
-- Enforces:
-- 1) Public demo visitor-reported cases cannot be published as verified shared repair knowledge (P0-3).
-- 2) Company manual approvals load validated tenant-matching company_manuals provenance into v_manual and populate equipment_category, manufacturer_normalized, and model_normalized directly into shared_learning_knowledge (P0-4).
-- 3) Strict cross-tenant manual opt-in check fails closed.
-- 4) Re-checks governing company diagnostic learning opt-in.
BEGIN;

ALTER TABLE public.company_manuals ADD COLUMN IF NOT EXISTS model_normalized text;

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

  -- P0-3: Public demo visitor-reported answers are unverified customer feedback signals
  -- and cannot be published as verified shared repair knowledge.
  IF v_queue.source_kind = 'public_demo' THEN
    RAISE EXCEPTION 'Public demo visitor-reported answers cannot be published as verified shared repair knowledge';
  END IF;

  -- P0-4: Verify document consent, provenance, and load metadata if manual
  IF v_queue.source_kind = 'company_manual' THEN
    -- Extract manual id from supporting sources
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
    -- Authenticated company case requires explicit case_learning_opt_in, verified contributor terms version, AND governing company opt-in
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
      -- Public demo cases are already rejected above (P0-3), but defense-in-depth check:
      RAISE EXCEPTION 'Public demo visitor-reported answers cannot be published as verified shared repair knowledge';
    END IF;

    -- Enforce verified repair requirement:
    -- Unverified chatbot turns or unverified field notes cannot be published as confirmed fixes
    IF v_queue.source_kind IN ('technician_job', 'authenticated_troubleshooter') THEN
      IF NOT COALESCE(v_case.technician_verified, false) OR COALESCE(trim(v_case.resolution_summary_redacted), '') = '' THEN
        RAISE EXCEPTION 'Only a resolved technician-verified case with a recorded outcome can become shared repair knowledge';
      END IF;
    END IF;

    v_equipment_category := v_case.equipment_category;
    v_manufacturer_normalized := v_case.manufacturer_normalized;
    v_model_normalized := v_case.model_normalized;
  END IF;

  -- Upsert into shared_learning_knowledge atomically with exact metadata provenance
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

COMMIT;
