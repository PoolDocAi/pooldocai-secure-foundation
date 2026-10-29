-- REVIEW CANDIDATE ONLY. Never auto-apply, especially not to Production.
-- Target: PoolDocAI Staging rzkgmvyyeclrpomrlyft after independent approval.
BEGIN;
CREATE OR REPLACE FUNCTION public.pooldocai_check_manual_duplicate(
  p_company_id uuid, p_sha256 text, p_manual_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE (
  is_same_company_duplicate boolean, existing_manual_id uuid,
  has_cross_company_match boolean, cross_company_match_count integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $pooldocai_tenant_guard$
DECLARE
  v_user_id uuid := auth.uid();
  v_same_id uuid := NULL;
BEGIN
  -- A supplied company ID is never proof of tenancy.
  IF v_user_id IS NULL
     OR p_company_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.company_members m
       JOIN public.companies c ON c.id=m.company_id
       WHERE m.user_id=v_user_id AND m.company_id=p_company_id
         AND m.status='active' AND c.status='active'
     ) THEN
    RAISE EXCEPTION 'Tenant manual access denied' USING ERRCODE='42501';
  END IF;
  IF p_sha256 IS NULL OR length(btrim(p_sha256)) < 32 THEN
    RETURN QUERY SELECT false, NULL::uuid, false, 0;
    RETURN;
  END IF;
  SELECT cm.id INTO v_same_id
  FROM public.company_manuals cm
  WHERE cm.company_id=p_company_id
    AND cm.content_sha256=btrim(p_sha256)
    AND (p_manual_id IS NULL OR cm.id<>p_manual_id)
  ORDER BY cm.created_at,cm.id LIMIT 1;
  -- Compatibility shape, no raw cross-company hash/existence/count disclosure.
  RETURN QUERY SELECT (v_same_id IS NOT NULL), v_same_id, false, 0;
END
$pooldocai_tenant_guard$;
REVOKE EXECUTE ON FUNCTION public.pooldocai_check_manual_duplicate(uuid,text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.pooldocai_check_manual_duplicate(uuid,text,uuid) TO authenticated,service_role;
COMMIT;
