-- ============================================================================
-- POOLDOCAI SYNTHETIC DIAGNOSTIC & JOB FIXTURES TEARDOWN
-- Target: Staging Project rzkgmvyyeclrpomrlyft ONLY
-- Cleans up the synthetic positive-control rows created by 03_synthetic_diagnostic_and_job_fixtures.sql
-- ============================================================================

DELETE FROM public.technician_job_records
WHERE id IN (
  '11111111-5000-4111-8111-111111111111',
  '22222222-5000-4222-8222-222222222222'
);

DELETE FROM public.diagnostic_cases
WHERE id IN (
  '11111111-4000-4111-8111-111111111111',
  '22222222-4000-4222-8222-222222222222'
);
