-- Migration 020: allow authenticated troubleshooter escalations to be recorded in the tenant service queue.
-- Idempotent and limited to the source-type constraint; existing service requests are preserved.
BEGIN;
ALTER TABLE public.service_requests DROP CONSTRAINT IF EXISTS service_requests_source_type_check;
ALTER TABLE public.service_requests ADD CONSTRAINT service_requests_source_type_check
  CHECK (source_type IN ('admin','customer_widget','authenticated_troubleshooter'));
COMMIT;
