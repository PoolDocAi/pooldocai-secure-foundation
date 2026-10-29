-- Migration 031: Case-level learning consent, applicable terms version, dual-opt-in enforcement, and automatic withdrawal revocation.
-- Forward-only and additive. Preserves all existing private diagnostic records, company permissions, and migrations 001-030.
BEGIN;

-- 1. Add case-level learning permission and terms version columns to diagnostic_cases
ALTER TABLE public.diagnostic_cases
  ADD COLUMN IF NOT EXISTS case_learning_opt_in boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS learning_terms_version text,
  ADD COLUMN IF NOT EXISTS case_learning_consent_updated_at timestamptz;

-- 2. Create index for fast lookups of consent-eligible cases
CREATE INDEX IF NOT EXISTS diagnostic_cases_learning_consent_idx
  ON public.diagnostic_cases(tenant_id, case_learning_opt_in, approved_for_learning);

-- 3. Case consent audit and automatic shared-learning withdrawal trigger
CREATE OR REPLACE FUNCTION public.pooldocai_audit_case_learning_consent()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.case_learning_opt_in IS DISTINCT FROM OLD.case_learning_opt_in THEN
    NEW.case_learning_consent_updated_at := now();
    IF OLD.case_learning_opt_in AND NOT NEW.case_learning_opt_in THEN
      -- Case-level consent withdrawal immediately removes any shared lesson derived from this case
      INSERT INTO public.learning_review_audit(queue_id, case_id, actor_user_id, action, note_redacted)
      SELECT q.id, NEW.id, auth.uid(), 'consent_withdrawn', 'Case-level diagnostic shared-learning consent withdrawn; shared publication revoked.'
      FROM public.learning_review_queue q
      WHERE q.case_id = NEW.id AND q.status IN ('pending', 'approved');

      UPDATE public.learning_review_queue
      SET status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now()
      WHERE case_id = NEW.id AND status = 'pending';

      NEW.approved_for_learning := false;
      NEW.privacy_reviewed_at := null;

      DELETE FROM public.shared_learning_knowledge
      WHERE source_case_id = NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_audit_case_learning_consent() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS diagnostic_cases_learning_consent_audit ON public.diagnostic_cases;
CREATE TRIGGER diagnostic_cases_learning_consent_audit
BEFORE UPDATE OF case_learning_opt_in ON public.diagnostic_cases
FOR EACH ROW EXECUTE FUNCTION public.pooldocai_audit_case_learning_consent();

-- 4. Transaction-safe atomic approval function for learning cases
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

    -- Recheck explicit case-level consent
    IF NOT COALESCE(v_case.case_learning_opt_in, false) THEN
      RAISE EXCEPTION 'Case-level learning consent was not granted or was withdrawn';
    END IF;

    -- Recheck governing company consent
    IF v_queue.tenant_id IS NOT NULL THEN
      SELECT diagnostic_learning_opt_in INTO v_company_opted_in
      FROM public.companies
      WHERE id = v_queue.tenant_id;

      IF NOT COALESCE(v_company_opted_in, false) THEN
        RAISE EXCEPTION 'Governing company diagnostic learning opt-in is required';
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

COMMENT ON FUNCTION public.pooldocai_approve_learning_case(uuid, text, uuid, text)
IS 'Atomically verifies company and case-level consent, publishes approved lesson to shared RAG, updates case and queue status, and logs audit.';

COMMIT;
