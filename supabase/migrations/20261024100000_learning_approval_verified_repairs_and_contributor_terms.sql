-- Migration 038: Enforce verified repairs and contributor terms in learning approval RPC
-- Forward-only and additive.
-- Enforces that:
-- 1) Cases derived from technician jobs or authenticated troubleshooter chats must have technician_verified = true and non-empty resolution_summary_redacted
-- 2) Tenant cases must have verified terms acceptance (learning_terms_version IS NOT NULL) in addition to case_learning_opt_in = true
BEGIN;

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
  v_company_opted_in boolean := false;
  v_manual_opted_in boolean := false;
  v_manual_id uuid;
  v_has_case_consent boolean := false;
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

  -- Verify document consent if manual
  IF v_queue.source_kind = 'company_manual' THEN
    -- Extract manual id from supporting sources
    SELECT (array_agg(elem))[1]::uuid INTO v_manual_id
    FROM unnest(v_queue.supporting_source_ids) AS elem
    WHERE elem NOT LIKE '%#chunk-%';

    IF v_manual_id IS NOT NULL THEN
      SELECT shared_learning_opt_in INTO v_manual_opted_in
      FROM public.company_manuals
      WHERE id = v_manual_id AND company_id = v_queue.tenant_id;
    END IF;

    IF NOT COALESCE(v_manual_opted_in, false) THEN
      RAISE EXCEPTION 'Source company manual opt-in consent is missing or revoked';
    END IF;
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
    -- 1) Authenticated company case: requires explicit case_learning_opt_in, verified contributor terms version, AND governing company opt-in
    -- 2) Public-demo case (tenant_id IS NULL): requires case_learning_opt_in OR (learning_permission_granted AND legal_terms_version IS NOT NULL)
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
      -- Public-demo case consent check: do not grant consent to unconsented cases
      v_has_case_consent := COALESCE(v_case.case_learning_opt_in, false) OR (
        COALESCE(v_case.learning_permission_granted, false) AND (v_case.legal_terms_version IS NOT NULL OR v_case.learning_terms_version IS NOT NULL)
      );

      IF NOT v_has_case_consent THEN
        RAISE EXCEPTION 'Public demo case-level learning consent was not granted or was withdrawn';
      END IF;
    END IF;

    -- Enforce verified repair requirement:
    -- Unverified chatbot turns or unverified field notes cannot be published as confirmed fixes
    IF v_queue.source_kind IN ('technician_job', 'authenticated_troubleshooter') THEN
      IF NOT COALESCE(v_case.technician_verified, false) OR COALESCE(trim(v_case.resolution_summary_redacted), '') = '' THEN
        RAISE EXCEPTION 'Only a resolved technician-verified case with a recorded outcome can become shared repair knowledge';
      END IF;
    END IF;
  END IF;

  -- Upsert into shared_learning_knowledge atomically
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
    v_case.equipment_category,
    v_case.manufacturer_normalized,
    v_case.model_normalized,
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
    approved_by = EXCLUDED.approved_by,
    consent_snapshot = true,
    review_history = public.shared_learning_knowledge.review_history || EXCLUDED.review_history;

  -- Mark case approved
  IF v_queue.case_id IS NOT NULL THEN
    UPDATE public.diagnostic_cases
    SET approved_for_learning = true, privacy_reviewed_at = now()
    WHERE id = v_queue.case_id;
  END IF;

  -- Mark queue item approved
  UPDATE public.learning_review_queue
  SET status = 'approved', reviewed_by = p_reviewed_by, reviewed_at = now()
  WHERE id = p_queue_id;

  -- Log audit
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

  RETURN jsonb_build_object('ok', true, 'status', 'approved', 'queue_id', p_queue_id);
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_approve_learning_case(uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_approve_learning_case(uuid, text, uuid, text) TO service_role;

COMMIT;
