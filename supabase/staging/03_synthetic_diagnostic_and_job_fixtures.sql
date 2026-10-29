-- ============================================================================
-- POOLDOCAI SYNTHETIC DIAGNOSTIC & TECHNICIAN JOB FIXTURES
-- Target: Staging Project rzkgmvyyeclrpomrlyft ONLY
-- STRICT NOTICE: ZERO REAL CUSTOMER/BUSINESS PII. ALL DATA SYNTHETIC.
--
-- PURPOSE:
-- Provides positive-control rows for TASK-008 Part-1C live tenant-isolation
-- tests on diagnostic_cases and technician_job_records.
--
-- ELEVATION RATIONALE:
-- diagnostic_cases and technician_job_records have:
--   REVOKE ALL ON public.diagnostic_cases FROM anon, authenticated;
--   GRANT ALL ON public.diagnostic_cases TO service_role;
-- Direct table INSERT is intentionally denied to authenticated tenants by the
-- privacy-minimized learning loop schema (202610210001 / 202610210002).
-- Therefore, synthetic fixtures must be applied via service_role or Dashboard SQL Editor.
-- ============================================================================

-- 1. Synthetic Diagnostic Cases (public.diagnostic_cases)
-- Tenancy column: tenant_id (UUID)
INSERT INTO public.diagnostic_cases (
  id,
  tenant_id,
  case_status,
  equipment_category,
  manufacturer_normalized,
  model_normalized,
  symptom_redacted,
  source_ids,
  created_at,
  technician_verified,
  approved_for_learning
) VALUES
  (
    '11111111-4000-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111',
    'open',
    'pump',
    'pentair',
    'superflo vst',
    'Pump display illuminated but motor will not start (Synthetic)',
    '{}',
    now(),
    false,
    false
  ),
  (
    '22222222-4000-4222-8222-222222222222',
    '22222222-2222-4222-8222-222222222222',
    'open',
    'sanitizer',
    'hayward',
    'aquarite',
    'Low salt output message on display (Synthetic)',
    '{}',
    now(),
    false,
    false
  )
ON CONFLICT (id) DO UPDATE SET
  symptom_redacted = EXCLUDED.symptom_redacted,
  case_status = EXCLUDED.case_status;

-- 2. Synthetic Technician Job Records (public.technician_job_records)
-- Tenancy column: tenant_id (UUID)
INSERT INTO public.technician_job_records (
  id,
  tenant_id,
  case_status,
  job_reference_redacted,
  equipment_category,
  manufacturer_normalized,
  model_normalized,
  complaint_redacted,
  diagnostic_notes_redacted,
  repair_steps_redacted,
  resolution_summary_redacted,
  outcome,
  related_case_id,
  voice_transcribed,
  source,
  technician_verified,
  approved_for_learning,
  created_at,
  updated_at
) VALUES
  (
    '11111111-5000-4111-8111-111111111111',
    '11111111-1111-4111-8111-111111111111',
    'open',
    'JOB-AQ-001',
    'pump',
    'pentair',
    'superflo vst',
    'Shaft seal leak observed on pump (Synthetic)',
    'Shaft seal ceramic face inspection (Synthetic)',
    '[]'::jsonb,
    'Pending seal replacement',
    'in_progress',
    '11111111-4000-4111-8111-111111111111',
    false,
    'technician_manual',
    true,
    false,
    now(),
    now()
  ),
  (
    '22222222-5000-4222-8222-222222222222',
    '22222222-2222-4222-8222-222222222222',
    'open',
    'JOB-BW-001',
    'sanitizer',
    'hayward',
    'aquarite',
    'Salt chlorinator cell inspection (Synthetic)',
    'Cell visual inspection for scale buildup (Synthetic)',
    '[]'::jsonb,
    'Pending cell clean with mild acid solution',
    'in_progress',
    '22222222-4000-4222-8222-222222222222',
    false,
    'technician_manual',
    true,
    false,
    now(),
    now()
  )
ON CONFLICT (id) DO UPDATE SET
  complaint_redacted = EXCLUDED.complaint_redacted,
  case_status = EXCLUDED.case_status,
  updated_at = now();
