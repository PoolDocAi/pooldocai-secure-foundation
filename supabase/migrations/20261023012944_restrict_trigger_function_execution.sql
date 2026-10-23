-- Migration 029: prevent direct API invocation of trigger-only SECURITY DEFINER functions.
-- PostgreSQL executes trigger functions as part of their attached triggers; callers do
-- not need direct EXECUTE privilege to fire those triggers.
-- This removes unnecessary RPC entry points without changing trigger behavior.

REVOKE ALL ON FUNCTION public.enforce_company_seat_limit()
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.protect_company_plan_fields()
  FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.pooldocai_audit_initial_document_consent()
  FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.enforce_company_seat_limit() IS
  'Trigger-only function. Direct API execution is intentionally revoked.';
COMMENT ON FUNCTION public.protect_company_plan_fields() IS
  'Trigger-only function. Direct API execution is intentionally revoked.';
COMMENT ON FUNCTION public.pooldocai_audit_initial_document_consent() IS
  'Trigger-only function. Direct API execution is intentionally revoked.';
