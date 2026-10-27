-- Optional separate proposal. Requires reviewed analytics-v1 AND navigation-v1.
-- NOT needed for protected Preview's nonpersistent validator; no remote execution.
BEGIN;
DO $$ BEGIN IF to_regprocedure('resources_cms.analytics_collect(jsonb,boolean,boolean)') IS NULL OR to_regprocedure('resources_cms.navigation_public(text)') IS NULL OR EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid='resources_cms_command_owner'::regrole AND (inherit_option OR set_option)) THEN RAISE EXCEPTION 'Analytics/navigation baseline mismatch'; END IF;END $$;
GRANT resources_cms_command_owner TO postgres WITH ADMIN FALSE,INHERIT FALSE,SET TRUE GRANTED BY postgres;
GRANT CREATE ON SCHEMA resources_cms TO resources_cms_command_owner;
SET LOCAL ROLE resources_cms_command_owner;
CREATE OR REPLACE FUNCTION resources_cms.analytics_collect(p_events jsonb,p_gpc boolean DEFAULT false,p_bot boolean DEFAULT false) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE e jsonb; item jsonb; catalogue jsonb:=resources_cms.verified_public_catalog(); used integer; accepted integer:=0; changed integer; event_id uuid; sid uuid; pid uuid; event_at timestamptz; nav jsonb; folder_key text;
BEGIN
 IF p_gpc OR p_bot THEN RETURN jsonb_build_object('accepted',0,'excluded',true); END IF;
 IF octet_length(p_events::text)>32768 OR jsonb_typeof(p_events)<>'array' OR jsonb_array_length(p_events) NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'Invalid batch'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('resources_analytics.daily_budget',0));
 INSERT INTO resources_analytics.budget VALUES(current_date,0) ON CONFLICT DO NOTHING;
 SELECT count INTO used FROM resources_analytics.budget WHERE day=current_date FOR UPDATE;
 IF used+jsonb_array_length(p_events)>10000 THEN RAISE EXCEPTION 'Daily collection budget reached' USING ERRCODE='P0001'; END IF;
 FOR e IN SELECT value FROM jsonb_array_elements(p_events) LOOP
  IF EXISTS(SELECT 1 FROM jsonb_object_keys(e) k WHERE k NOT IN('event_id','event_name','session_id','sequence_number','page_instance_id','occurred_at','route','surface','element_id','content_id','consent','device','source','payload')) OR coalesce((e->>'consent')::boolean,false) IS NOT TRUE THEN RAISE EXCEPTION 'Unsupported event or missing consent'; END IF;
  IF e->>'event_name'='conversion_complete' OR e->>'event_name' LIKE 'admin_%' OR NOT(e->>'event_name'=ANY(ARRAY['page_view','page_exit','resource_impression','resource_open','resource_engagement','resource_scroll_checkpoint','resource_complete','resource_related_click','nav_section_select','nav_category_select','nav_filter_apply','search_submit','search_results_view','search_zero_results','search_result_click','ui_link_click','ui_button_click','ui_accordion_toggle','ui_tab_select','download_start','download_complete','cta_view','cta_click','widget_open','widget_close','widget_route_select','widget_search_submit','widget_results_view','widget_no_match','widget_result_click','feedback_submit','quality_route_error','quality_client_event_drop','consent_update','form_start','form_submit_attempt','video_start','video_progress','video_complete','discovery_path_impression','discovery_path_select','folder_impression','folder_open','folder_move','folder_article_click','navigation_back','navigation_exit'])) THEN RAISE EXCEPTION 'Unsupported event'; END IF;
  event_id:=(e->>'event_id')::uuid;sid:=(e->>'session_id')::uuid;pid:=(e->>'page_instance_id')::uuid;event_at:=(e->>'occurred_at')::timestamptz;
  IF event_id IS NULL OR sid IS NULL OR pid IS NULL OR event_at IS NULL OR event_at<now()-interval '1 day' OR event_at>now()+interval '5 minutes' OR e->>'surface' NOT IN('website','resources','widget') OR e->>'device' NOT IN('mobile','tablet','desktop','unknown') OR e->>'source' NOT IN('direct','organic','social','referral','email','paid','unknown') OR (e ? 'element_id' AND e->>'element_id' !~ '^[a-z][a-z0-9_.-]{0,79}$') THEN RAISE EXCEPTION 'Invalid event dimensions'; END IF;
  SELECT value INTO item FROM jsonb_array_elements(catalogue) WHERE value->>'id'=e->>'content_id';
  IF nullif(e->>'content_id','') IS NOT NULL AND item IS NULL THEN RAISE EXCEPTION 'Published resource unavailable'; END IF;
  nav:=resources_cms.navigation_public(CASE WHEN e->>'surface'='widget' THEN 'assistant' ELSE 'hub' END);
  FOREACH folder_key IN ARRAY ARRAY['folder_id','previous_folder_id'] LOOP
   IF e->'payload' ? folder_key AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(nav#>'{document,folders}','[]')) f WHERE f->>'id'=e->'payload'->>folder_key) THEN RAISE EXCEPTION 'Published folder identity required'; END IF;
  END LOOP;
  IF e#>>'{payload,path_id}' IS NOT NULL AND e#>>'{payload,path_id}' NOT IN('whats-wrong','equipment-and-guides','explore-resources') THEN RAISE EXCEPTION 'Unknown discovery path'; END IF;
  IF e#>>'{payload,navigation_depth}' IS NOT NULL AND ((e#>>'{payload,navigation_depth}')::numeric NOT BETWEEN 0 AND 8 OR (e#>>'{payload,navigation_depth}')::numeric<>trunc((e#>>'{payload,navigation_depth}')::numeric)) THEN RAISE EXCEPTION 'Invalid navigation depth'; END IF;
  IF e->>'route' NOT IN('/','/resources/') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(catalogue) x WHERE replace(x->>'url','https://pooldocai.com','')=e->>'route') AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(nav#>'{document,folders}','[]')) f WHERE resources_cms.navigation_path(nav->'document',f->>'id')=e->>'route') THEN RAISE EXCEPTION 'Canonical public route required'; END IF;
  IF jsonb_typeof(coalesce(e->'payload','{}'))<>'object' OR EXISTS(SELECT 1 FROM jsonb_each(coalesce(e->'payload','{}')) v WHERE v.key NOT IN('active_seconds','scroll_depth','result_count','rating','intent_id','folder_id','previous_folder_id','path_id','navigation_depth') OR (v.key NOT IN('intent_id','folder_id','previous_folder_id','path_id') AND (jsonb_typeof(v.value)<>'number' OR (v.value::text)::numeric NOT BETWEEN 0 AND 10000))) THEN RAISE EXCEPTION 'Only bounded measurement fields permitted'; END IF;
  IF (e#>>'{payload,active_seconds}')::numeric>30 OR (e#>>'{payload,scroll_depth}')::numeric NOT IN(25,50,75,90) THEN RAISE EXCEPTION 'Invalid engagement checkpoint'; END IF;
  IF e#>>'{payload,intent_id}' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(catalogue) c CROSS JOIN LATERAL jsonb_array_elements(c->'tags') t WHERE t->>'id'=e#>>'{payload,intent_id}') THEN RAISE EXCEPTION 'Published intent required'; END IF;
  IF (SELECT count(*) FROM resources_analytics.events WHERE session_id=sid)>=200 THEN RAISE EXCEPTION 'Session budget reached'; END IF;
  INSERT INTO resources_analytics.events(event_id,session_id,sequence_number,page_instance_id,event_name,occurred_at,route,surface,element_id,content_id,revision_id,device,source,payload,tag_context,category_id)
  VALUES(event_id,sid,(e->>'sequence_number')::int,pid,e->>'event_name',event_at,e->>'route',e->>'surface',e->>'element_id',(item->>'id')::uuid,(item->>'revisionId')::uuid,e->>'device',e->>'source',coalesce(e->'payload','{}'),coalesce(item->'tags','[]'),(item->>'categoryId')::uuid) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS changed=ROW_COUNT;accepted:=accepted+changed;
 END LOOP;
 UPDATE resources_analytics.budget SET count=count+jsonb_array_length(p_events) WHERE day=current_date;
 DELETE FROM resources_analytics.events e WHERE e.event_id IN(SELECT x.event_id FROM resources_analytics.events x WHERE received_at<now()-interval '90 days' LIMIT 500);
 DELETE FROM resources_analytics.budget WHERE day<current_date-2;
 RETURN jsonb_build_object('accepted',accepted,'duplicates',jsonb_array_length(p_events)-accepted);
END $$;
RESET ROLE;
REVOKE CREATE ON SCHEMA resources_cms FROM resources_cms_command_owner;
REVOKE resources_cms_command_owner FROM postgres GRANTED BY postgres RESTRICT;
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_auth_members WHERE roleid='resources_cms_command_owner'::regrole AND (inherit_option OR set_option)) THEN RAISE EXCEPTION 'Temporary privilege remains'; END IF;END $$;
ROLLBACK;
