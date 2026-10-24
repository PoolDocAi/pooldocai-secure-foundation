-- Migration 027: explicitly release short-lived grounding budget reservations after provider completion.
-- Additive, idempotent, and restricted to trusted server execution.
BEGIN;

CREATE OR REPLACE FUNCTION public.pooldocai_finish_grounding_budget(p_reservation_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=public,pg_temp
AS $$
DECLARE
  affected integer;
BEGIN
  IF p_reservation_id IS NULL THEN
    RETURN false;
  END IF;

  DELETE FROM public.pooldocai_grounding_budget_reservations
  WHERE id = p_reservation_id;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.pooldocai_finish_grounding_budget(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pooldocai_finish_grounding_budget(uuid) TO service_role;
COMMENT ON FUNCTION public.pooldocai_finish_grounding_budget(uuid) IS
  'Releases a grounding budget reservation immediately after a completed or failed Search-enabled request.';

COMMIT;