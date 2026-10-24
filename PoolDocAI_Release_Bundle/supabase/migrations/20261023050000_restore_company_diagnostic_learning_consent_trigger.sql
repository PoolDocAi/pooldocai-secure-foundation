-- Migration 028: restore the company diagnostic-learning consent audit trigger if it drifted.
-- Idempotent forward-only repair: migration 016 already defines the audited consent function.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.diagnostic_learning_consent_audit') IS NULL THEN
    RAISE EXCEPTION 'diagnostic_learning_consent_audit must exist before restoring its trigger';
  END IF;
  IF to_regprocedure('public.pooldocai_audit_diagnostic_learning_consent()') IS NULL THEN
    RAISE EXCEPTION 'pooldocai_audit_diagnostic_learning_consent() must exist before restoring its trigger';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='companies' AND column_name='diagnostic_learning_opt_in'
  ) THEN
    RAISE EXCEPTION 'companies.diagnostic_learning_opt_in must exist before restoring its trigger';
  END IF;
END;
$$;

DROP TRIGGER IF EXISTS companies_diagnostic_learning_consent_audit ON public.companies;
CREATE TRIGGER companies_diagnostic_learning_consent_audit
BEFORE UPDATE OF diagnostic_learning_opt_in ON public.companies
FOR EACH ROW
EXECUTE FUNCTION public.pooldocai_audit_diagnostic_learning_consent();

COMMIT;