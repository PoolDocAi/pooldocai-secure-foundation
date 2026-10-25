// TASK-005 PART 3: Critical AI Grounding, Learning Safety, and Consent E2E Test Suite
// Covers:
// 1. Schema-conforming Gemini responses and complete handler execution.
// 2. Correctly grounded and unsupported manufacturer repair steps.
// 3. Wrong-model, wrong-page, wrong-revision, and fabricated citations.
// 4. Tenant A versus Tenant B knowledge isolation.
// 5. Learning consent granted, denied, withdrawn, and forged.
// 6. Technician-verified versus AI-generated repair outcomes.
// 7. Homeowner safety and technician diagnostic continuation.
//
// Run: node website/tests/task005-part3-grounding-and-consent.test.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const handlerPath = path.join(root, "supabase/functions/clever-handler/index.ts");
const rawSource = fs.readFileSync(handlerPath, "utf8").replace(/\r\n/g, "\n");

// Replace the npm import with local bridge before running
const patchedSource = rawSource.replace(
  'import { createClient } from "npm:@supabase/supabase-js@2";',
  'const createClient = globalThis.__createMockSupabaseClient;'
);

fs.mkdirSync(path.join(root, "scratch"), { recursive: true });
const runnerTsPath = path.join(root, "scratch/task005_part3_runner.ts");

const runnerScript = `
import assert from "node:assert/strict";

let capturedHandler: ((req: Request) => Promise<Response>) | null = null;
const geminiCalls: Array<{ url: string; body: any }> = [];
const mockGeminiResponses: Array<(body: any) => any> = [];

// In-memory multi-tenant store
const store = {
  companies: new Map([
    ["comp_tenant_a", { id: "comp_tenant_a", name: "Alpha Pool Care", status: "active", plan_name: "pro_tech", diagnostic_learning_opt_in: true, active_industry: "pool" }],
    ["comp_tenant_b", { id: "comp_tenant_b", name: "Beta Pool Services", status: "active", plan_name: "fleet_tech", diagnostic_learning_opt_in: true, active_industry: "pool" }],
    ["comp_opted_out", { id: "comp_opted_out", name: "Private Pool Pros", status: "active", plan_name: "pro_tech", diagnostic_learning_opt_in: false, active_industry: "pool" }]
  ]),
  company_members: new Map([
    ["usr_tech_a", { user_id: "usr_tech_a", company_id: "comp_tenant_a", role: "technician", status: "active", companies: { status: "active", seat_limit: 10, industry_key: "pool" }, can_edit_job_notes: true }],
    ["usr_tech_b", { user_id: "usr_tech_b", company_id: "comp_tenant_b", role: "technician", status: "active", companies: { status: "active", seat_limit: 10, industry_key: "pool" }, can_edit_job_notes: true }],
    ["usr_consented_tech", { user_id: "usr_consented_tech", company_id: "comp_tenant_a", role: "technician", status: "active", companies: { status: "active", seat_limit: 10, industry_key: "pool" }, can_edit_job_notes: true }],
    ["usr_unaccepted_tech", { user_id: "usr_unaccepted_tech", company_id: "comp_tenant_a", role: "technician", status: "active", companies: { status: "active", seat_limit: 10, industry_key: "pool" }, can_edit_job_notes: true }],
    ["usr_platform_admin", { user_id: "usr_platform_admin", company_id: "comp_tenant_a", role: "company_admin", status: "active", companies: { status: "active", seat_limit: 10, industry_key: "pool" }, can_edit_job_notes: true }]
  ]),
  platform_admins: new Set(["usr_platform_admin"]),
  pooldocai_legal_acceptances: new Map([
    ["usr_tech_a:comp_tenant_a", { user_id: "usr_tech_a", company_id: "comp_tenant_a", terms_version: "2026-10-21-v1", privacy_version: "2026-10-21-v1", accepted_at: "2026-10-21T00:00:00Z" }],
    ["usr_consented_tech:comp_tenant_a", { user_id: "usr_consented_tech", company_id: "comp_tenant_a", terms_version: "2026-10-21-v1", privacy_version: "2026-10-21-v1", accepted_at: "2026-10-21T00:00:00Z" }],
    ["usr_consented_tech:comp_opted_out", { user_id: "usr_consented_tech", company_id: "comp_opted_out", terms_version: "2026-10-21-v1", privacy_version: "2026-10-21-v1", accepted_at: "2026-10-21T00:00:00Z" }]
  ]),
  company_manuals: [
    {
      id: "man_pentair_a",
      company_id: "comp_tenant_a",
      title: "Pentair SuperFlo VST Installation & User's Guide",
      active: true,
      reference_enabled: true,
      shared_learning_opt_in: true,
      equipment_category: "pump",
      manufacturer_normalized: "pentair",
      model_normalized: "superflo_vst"
    }
  ],
  company_manual_chunks: [
    {
      id: "chunk_pentair_a_1",
      manual_id: "man_pentair_a",
      company_id: "comp_tenant_a",
      title: "Pentair SuperFlo VST Troubleshooting",
      page_number: 14,
      page_start: 14,
      page_end: 16,
      revision: "Rev P",
      active: true,
      reference_enabled: true,
      status: "ready",
      brand: "Pentair",
      model_family: "SuperFlo VST",
      category: "pump",
      symptom: "Pump will not start, display is dead",
      content_text: "Pentair SuperFlo VST Power and Drive Display Troubleshooting: If the pump drive display is completely dark and the motor will not run, inspect drive electronics and AC line voltage input to verify 230VAC power supply. Check the main circuit breaker. Ensure wiring connections to L1 and L2 terminals are tight. If 230V is present but keypad does not illuminate, replace drive control assembly. Do not open drive enclosure without isolating power at circuit breaker."
    },
    {
      id: "chunk_pentair_cross_1",
      manual_id: "man_pentair_a",
      company_id: "comp_tenant_a",
      title: "Pentair SuperFlo VST Pump Start Electrical Diagnostics",
      page_number: 14,
      page_start: 14,
      page_end: 16,
      revision: "Rev P",
      active: true,
      reference_enabled: true,
      status: "ready",
      brand: "Pentair",
      model_family: "SuperFlo VST",
      category: "pump",
      symptom: "Pump will not start, display is dead",
      content_text: "Pentair SuperFlo VST Pump Will Not Start Troubleshooting: Replace the fuse and inspect breaker while checking supply voltage and recording safe electrical observations."
    },
    {
      id: "chunk_pentair_cross_2",
      manual_id: "man_pentair_a",
      company_id: "comp_tenant_a",
      title: "Pentair SuperFlo VST Pump Start Mechanical Diagnostics",
      page_number: 14,
      page_start: 14,
      page_end: 16,
      revision: "Rev P",
      active: true,
      reference_enabled: true,
      status: "ready",
      brand: "Pentair",
      model_family: "SuperFlo VST",
      category: "pump",
      symptom: "Pump will not start, display is dead",
      content_text: "Pentair SuperFlo VST Pump Will Not Start Troubleshooting: Remove capacitor and inspect impeller while ensuring motor shaft does not rotate and observing safe procedures."
    },
    {
      id: "chunk_pentair_cross_3",
      manual_id: "man_pentair_a",
      company_id: "comp_tenant_a",
      title: "Pentair SuperFlo VST Pump Start Terminal Wiring",
      page_number: 14,
      page_start: 14,
      page_end: 16,
      revision: "Rev P",
      active: true,
      reference_enabled: true,
      status: "ready",
      brand: "Pentair",
      model_family: "SuperFlo VST",
      category: "pump",
      symptom: "Pump will not start, display is dead",
      content_text: "Pentair SuperFlo VST Pump Will Not Start Troubleshooting: Rewire terminal A and inspect terminal B to ensure all wire strands are seated firmly under screw terminals."
    },
    {
      id: "chunk_pentair_conj_pos_1",
      manual_id: "man_pentair_a",
      company_id: "comp_tenant_a",
      title: "Pentair SuperFlo VST Conjoined Component Replacement",
      page_number: 14,
      page_start: 14,
      page_end: 16,
      revision: "Rev P",
      active: true,
      reference_enabled: true,
      status: "ready",
      brand: "Pentair",
      model_family: "SuperFlo VST",
      category: "pump",
      symptom: "Pump will not start, display is dead",
      content_text: "Pentair SuperFlo VST Pump Will Not Start Troubleshooting: Replace fuse and breaker after checking line voltage and recording electrical measurements."
    },
    {
      id: "chunk_pentair_conj_pos_2",
      manual_id: "man_pentair_a",
      company_id: "comp_tenant_a",
      title: "Pentair SuperFlo VST Dual Replacement with Determiners",
      page_number: 14,
      page_start: 14,
      page_end: 16,
      revision: "Rev P",
      active: true,
      reference_enabled: true,
      status: "ready",
      brand: "Pentair",
      model_family: "SuperFlo VST",
      category: "pump",
      symptom: "Pump will not start, display is dead",
      content_text: "Pentair SuperFlo VST Pump Will Not Start Troubleshooting: Replace the fuse and the breaker after checking line voltage and verifying 0VAC."
    },
    {
      id: "chunk_pentair_conj_pos_3",
      manual_id: "man_pentair_a",
      company_id: "comp_tenant_a",
      title: "Pentair SuperFlo VST Repeated Action Replacement",
      page_number: 14,
      page_start: 14,
      page_end: 16,
      revision: "Rev P",
      active: true,
      reference_enabled: true,
      status: "ready",
      brand: "Pentair",
      model_family: "SuperFlo VST",
      category: "pump",
      symptom: "Pump will not start, display is dead",
      content_text: "Pentair SuperFlo VST Pump Will Not Start Troubleshooting: Replace the fuse and replace the breaker after checking line voltage and turning off circuit breaker."
    },
    {
      id: "chunk_pentair_conj_pass_1",
      manual_id: "man_pentair_a",
      company_id: "comp_tenant_a",
      title: "Pentair SuperFlo VST Passive Conjoined Replacement",
      page_number: 14,
      page_start: 14,
      page_end: 16,
      revision: "Rev P",
      active: true,
      reference_enabled: true,
      status: "ready",
      brand: "Pentair",
      model_family: "SuperFlo VST",
      category: "pump",
      symptom: "Pump will not start, display is dead",
      content_text: "Pentair SuperFlo VST Pump Will Not Start Troubleshooting: The fuse and breaker must be replaced if electrical line voltage fault persists."
    },
    {
      id: "chunk_pentair_conj_neg_1",
      manual_id: "man_pentair_a",
      company_id: "comp_tenant_a",
      title: "Pentair SuperFlo VST Negated Conjoined Replacement",
      page_number: 14,
      page_start: 14,
      page_end: 16,
      revision: "Rev P",
      active: true,
      reference_enabled: true,
      status: "ready",
      brand: "Pentair",
      model_family: "SuperFlo VST",
      category: "pump",
      symptom: "Pump will not start, display is dead",
      content_text: "Pentair SuperFlo VST Pump Will Not Start Troubleshooting: Do not replace the fuse and breaker without checking line voltage and isolating main power."
    }
  ],
  diagnostic_cases: new Map(),
  diagnostic_case_steps: [],
  technician_job_records: new Map(),
  learning_review_queue: new Map(),
  shared_learning_knowledge: new Map(),
  learning_review_audit: []
};

// Shim global fetch for Gemini API
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const urlStr = String(input);
  if (urlStr.includes("generativelanguage.googleapis.com")) {
    if (urlStr.includes("embedContent")) {
      return new Response(JSON.stringify({
        embedding: { values: new Array(768).fill(0.01) }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const reqBody = init?.body ? JSON.parse(String(init.body)) : {};
    geminiCalls.push({ url: urlStr, body: reqBody });
    const responder = mockGeminiResponses.shift();
    if (responder) {
      const responsePayload = responder(reqBody);
      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return new Response(JSON.stringify({
      output_text: JSON.stringify({ response_type: "clarify", message: "Can you provide more details?" })
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return originalFetch(input, init);
};

// Shim Deno global
(globalThis as any).Deno = {
  env: {
    get: (key: string) => {
      if (key === "SUPABASE_URL") return "https://mock-proj.supabase.co";
      if (key === "SUPABASE_SERVICE_ROLE_KEY") return "mock-service-role-key";
      if (key === "GEMINI_API_KEY" || key === "GOOGLE_API_KEY") return "mock-gemini-key";
      return null;
    }
  },
  serve: (handler: (req: Request) => Promise<Response>) => {
    capturedHandler = handler;
  }
};

// Shim Supabase Client Builder
(globalThis as any).__createMockSupabaseClient = (url: string, key: string) => {
  return {
    auth: {
      getUser: async (token: string) => {
        if (token === "tech_token_a") return { data: { user: { id: "usr_tech_a", email: "tech_a@alphapool.com" } }, error: null };
        if (token === "tech_token_b") return { data: { user: { id: "usr_tech_b", email: "tech_b@betapool.com" } }, error: null };
        if (token === "consented_tech_token") return { data: { user: { id: "usr_consented_tech", email: "consented@alphapool.com" } }, error: null };
        if (token === "unaccepted_tech_token") return { data: { user: { id: "usr_unaccepted_tech", email: "unaccepted@alphapool.com" } }, error: null };
        if (token === "platform_admin_token") return { data: { user: { id: "usr_platform_admin", email: "admin@pooldocai.com" } }, error: null };
        return { data: { user: null }, error: { message: "Invalid token" } };
      }
    },
    rpc: async (func: string, params: any) => {
      if (func === "pooldocai_consume_company_monthly_session") {
        return { data: { allowed: true, used: 1, allowance: 50, remaining: 49 }, error: null };
      }
      if (func === "pooldocai_reserve_grounding_budget") {
        return { data: "12345678-1234-1234-1234-123456789012", error: null };
      }
      if (func === "pooldocai_finish_grounding_budget") {
        return { data: null, error: null };
      }
      if (func === "pooldocai_check_rate_limit") {
        return { data: { allowed: true }, error: null };
      }
      if (func === "pooldocai_consume_public_demo_turn") {
        return { data: { allowed: true }, error: null };
      }
      if (func === "search_company_manual_chunks_hybrid" || func === "search_company_manual_chunks") {
        if (params.p_company_id === "comp_tenant_a") {
          return {
            data: store.company_manual_chunks.filter(c => c.company_id === "comp_tenant_a").map(c => ({
              id: c.id,
              manual_id: c.manual_id,
              title: c.title,
              page_number: c.page_number,
              page_start: c.page_start,
              page_end: c.page_end,
              revision: c.revision,
              rank: 0.95,
              retrieval_method: "hybrid",
              industry_key: "pool",
              equipment_category: c.category,
              manufacturer_normalized: c.brand,
              model_normalized: c.model_family,
              reference_enabled: c.reference_enabled,
              extraction_status: c.status,
              content_text: c.content_text
            })),
            error: null
          };
        }
        // Tenant B has NO access to Tenant A's private manual
        return { data: [], error: null };
      }
      if (func === "search_shared_learning") {
        const rows = [...store.shared_learning_knowledge.values()].map(s => ({
          id: s.id,
          equipment_category: s.equipment_category,
          manufacturer_normalized: s.manufacturer_normalized,
          model_normalized: s.model_normalized,
          lesson_redacted: s.lesson_redacted,
          source_kind: s.source_kind,
          rank: 0.88
        }));
        return { data: rows, error: null };
      }
      if (func === "pooldocai_approve_learning_case") {
        const qItem = store.learning_review_queue.get(params.p_queue_id);
        if (!qItem) return { error: { message: "Review queue item not found" } };
        const caseRow = store.diagnostic_cases.get(qItem.case_id);
        if (!caseRow) return { error: { message: "Diagnostic case not found" } };

        // Atomic check: unverified chatbot turns prohibited
        if (qItem.source_kind === "authenticated_troubleshooter" && !caseRow.technician_verified) {
          return { error: { message: "Only a resolved technician-verified case with a recorded outcome can become shared repair knowledge" } };
        }
        if (qItem.source_kind === "technician_job" && (!caseRow.technician_verified || !caseRow.resolution_summary_redacted)) {
          return { error: { message: "Only a resolved technician-verified case with a recorded outcome can become shared repair knowledge" } };
        }

        // Terms acceptance check
        if (!caseRow.learning_terms_version) {
          return { error: { message: "Verified contributor terms acceptance is required for case learning approval" } };
        }

        // Company opt-in check
        const comp = store.companies.get(caseRow.tenant_id);
        if (!comp || !comp.diagnostic_learning_opt_in) {
          return { error: { message: "Governing company diagnostic learning opt-in is required" } };
        }

        // Publish to shared knowledge
        const pubId = "shared_" + qItem.id;
        store.shared_learning_knowledge.set(pubId, {
          id: pubId,
          source_case_id: qItem.case_id,
          source_queue_id: qItem.id,
          source_kind: qItem.source_kind,
          equipment_category: caseRow.equipment_category,
          manufacturer_normalized: caseRow.manufacturer_normalized,
          model_normalized: caseRow.model_normalized,
          lesson_redacted: params.p_lesson,
          approved_by: params.p_reviewed_by
        });
        qItem.status = "approved";
        return { data: { ok: true, published_id: pubId }, error: null };
      }
      if (func === "pooldocai_publish_company_notification") {
        return { data: "notif_" + Math.random(), error: null };
      }
      return { data: null, error: null };
    },
    from: (table: string) => {
      let currentTable = table;
      let queryFilter: any = {};
      let selectFields = "*";
      let isSingle = false;
      let isMaybeSingle = false;
      let orderClause: any = null;
      let inFilter: { col: string; vals: any[] } | null = null;

      const builder: any = {
        select: (fields = "*") => { selectFields = fields; return builder; },
        eq: (col: string, val: any) => { queryFilter[col] = val; return builder; },
        neq: (col: string, val: any) => { return builder; },
        is: (col: string, val: any) => { return builder; },
        in: (col: string, vals: any[]) => { inFilter = { col, vals }; return builder; },
        lte: (col: string, val: any) => { return builder; },
        gte: (col: string, val: any) => { return builder; },
        lt: (col: string, val: any) => { return builder; },
        gt: (col: string, val: any) => { return builder; },
        or: (expr: string) => { return builder; },
        order: (col: string, opts: any) => { orderClause = { col, ...opts }; return builder; },
        limit: (n: number) => builder,
        single: () => { isSingle = true; return builder; },
        maybeSingle: () => { isMaybeSingle = true; return builder; },
        insert: (data: any) => {
          const rows = Array.isArray(data) ? data : [data];
          const inserted: any[] = [];
          for (const row of rows) {
            const id = row.id || "gen_" + Math.random().toString(36).slice(2, 10);
            const fullRow = { id, ...row, created_at: new Date().toISOString() };
            if (currentTable === "diagnostic_cases") {
              store.diagnostic_cases.set(id, fullRow);
            } else if (currentTable === "diagnostic_case_steps") {
              store.diagnostic_case_steps.push(fullRow);
            } else if (currentTable === "technician_job_records") {
              store.technician_job_records.set(id, fullRow);
            } else if (currentTable === "learning_review_queue") {
              store.learning_review_queue.set(id, fullRow);
            }
            inserted.push(fullRow);
          }
          return {
            select: () => ({
              single: async () => ({ data: inserted[0] || null, error: null }),
              maybeSingle: async () => ({ data: inserted[0] || null, error: null }),
              then: (resolve: any) => resolve({ data: inserted, error: null })
            }),
            single: async () => ({ data: inserted[0] || null, error: null }),
            then: (resolve: any) => resolve({ data: isSingle || !Array.isArray(data) ? inserted[0] : inserted, error: null })
          };
        },
        update: (data: any) => {
          const updateBuilder: any = {
            eq: (col: string, val: any) => {
              queryFilter[col] = val;
              return updateBuilder;
            },
            then: (resolve: any) => {
              if (currentTable === "diagnostic_cases" && queryFilter.id) {
                const existing = store.diagnostic_cases.get(queryFilter.id);
                if (existing) Object.assign(existing, data);
              }
              if (currentTable === "technician_job_records" && queryFilter.id) {
                const existing = store.technician_job_records.get(queryFilter.id);
                if (existing) Object.assign(existing, data);
              }
              if (currentTable === "learning_review_queue" && queryFilter.id) {
                const existing = store.learning_review_queue.get(queryFilter.id);
                if (existing) Object.assign(existing, data);
              }
              resolve({ data: null, error: null });
            }
          };
          return updateBuilder;
        },
        delete: () => {
          const deleteBuilder: any = {
            eq: (col: string, val: any) => {
              queryFilter[col] = val;
              return deleteBuilder;
            },
            then: (resolve: any) => {
              if (currentTable === "shared_learning_knowledge" && queryFilter.source_queue_id) {
                for (const [k, v] of store.shared_learning_knowledge.entries()) {
                  if (v.source_queue_id === queryFilter.source_queue_id) {
                    store.shared_learning_knowledge.delete(k);
                  }
                }
              }
              resolve({ data: null, error: null });
            }
          };
          return deleteBuilder;
        },
        then: (resolve: any) => {
          let results: any[] = [];
          if (currentTable === "companies") {
            const c = queryFilter.id ? store.companies.get(queryFilter.id) : null;
            results = c ? [c] : [];
          } else if (currentTable === "company_members") {
            const m = queryFilter.user_id ? store.company_members.get(queryFilter.user_id) : null;
            results = m ? [m] : [];
          } else if (currentTable === "platform_admins") {
            const isAdmin = queryFilter.user_id && store.platform_admins.has(queryFilter.user_id);
            results = isAdmin ? [{ user_id: queryFilter.user_id }] : [];
          } else if (currentTable === "pooldocai_legal_acceptances") {
            const key = \`\${queryFilter.user_id}:\${queryFilter.company_id}\`;
            const row = store.pooldocai_legal_acceptances.get(key);
            results = row ? [row] : [];
          } else if (currentTable === "industry_modules") {
            results = [{ industry_key: "pool", status: "active" }];
          } else if (currentTable === "company_manuals") {
            results = store.company_manuals.filter(m => (!queryFilter.id || m.id === queryFilter.id) && (!queryFilter.company_id || m.company_id === queryFilter.company_id));
          } else if (currentTable === "company_manual_chunks") {
            results = store.company_manual_chunks.filter(c => (!queryFilter.id || c.id === queryFilter.id) && (!queryFilter.company_id || c.company_id === queryFilter.company_id));
          } else if (currentTable === "diagnostic_cases") {
            const c = queryFilter.id ? store.diagnostic_cases.get(queryFilter.id) : null;
            results = c ? [c] : [];
          } else if (currentTable === "learning_review_queue") {
            const q = queryFilter.id ? store.learning_review_queue.get(queryFilter.id) : null;
            results = q ? [q] : [];
          } else if (currentTable === "shared_learning_knowledge") {
            results = [...store.shared_learning_knowledge.values()];
            if (inFilter && inFilter.col === "id") {
              results = results.filter(r => inFilter!.vals.includes(r.id));
            }
          } else if (currentTable === "pooldocai_model_rate_cards") {
            results = [{ provider: "google_gemini", model: "gemini-2.5-flash", active: true, grounding_usd_per_1000_units: 35 }];
          } else if (currentTable === "platform_usage_events") {
            results = [];
          }

          if (isSingle) {
            resolve({ data: results[0] || null, error: results[0] ? null : { message: "Row not found", code: "PGRST116" } });
          } else if (isMaybeSingle) {
            resolve({ data: results[0] || null, error: null });
          } else {
            resolve({ data: results, error: null });
          }
        }
      };
      return builder;
    }
  };
};

// Execute the patched clever-handler code to install capturedHandler
${patchedSource}

async function runTestSuite() {
  console.log("=== POOLDOCAI TASK-005 PART 3 SPECIFICATION TEST SUITE ===");
  assert.ok(capturedHandler, "clever-handler serve() must capture the handler function");

  function makeDiagReq(opts: {
    token?: string;
    sessionId?: string;
    brand?: string;
    model?: string;
    category?: string;
    query: string;
    symptom?: string;
    mode?: string;
    action?: string;
    authenticated?: boolean;
  }) {
    const isAuth = opts.authenticated !== false;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (isAuth) {
      headers["Authorization"] = "Bearer " + (opts.token || "tech_token_a");
    }
    return new Request("https://pooldocai.test/api/clever-handler", {
      method: "POST",
      headers,
      body: JSON.stringify({
        authenticatedApp: isAuth,
        diagnosticSessionId: opts.sessionId || ("session_" + Math.random().toString(36).slice(2, 10)),
        action: opts.action || "diagnostic_query",
        category: opts.category || "pump",
        brand: opts.brand || "Pentair",
        model: opts.model || "SuperFlo VST",
        query: opts.query,
        sessionContext: {
          brand: opts.brand || "Pentair",
          model: opts.model || "SuperFlo VST",
          category: opts.category || "pump",
          symptom: opts.symptom || "Pump will not start, display is dead",
          mode: opts.mode || (isAuth ? "tech" : "homeowner")
        }
      })
    });
  }

  // --------------------------------------------------------------------------
  // TEST 1: Schema-Conforming Gemini Response & Verification (P0 A & D)
  // --------------------------------------------------------------------------
  {
    console.log("\\n--- TEST 1: Conforming Gemini Response & Verification ---");
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;

    // Gemini returns schema-conforming structured output citing internal_manual with valid Evidence ID, page, revision
    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_title: "Inspect Drive Electronics & Voltage",
        step_instructions: "Inspect drive electronics and AC line voltage input to verify 230VAC power supply. Check the main circuit breaker.",
        safety_warning: "Isolate power at the main circuit breaker before touching any terminal connections.",
        follow_up_question: "Is 230VAC present across the L1 and L2 terminals?",
        choices: [
          { label: "Yes, 230VAC is present", prompt: "I checked with a multimeter and 230VAC is confirmed at L1 and L2.", action: "continue" },
          { label: "No voltage measured", prompt: "There is no line voltage at the terminals.", action: "continue" }
        ],
        model_suggestions: ["SuperFlo VST"],
        source_label: "internal_manual",
        source_id: "chunk_pentair_a_1",
        source_title: "Pentair SuperFlo VST Troubleshooting",
        page_number: 14,
        revision: "Rev P",
        requires_technician: false
      })
    }));

    const req = new Request("https://pooldocai.test/api/clever-handler", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer tech_token_a"
      },
      body: JSON.stringify({
        authenticatedApp: true,
        diagnosticSessionId: "session_task005_1",
        action: "diagnostic_query",
        category: "pump",
        brand: "Pentair",
        model: "SuperFlo VST",
        query: "Pentair SuperFlo VST pump won't start, keypad display is completely dark",
        sessionContext: {
          brand: "Pentair",
          model: "SuperFlo VST",
          category: "pump",
          symptom: "Pump will not start, display is dead",
          mode: "tech"
        }
      })
    });

    const res = await capturedHandler!(req);
    if (res.status !== 200) console.log("RES ERROR:", await res.json());
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.sourceMode, "manual", "Grounded manual match must establish sourceMode='manual'");
    assert.equal(json.knowledgeDiagnostics.sourceVerifiedAnswer, true, "Source verified answer must be true");
    assert.equal(json.knowledgeDiagnostics.forcedWebSearchAttempted, false, "Verified manual answer must NOT invoke fallback search");
    assert.equal(json.knowledgeDiagnostics.firstPassInternalOnly, true, "First pass must be internal-only (tools: [])");
    assert.equal(geminiCalls.length, 1, "Exactly one Gemini call should be made when citation is verified");
    assert.deepEqual(geminiCalls[0].body.tools || [], [], "Google Search tool must be suppressed during internal retrieval");
    console.log("PASS: Test 1 - Schema-conforming Gemini response verified without forced web search fallback.");
  }

  // --------------------------------------------------------------------------
  // TEST 2: Correctly Grounded vs Unsupported Repair Steps (P0 B)
  // --------------------------------------------------------------------------
  {
    console.log("\\n--- TEST 2A: Unsupported Repair Step on Matching Source ID ---");
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;

    // First call: Gemini returns correct source_id but invented repair step (shaft seal replacement on an electrical chunk)
    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_title: "Replace Mechanical Shaft Seal",
        step_instructions: "Turn off power and replace the motor shaft seal and wet end o-ring with replacement kit #354545.",
        safety_warning: "Ensure power is off.",
        follow_up_question: "Did replacing the shaft seal fix the issue?",
        choices: [{ label: "Done", prompt: "Done" }],
        model_suggestions: ["SuperFlo VST"],
        source_label: "internal_manual",
        source_id: "chunk_pentair_a_1", // Correct ID, but unsupported repair action!
        source_title: "Pentair SuperFlo VST Troubleshooting",
        page_number: 14,
        revision: "Rev P",
        requires_technician: true
      })
    }));

    // Second call: Fallback search response
    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_title: "Check Line Voltage",
        step_instructions: "Inspect line voltage to drive terminals.",
        safety_warning: "Warning.",
        follow_up_question: "Is voltage present?",
        choices: [{ label: "Yes", prompt: "Yes" }],
        model_suggestions: ["SuperFlo VST"],
        source_label: "manufacturer_web",
        source_id: "",
        source_title: "",
        page_number: "",
        requires_technician: false
      }),
      steps: [{
        type: "google_search_result",
        result: [{ url: "https://pentair.com/superflo-vst/manual", title: "Official SuperFlo VST Manual" }]
      }]
    }));

    const req2a = makeDiagReq({
      sessionId: "session_task005_2a",
      query: "Pentair SuperFlo VST pump won't start, keypad display is completely dark"
    });

    const res = await capturedHandler!(req2a);
    if (res.status !== 200) console.log("RES ERROR:", await res.json());
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.knowledgeDiagnostics.forcedWebSearchAttempted, true, "Invented repair step on electrical chunk MUST trigger fallback search");
    assert.equal(geminiCalls.length, 2, "Second Gemini call with Search tool MUST be made when citation fails substance check");
    console.log("PASS: Test 2A - Unsupported repair step with matching source ID rejected; fallback search triggered.");

    console.log("\\n--- TEST 2B: Chemical Dosing Instruction Absent from Source ---");
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;

    // Prescribing ungrounded chemical dosing on a pump electrical chunk
    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_title: "Add Chlorine Shock",
        step_instructions: "Inspect breaker and add 3 lbs of cal-hypo shock directly into the pump basket.",
        safety_warning: "Wear safety goggles.",
        follow_up_question: "Has chlorine dissolved?",
        choices: [{ label: "Done", prompt: "Done" }],
        model_suggestions: [],
        source_label: "internal_manual",
        source_id: "chunk_pentair_a_1",
        source_title: "Pentair SuperFlo VST Troubleshooting",
        page_number: 14,
        requires_technician: false
      })
    }));

    // Fallback response
    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({ response_type: "step", step_instructions: "Fallback step.", choices: [] }),
      steps: []
    }));

    const req2b = makeDiagReq({
      sessionId: "session_task005_2b",
      query: "Pentair SuperFlo VST pump won't start, keypad display is completely dark"
    });

    const resChem = await capturedHandler!(req2b);
    const jsonChem = await resChem.json();
    assert.equal(jsonChem.knowledgeDiagnostics.forcedWebSearchAttempted, true, "Ungrounded chemical dosing on equipment chunk MUST trigger fallback search");
    console.log("PASS: Test 2B - Ungrounded chemical dosing absent from source rejected; fallback search triggered.");

    console.log("\\n--- TEST 2C: P0 Review Defect - Cross-Object False Positive (Replace Fuse & Inspect Breaker) ---");
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;

    // 2C1: Model prescribes replacing the breaker against a chunk that only authorizes replacing the fuse!
    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_title: "Replace Main Circuit Breaker",
        step_instructions: "Replace the breaker after checking supply voltage.",
        safety_warning: "Ensure main power is disconnected.",
        follow_up_question: "Did replacing the breaker restore power?",
        choices: [{ label: "Done", prompt: "Done" }],
        model_suggestions: [],
        source_label: "internal_manual",
        source_id: "chunk_pentair_cross_1",
        source_title: "Pentair SuperFlo VST Pump Start Electrical Diagnostics",
        page_number: 14,
        revision: "Rev P",
        requires_technician: true
      })
    }));

    // Fallback response
    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({ response_type: "step", step_instructions: "Fallback step.", choices: [] }),
      steps: []
    }));

    const req2c1 = makeDiagReq({
      sessionId: "session_task005_2c1",
      query: "Pentair SuperFlo VST pump won't start, keypad display is completely dark"
    });

    const res2c1 = await capturedHandler!(req2c1);
    const json2c1 = await res2c1.json();
    assert.equal(json2c1.knowledgeDiagnostics.forcedWebSearchAttempted, true, "Unsupported breaker replacement MUST be rejected by clause-level target-verb binding");
    console.log("PASS: Test 2C1 - 'Replace the breaker' strictly rejected against 'Replace fuse and inspect breaker'.");

    // 2C2: Model prescribes replacing the fuse against the same chunk (genuinely supported positive)
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;

    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_title: "Replace Blown Fuse",
        step_instructions: "Replace the fuse after checking supply voltage.",
        safety_warning: "Ensure main power is disconnected.",
        follow_up_question: "Did replacing the fuse restore power?",
        choices: [{ label: "Done", prompt: "Done" }],
        model_suggestions: ["SuperFlo VST"],
        source_label: "internal_manual",
        source_id: "chunk_pentair_cross_1",
        source_title: "Pentair SuperFlo VST Pump Start Electrical Diagnostics",
        page_number: 14,
        revision: "Rev P",
        requires_technician: true
      })
    }));

    const req2c2 = makeDiagReq({
      sessionId: "session_task005_2c2",
      query: "Pentair SuperFlo VST pump won't start, keypad display is completely dark"
    });

    const res2c2 = await capturedHandler!(req2c2);
    const json2c2 = await res2c2.json();
    assert.equal(json2c2.sourceMode, "manual", "Genuinely authorized fuse replacement must verify sourceMode='manual'");
    assert.equal(json2c2.knowledgeDiagnostics.forcedWebSearchAttempted, false, "Genuinely authorized fuse replacement must not trigger fallback");
    console.log("PASS: Test 2C2 - 'Replace the fuse' verified as genuine positive against 'Replace fuse and inspect breaker'.");

    console.log("\\n--- TEST 2D: Cross-Object False Positive (Remove Capacitor & Inspect Impeller) ---");
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;

    // 2D1: Model prescribes removing the impeller against a chunk that only authorizes removing the capacitor!
    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_title: "Remove Impeller",
        step_instructions: "Remove the impeller after inspecting capacitor.",
        safety_warning: "Lock out power.",
        follow_up_question: "Is impeller removed?",
        choices: [{ label: "Done", prompt: "Done" }],
        model_suggestions: [],
        source_label: "internal_manual",
        source_id: "chunk_pentair_cross_2",
        source_title: "Pentair SuperFlo VST Pump Start Mechanical Diagnostics",
        page_number: 14,
        revision: "Rev P",
        requires_technician: true
      })
    }));
    mockGeminiResponses.push(() => ({ output_text: JSON.stringify({ response_type: "step", step_instructions: "Fallback step.", choices: [] }), steps: [] }));

    const req2d1 = makeDiagReq({ sessionId: "session_task005_2d1", query: "Pentair SuperFlo VST won't start" });
    const res2d1 = await capturedHandler!(req2d1);
    const json2d1 = await res2d1.json();
    assert.equal(json2d1.knowledgeDiagnostics.forcedWebSearchAttempted, true, "Unsupported impeller removal MUST be rejected by clause-level target-verb binding");
    console.log("PASS: Test 2D1 - 'Remove the impeller' strictly rejected against 'Remove capacitor and inspect impeller'.");

    // 2D2: Model prescribes removing the capacitor against the same chunk (genuinely supported positive)
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;

    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_title: "Remove Capacitor",
        step_instructions: "Remove the capacitor while ensuring motor shaft does not rotate.",
        safety_warning: "Discharge capacitor safely.",
        follow_up_question: "Is capacitor removed?",
        choices: [{ label: "Done", prompt: "Done" }],
        model_suggestions: ["SuperFlo VST"],
        source_label: "internal_manual",
        source_id: "chunk_pentair_cross_2",
        source_title: "Pentair SuperFlo VST Pump Start Mechanical Diagnostics",
        page_number: 14,
        revision: "Rev P",
        requires_technician: true
      })
    }));

    const req2d2 = makeDiagReq({ sessionId: "session_task005_2d2", query: "Pentair SuperFlo VST won't start" });
    const res2d2 = await capturedHandler!(req2d2);
    const json2d2 = await res2d2.json();
    assert.equal(json2d2.sourceMode, "manual", "Genuinely authorized capacitor removal must verify sourceMode='manual'");
    assert.equal(json2d2.knowledgeDiagnostics.forcedWebSearchAttempted, false, "Genuinely authorized capacitor removal must not trigger fallback");
    console.log("PASS: Test 2D2 - 'Remove the capacitor' verified as genuine positive.");

    console.log("\\n--- TEST 2E: Cross-Object False Positive (Rewire Terminal A & Inspect Terminal B) ---");
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;

    // 2E1: Model prescribes rewiring terminal B against a chunk that only authorizes rewiring terminal A!
    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_title: "Rewire Terminal B",
        step_instructions: "Rewire terminal B after inspecting terminal A.",
        safety_warning: "Turn off breaker.",
        follow_up_question: "Is terminal B rewired?",
        choices: [{ label: "Done", prompt: "Done" }],
        model_suggestions: [],
        source_label: "internal_manual",
        source_id: "chunk_pentair_cross_3",
        source_title: "Pentair SuperFlo VST Pump Start Terminal Wiring",
        page_number: 14,
        revision: "Rev P",
        requires_technician: true
      })
    }));
    mockGeminiResponses.push(() => ({ output_text: JSON.stringify({ response_type: "step", step_instructions: "Fallback step.", choices: [] }), steps: [] }));

    const req2e1 = makeDiagReq({ sessionId: "session_task005_2e1", query: "Pentair SuperFlo VST won't start" });
    const res2e1 = await capturedHandler!(req2e1);
    const json2e1 = await res2e1.json();
    assert.equal(json2e1.knowledgeDiagnostics.forcedWebSearchAttempted, true, "Unauthorized terminal B rewiring MUST be rejected by clause-level binding");
    console.log("PASS: Test 2E1 - 'Rewire terminal B' strictly rejected against 'Rewire terminal A then inspect terminal B'.");

    // 2E2: Model prescribes rewiring terminal A against the same chunk (genuinely supported positive)
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;

    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_title: "Rewire Terminal A",
        step_instructions: "Rewire terminal A then inspect connections.",
        safety_warning: "Turn off breaker.",
        follow_up_question: "Is terminal A rewired?",
        choices: [{ label: "Done", prompt: "Done" }],
        model_suggestions: ["SuperFlo VST"],
        source_label: "internal_manual",
        source_id: "chunk_pentair_cross_3",
        source_title: "Pentair SuperFlo VST Pump Start Terminal Wiring",
        page_number: 14,
        revision: "Rev P",
        requires_technician: true
      })
    }));

    const req2e2 = makeDiagReq({ sessionId: "session_task005_2e2", query: "Pentair SuperFlo VST won't start" });
    const res2e2 = await capturedHandler!(req2e2);
    const json2e2 = await res2e2.json();
    assert.equal(json2e2.sourceMode, "manual", "Genuinely authorized terminal A rewiring must verify sourceMode='manual'");
    assert.equal(json2e2.knowledgeDiagnostics.forcedWebSearchAttempted, false, "Genuinely authorized terminal A rewiring must not trigger fallback");
    console.log("PASS: Test 2E2 - 'Rewire terminal A' verified as genuine positive.");

    console.log("\\n--- TEST 2E3: Prohibited Enclosure Opening ---");
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;

    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_title: "Open Drive Enclosure",
        step_instructions: "Open the drive enclosure to inspect circuit board connections.",
        safety_warning: "Be careful.",
        follow_up_question: "Is board visible?",
        choices: [{ label: "Done", prompt: "Done" }],
        model_suggestions: [],
        source_label: "internal_manual",
        source_id: "chunk_pentair_a_1",
        source_title: "Pentair SuperFlo VST Troubleshooting",
        page_number: 14,
        revision: "Rev P",
        requires_technician: true
      })
    }));
    mockGeminiResponses.push(() => ({ output_text: JSON.stringify({ response_type: "step", step_instructions: "Fallback step.", choices: [] }), steps: [] }));

    const req2e3 = makeDiagReq({ sessionId: "session_task005_2e3", query: "Pentair SuperFlo VST won't start" });
    const res2e3 = await capturedHandler!(req2e3);
    const json2e3 = await res2e3.json();
    assert.equal(json2e3.knowledgeDiagnostics.forcedWebSearchAttempted, true, "Prohibited drive enclosure opening MUST be rejected");
    console.log("PASS: Test 2E3 - Prohibited drive enclosure opening strictly rejected.");

    console.log("\\n--- TEST 2F: Positive Fixture - Genuinely Authorized Component Replacement ---");
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;

    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_title: "Replace Drive Control Assembly",
        step_instructions: "If 230V is confirmed at terminals but display remains dark, replace drive control assembly.",
        safety_warning: "Isolate power at circuit breaker before opening enclosure.",
        follow_up_question: "Did replacing drive control assembly restore keypad?",
        choices: [{ label: "Done", prompt: "Done" }],
        model_suggestions: ["SuperFlo VST"],
        source_label: "internal_manual",
        source_id: "chunk_pentair_a_1",
        source_title: "Pentair SuperFlo VST Troubleshooting",
        page_number: 14,
        revision: "Rev P",
        requires_technician: true
      })
    }));

    const req2f = makeDiagReq({ sessionId: "session_task005_2f", query: "Pentair SuperFlo VST won't start, keypad display is dark" });
    const res2f = await capturedHandler!(req2f);
    assert.equal(res2f.status, 200);
    const json2f = await res2f.json();
    assert.equal(json2f.knowledgeDiagnostics.sourceVerifiedAnswer, true, "Genuinely authorized component replacement MUST verify");
    assert.equal(json2f.knowledgeDiagnostics.forcedWebSearchAttempted, false, "Genuinely authorized replacement MUST NOT trigger web fallback");
    assert.equal(geminiCalls.length, 1, "Exactly one Gemini call should be made when citation is verified");
    console.log("PASS: Test 2F - Genuinely authorized drive control assembly replacement verified without fallback search.");

    console.log("\\n--- TEST 2G1: Conjoined Positive - 'Replace fuse and breaker' ---");
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;

    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_title: "Replace Fuse and Breaker",
        step_instructions: "Replace the breaker after checking line voltage.",
        safety_warning: "Isolate power.",
        follow_up_question: "Is breaker replaced?",
        choices: [{ label: "Done", prompt: "Done" }],
        model_suggestions: ["SuperFlo VST"],
        source_label: "internal_manual",
        source_id: "chunk_pentair_conj_pos_1",
        source_title: "Pentair SuperFlo VST Conjoined Component Replacement",
        page_number: 14,
        revision: "Rev P",
        requires_technician: true
      })
    }));

    const req2g1 = makeDiagReq({ sessionId: "session_task005_2g1", query: "Pentair SuperFlo VST won't start" });
    const res2g1 = await capturedHandler!(req2g1);
    const json2g1 = await res2g1.json();
    assert.equal(json2g1.sourceMode, "manual", "Conjoined 'replace fuse and breaker' must corroborate breaker replacement");
    assert.equal(json2g1.knowledgeDiagnostics.forcedWebSearchAttempted, false);
    console.log("PASS: Test 2G1 - Conjoined 'Replace fuse and breaker' verified for breaker.");

    console.log("\\n--- TEST 2G2: Conjoined Positive with Determiners - 'Replace the fuse and the breaker' ---");
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;

    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_title: "Replace Fuse and Breaker",
        step_instructions: "Replace the breaker after checking line voltage.",
        safety_warning: "Isolate power.",
        follow_up_question: "Is breaker replaced?",
        choices: [{ label: "Done", prompt: "Done" }],
        model_suggestions: ["SuperFlo VST"],
        source_label: "internal_manual",
        source_id: "chunk_pentair_conj_pos_2",
        source_title: "Pentair SuperFlo VST Dual Replacement with Determiners",
        page_number: 14,
        revision: "Rev P",
        requires_technician: true
      })
    }));

    const req2g2 = makeDiagReq({ sessionId: "session_task005_2g2", query: "Pentair SuperFlo VST won't start" });
    const res2g2 = await capturedHandler!(req2g2);
    const json2g2 = await res2g2.json();
    assert.equal(json2g2.sourceMode, "manual", "Conjoined 'replace the fuse and the breaker' must corroborate breaker replacement");
    assert.equal(json2g2.knowledgeDiagnostics.forcedWebSearchAttempted, false);
    console.log("PASS: Test 2G2 - Conjoined 'Replace the fuse and the breaker' verified.");

    console.log("\\n--- TEST 2G3: Conjoined Positive with Repeated Action - 'Replace fuse and replace breaker' ---");
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;

    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_title: "Replace Fuse and Breaker",
        step_instructions: "Replace the breaker after checking line voltage.",
        safety_warning: "Isolate power.",
        follow_up_question: "Is breaker replaced?",
        choices: [{ label: "Done", prompt: "Done" }],
        model_suggestions: ["SuperFlo VST"],
        source_label: "internal_manual",
        source_id: "chunk_pentair_conj_pos_3",
        source_title: "Pentair SuperFlo VST Repeated Action Replacement",
        page_number: 14,
        revision: "Rev P",
        requires_technician: true
      })
    }));

    const req2g3 = makeDiagReq({ sessionId: "session_task005_2g3", query: "Pentair SuperFlo VST won't start" });
    const res2g3 = await capturedHandler!(req2g3);
    const json2g3 = await res2g3.json();
    assert.equal(json2g3.sourceMode, "manual", "Conjoined repeated action 'replace fuse and replace breaker' must corroborate breaker replacement");
    assert.equal(json2g3.knowledgeDiagnostics.forcedWebSearchAttempted, false);
    console.log("PASS: Test 2G3 - Conjoined 'Replace the fuse and replace the breaker' verified.");

    console.log("\\n--- TEST 2G4: Conjoined Passive - 'The fuse and breaker must be replaced' ---");
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;

    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_title: "Replace Breaker",
        step_instructions: "Replace the breaker after checking line voltage.",
        safety_warning: "Isolate power.",
        follow_up_question: "Is breaker replaced?",
        choices: [{ label: "Done", prompt: "Done" }],
        model_suggestions: ["SuperFlo VST"],
        source_label: "internal_manual",
        source_id: "chunk_pentair_conj_pass_1",
        source_title: "Pentair SuperFlo VST Passive Conjoined Replacement",
        page_number: 14,
        revision: "Rev P",
        requires_technician: true
      })
    }));

    const req2g4 = makeDiagReq({ sessionId: "session_task005_2g4", query: "Pentair SuperFlo VST won't start" });
    const res2g4 = await capturedHandler!(req2g4);
    const json2g4 = await res2g4.json();
    assert.equal(json2g4.sourceMode, "manual", "Passive 'the fuse and breaker must be replaced' must corroborate breaker replacement");
    assert.equal(json2g4.knowledgeDiagnostics.forcedWebSearchAttempted, false);
    console.log("PASS: Test 2G4 - Passive 'The fuse and breaker must be replaced' verified.");

    console.log("\\n--- TEST 2G5: Conjoined Negation - 'Do not replace the fuse and breaker' ---");
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;

    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_title: "Replace Breaker",
        step_instructions: "Replace the breaker after checking line voltage.",
        safety_warning: "Isolate power.",
        follow_up_question: "Is breaker replaced?",
        choices: [{ label: "Done", prompt: "Done" }],
        model_suggestions: [],
        source_label: "internal_manual",
        source_id: "chunk_pentair_conj_neg_1",
        source_title: "Pentair SuperFlo VST Negated Conjoined Replacement",
        page_number: 14,
        revision: "Rev P",
        requires_technician: true
      })
    }));
    mockGeminiResponses.push(() => ({ output_text: JSON.stringify({ response_type: "step", step_instructions: "Fallback step.", choices: [] }), steps: [] }));

    const req2g5 = makeDiagReq({ sessionId: "session_task005_2g5", query: "Pentair SuperFlo VST won't start" });
    const res2g5 = await capturedHandler!(req2g5);
    const json2g5 = await res2g5.json();
    assert.equal(json2g5.knowledgeDiagnostics.forcedWebSearchAttempted, true, "Negated conjoined action MUST fail verification");
    console.log("PASS: Test 2G5 - Negated 'Do not replace the fuse and breaker' strictly rejected.");
  }

  // --------------------------------------------------------------------------
  // TEST 3: Wrong-Model, Wrong-Page, Wrong-Revision, and Fabricated Citations
  // --------------------------------------------------------------------------
  {
    console.log("\\n--- TEST 3: Negative Citation Integrity Checks ---");

    // 3A: Wrong Model
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;
    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_instructions: "Inspect drive electronics and AC line voltage input to verify 230VAC power supply.",
        choices: [], model_suggestions: [],
        source_label: "internal_manual",
        source_id: "chunk_pentair_a_1",
        source_title: "Pentair SuperFlo VST Troubleshooting",
        page_number: 14,
        requires_technician: false
      })
    }));
    mockGeminiResponses.push(() => ({ output_text: JSON.stringify({ response_type: "step", step_instructions: "Fallback", choices: [] }), steps: [] }));

    const reqWrongModel = makeDiagReq({
      sessionId: "session_task005_3a",
      brand: "Hayward",
      model: "Super Pump",
      query: "Hayward Super Pump motor won't start",
      symptom: "Pump won't start"
    });
    const resWrongModel = await capturedHandler!(reqWrongModel);
    const jsonWrongModel = await resWrongModel.json();
    assert.equal(jsonWrongModel.knowledgeDiagnostics.forcedWebSearchAttempted, true, "Wrong-model citation must fail verification");
    console.log("PASS: Test 3A - Wrong-model citation rejected.");

    // 3B: Wrong Page
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;
    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_instructions: "Inspect drive electronics and AC line voltage input to verify 230VAC power supply.",
        choices: [], model_suggestions: [],
        source_label: "internal_manual",
        source_id: "chunk_pentair_a_1",
        source_title: "Pentair SuperFlo VST Troubleshooting",
        page_number: 88, // Actual chunk is pp. 14-16!
        requires_technician: false
      })
    }));
    mockGeminiResponses.push(() => ({ output_text: JSON.stringify({ response_type: "step", step_instructions: "Fallback", choices: [] }), steps: [] }));

    const reqWrongPage = makeDiagReq({
      sessionId: "session_task005_3b",
      query: "Pentair SuperFlo VST won't start",
      symptom: "Pump will not start, display is dead"
    });
    const resWrongPage = await capturedHandler!(reqWrongPage);
    const jsonWrongPage = await resWrongPage.json();
    assert.equal(jsonWrongPage.knowledgeDiagnostics.forcedWebSearchAttempted, true, "Wrong-page citation must fail verification");
    console.log("PASS: Test 3B - Wrong-page citation rejected.");

    // 3C: Fabricated Citation ID
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;
    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_instructions: "Inspect drive electronics and AC line voltage input to verify 230VAC power supply.",
        choices: [], model_suggestions: [],
        source_label: "internal_manual",
        source_id: "chunk_fabricated_fake_uuid_999",
        source_title: "Invented Manual Title",
        page_number: 14,
        requires_technician: false
      })
    }));
    mockGeminiResponses.push(() => ({ output_text: JSON.stringify({ response_type: "step", step_instructions: "Fallback", choices: [] }), steps: [] }));

    const reqFabricated = makeDiagReq({
      sessionId: "session_task005_3c",
      query: "Pentair SuperFlo VST won't start",
      symptom: "Pump will not start, display is dead"
    });
    const resFabricated = await capturedHandler!(reqFabricated);
    const jsonFabricated = await resFabricated.json();
    assert.equal(jsonFabricated.knowledgeDiagnostics.forcedWebSearchAttempted, true, "Fabricated citation ID must fail verification");
    console.log("PASS: Test 3C - Fabricated citation ID rejected.");

    // 3D: Wrong Revision
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;
    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_instructions: "Inspect drive electronics and AC line voltage input to verify 230VAC power supply.",
        choices: [], model_suggestions: [],
        source_label: "internal_manual",
        source_id: "chunk_pentair_a_1",
        source_title: "Pentair SuperFlo VST Troubleshooting",
        page_number: 14,
        revision: "Rev B", // Actual chunk is Rev P!
        requires_technician: false
      })
    }));
    mockGeminiResponses.push(() => ({ output_text: JSON.stringify({ response_type: "step", step_instructions: "Fallback", choices: [] }), steps: [] }));

    const reqWrongRev = makeDiagReq({
      sessionId: "session_task005_3d",
      query: "Pentair SuperFlo VST won't start",
      symptom: "Pump will not start, display is dead"
    });
    const resWrongRev = await capturedHandler!(reqWrongRev);
    const jsonWrongRev = await resWrongRev.json();
    assert.equal(jsonWrongRev.knowledgeDiagnostics.forcedWebSearchAttempted, true, "Wrong revision citation must fail verification");
    console.log("PASS: Test 3D - Wrong revision citation rejected.");

    // 3E: Missing Page Number on Cataloged Paginated Chunk
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;
    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_instructions: "Inspect drive electronics and AC line voltage input to verify 230VAC power supply.",
        choices: [], model_suggestions: [],
        source_label: "internal_manual",
        source_id: "chunk_pentair_a_1",
        source_title: "Pentair SuperFlo VST Troubleshooting",
        page_number: "", // Omitted page number on cataloged chunk!
        revision: "Rev P",
        requires_technician: false
      })
    }));
    mockGeminiResponses.push(() => ({ output_text: JSON.stringify({ response_type: "step", step_instructions: "Fallback", choices: [] }), steps: [] }));

    const reqMissingPage = makeDiagReq({
      sessionId: "session_task005_3e",
      query: "Pentair SuperFlo VST won't start",
      symptom: "Pump will not start, display is dead"
    });
    const resMissingPage = await capturedHandler!(reqMissingPage);
    const jsonMissingPage = await resMissingPage.json();
    assert.equal(jsonMissingPage.knowledgeDiagnostics.forcedWebSearchAttempted, true, "Missing page citation on cataloged chunk must fail verification");
    console.log("PASS: Test 3E - Missing page citation on cataloged chunk rejected.");

    // 3F: Corrupted / Non-numeric Page Citation on Cataloged Chunk
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;
    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_instructions: "Inspect drive electronics and AC line voltage input to verify 230VAC power supply.",
        choices: [], model_suggestions: [],
        source_label: "internal_manual",
        source_id: "chunk_pentair_a_1",
        source_title: "Pentair SuperFlo VST Troubleshooting",
        page_number: "page-unknown", // Corrupted / non-numeric page on cataloged chunk!
        revision: "Rev P",
        requires_technician: false
      })
    }));
    mockGeminiResponses.push(() => ({ output_text: JSON.stringify({ response_type: "step", step_instructions: "Fallback", choices: [] }), steps: [] }));

    const reqMissingRev = makeDiagReq({
      sessionId: "session_task005_3f",
      query: "Pentair SuperFlo VST won't start",
      symptom: "Pump will not start, display is dead"
    });
    const resMissingRev = await capturedHandler!(reqMissingRev);
    const jsonMissingRev = await resMissingRev.json();
    assert.equal(jsonMissingRev.knowledgeDiagnostics.forcedWebSearchAttempted, true, "Corrupted page citation on cataloged chunk must fail verification");
    console.log("PASS: Test 3F - Corrupted page citation on cataloged chunk rejected.");
  }

  // --------------------------------------------------------------------------
  // TEST 4: Tenant A versus Tenant B Knowledge Isolation
  // --------------------------------------------------------------------------
  {
    console.log("\\n--- TEST 4: Tenant A vs Tenant B Knowledge Isolation ---");
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;

    // Tenant B queries the same pump issue
    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_instructions: "General inspection from dry location.",
        choices: [], model_suggestions: [],
        source_label: "generic_triage",
        source_id: "",
        source_title: "",
        page_number: "",
        requires_technician: false
      })
    }));

    const reqTenantB = makeDiagReq({
      token: "tech_token_b",
      sessionId: "session_task005_4",
      query: "Pentair SuperFlo VST won't start",
      symptom: "Pump will not start, display is dead"
    });

    const resTenantB = await capturedHandler!(reqTenantB);
    const jsonTenantB = await resTenantB.json();

    assert.equal(jsonTenantB.kbMatches.length, 0, "Tenant B must NOT retrieve Tenant A's private company manual chunks");
    assert.equal(jsonTenantB.knowledgeDiagnostics.matchKeys.length, 0, "Tenant B matchKeys must be empty");
    console.log("PASS: Test 4 - Strict multi-tenant isolation confirmed: Tenant B cannot access Tenant A's private knowledge.");
  }

  // --------------------------------------------------------------------------
  // TEST 5: Learning Consent Lifecycle (Granted, Denied, Withdrawn, Forged)
  // --------------------------------------------------------------------------
  {
    console.log("\\n--- TEST 5: Learning Consent Lifecycle ---");

    // 5A: Learning consent granted with valid server-side terms
    const initialQueueCount = store.learning_review_queue.size;
    const reqSaveJob = new Request("https://pooldocai.test/api/clever-handler", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer consented_tech_token" },
      body: JSON.stringify({
        authenticatedApp: true,
        action: "save_technician_job",
        outcome: "resolved",
        equipmentCategory: "Pump",
        manufacturer: "Pentair",
        model: "SuperFlo VST",
        complaint: "Pump dead, no display",
        resolution: "Replaced blown drive fuse and verified 230VAC input.",
        repairSteps: [{ action: "Tested line voltage", result: "230VAC verified" }, { action: "Replaced drive fuse", result: "Display restored" }],
        caseLearningOptIn: true
      })
    });

    const resSaveJob = await capturedHandler!(reqSaveJob);
    assert.equal(resSaveJob.status, 200);
    assert.equal(store.learning_review_queue.size, initialQueueCount + 1, "Consented job with active terms must enter learning review queue");
    const queuedJob = [...store.learning_review_queue.values()].pop();
    assert.equal(queuedJob?.source_kind, "technician_job");
    console.log("PASS: Test 5A - Consented technician job with valid terms enters review queue.");

    // 5B: Learning consent denied by technician
    const countBeforeDenied = store.learning_review_queue.size;
    const reqDeniedJob = new Request("https://pooldocai.test/api/clever-handler", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer consented_tech_token" },
      body: JSON.stringify({
        authenticatedApp: true,
        action: "save_technician_job",
        outcome: "resolved",
        equipmentCategory: "Pump",
        manufacturer: "Pentair",
        model: "SuperFlo VST",
        complaint: "Pump humming",
        resolution: "Freed stuck impeller.",
        repairSteps: [{ action: "Cleaned basket", result: "Running" }],
        caseLearningOptIn: false // Explicit opt-out
      })
    });
    const resDeniedJob = await capturedHandler!(reqDeniedJob);
    assert.equal(resDeniedJob.status, 200);
    assert.equal(store.learning_review_queue.size, countBeforeDenied, "Opted-out job must NOT enter review queue");
    console.log("PASS: Test 5B - Denied learning consent keeps job private and skips review queue.");

    // 5C: Forged client opt-in without server terms acceptance
    const countBeforeForged = store.learning_review_queue.size;
    const reqForgedJob = new Request("https://pooldocai.test/api/clever-handler", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer unaccepted_tech_token" },
      body: JSON.stringify({
        authenticatedApp: true,
        action: "save_technician_job",
        outcome: "resolved",
        equipmentCategory: "Pump",
        manufacturer: "Pentair",
        model: "SuperFlo VST",
        complaint: "No power",
        resolution: "Reset breaker.",
        repairSteps: [{ action: "Reset breaker", result: "Fixed" }],
        caseLearningOptIn: true, // Forged client flag!
        learningTermsVersion: "client-forged-v99"
      })
    });
    const resForgedJob = await capturedHandler!(reqForgedJob);
    assert.equal(resForgedJob.status, 200);
    assert.equal(store.learning_review_queue.size, countBeforeForged, "Forged client consent without server-side legal acceptance must NOT enter review queue");
    console.log("PASS: Test 5C - Forged client opt-in fails closed; server-side terms acceptance strictly enforced.");

    // 5D: Company Opted-Out Fail-Closed
    const countBeforeCompanyOptOut = store.learning_review_queue.size;
    const reqCompanyOptOutJob = new Request("https://pooldocai.test/api/clever-handler", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer consented_tech_token" },
      body: JSON.stringify({
        authenticatedApp: true,
        action: "save_technician_job",
        companyId: "comp_opted_out",
        outcome: "resolved",
        equipmentCategory: "Pump",
        manufacturer: "Pentair",
        model: "SuperFlo VST",
        complaint: "Capacitor failed",
        resolution: "Replaced run capacitor.",
        repairSteps: [{ action: "Replaced capacitor", result: "Starts" }],
        caseLearningOptIn: true
      })
    });
    // Will be rejected because token is comp_tenant_a while body is comp_opted_out (tenant mismatch check!)
    const resCompanyOptOut = await capturedHandler!(reqCompanyOptOutJob);
    assert.equal(resCompanyOptOut.status, 403);
    assert.equal(store.learning_review_queue.size, countBeforeCompanyOptOut);
    console.log("PASS: Test 5D - Cross-company tenant mismatch strictly rejected with 403.");

    // 5E: Explicit Consent Withdrawal
    const targetCase = [...store.diagnostic_cases.values()].find(c => c.case_learning_opt_in === true);
    assert.ok(targetCase, "Must have at least one opted-in case to test withdrawal");
    const reqWithdraw = new Request("https://pooldocai.test/api/clever-handler", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer platform_admin_token" },
      body: JSON.stringify({
        authenticatedApp: true,
        action: "withdraw_case_learning_consent",
        caseId: targetCase.id
      })
    });
    const resWithdraw = await capturedHandler!(reqWithdraw);
    assert.equal(resWithdraw.status, 200);
    const updatedCase = store.diagnostic_cases.get(targetCase.id);
    assert.equal(updatedCase?.case_learning_opt_in, false, "Withdrawn case must have case_learning_opt_in=false");
    console.log("PASS: Test 5E - Case learning consent withdrawal revoked shared opt-in while keeping private record.");
  }

  // --------------------------------------------------------------------------
  // TEST 6: Technician-Verified vs AI-Generated Repair Outcomes (P0 C)
  // --------------------------------------------------------------------------
  {
    console.log("\\n--- TEST 6: Technician-Verified vs AI-Generated Outcomes ---");

    // 6A: AI-generated chatbot answer cannot become shared repair knowledge
    const unverifiedChatbotCaseId = "case_ai_chat_1";
    store.diagnostic_cases.set(unverifiedChatbotCaseId, {
      id: unverifiedChatbotCaseId,
      tenant_id: "comp_tenant_a",
      case_status: "resolved",
      technician_verified: false, // Model output only!
      resolution_summary_redacted: "AI bot suggested replacing the pressure switch.",
      equipment_category: "Heater",
      manufacturer_normalized: "Raypak",
      model_normalized: "266A",
      case_learning_opt_in: true,
      learning_terms_version: "2026-10-21-v1"
    });
    const unverifiedQueueId = "queue_ai_chat_1";
    store.learning_review_queue.set(unverifiedQueueId, {
      id: unverifiedQueueId,
      case_id: unverifiedChatbotCaseId,
      tenant_id: "comp_tenant_a",
      source_kind: "authenticated_troubleshooter",
      status: "pending",
      proposed_lesson_redacted: "Raypak 266A heater pressure switch replacement advice."
    });

    const reqApproveChatbot = new Request("https://pooldocai.test/api/clever-handler", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer platform_admin_token" },
      body: JSON.stringify({
        authenticatedApp: true,
        action: "review_learning_case",
        queueId: unverifiedQueueId,
        decision: "approve"
      })
    });
    const resApproveChatbot = await capturedHandler!(reqApproveChatbot);
    assert.equal(resApproveChatbot.status, 403, "Unverified chatbot answer MUST NOT be approved as confirmed repair");
    const jsonChatbot = await resApproveChatbot.json();
    assert.equal(jsonChatbot.code, "VERIFIED_REPAIR_REQUIRED");
    console.log("PASS: Test 6A - Unverified AI-generated chatbot turn strictly blocked from shared repair approval.");

    // 6B: Confirmed technician repair approves and publishes with distinction
    const verifiedJobCaseId = "case_tech_job_1";
    store.diagnostic_cases.set(verifiedJobCaseId, {
      id: verifiedJobCaseId,
      tenant_id: "comp_tenant_a",
      case_status: "resolved",
      technician_verified: true, // Verified by human technician on pad!
      resolution_summary_redacted: "Replaced cracked manifold header and verified pressure.",
      equipment_category: "Heater",
      manufacturer_normalized: "Raypak",
      model_normalized: "266A",
      case_learning_opt_in: true,
      learning_terms_version: "2026-10-21-v1"
    });
    const verifiedQueueId = "queue_tech_job_1";
    store.learning_review_queue.set(verifiedQueueId, {
      id: verifiedQueueId,
      case_id: verifiedJobCaseId,
      tenant_id: "comp_tenant_a",
      source_kind: "technician_job",
      status: "pending",
      proposed_lesson_redacted: "Raypak 266A heater manifold header leak repair and pressure test."
    });

    const reqApproveTech = new Request("https://pooldocai.test/api/clever-handler", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer platform_admin_token" },
      body: JSON.stringify({
        authenticatedApp: true,
        action: "review_learning_case",
        queueId: verifiedQueueId,
        decision: "approve",
        reviewNote: "Verified by qualified manager."
      })
    });
    const resApproveTech = await capturedHandler!(reqApproveTech);
    assert.equal(resApproveTech.status, 200, "Verified technician repair must approve successfully");
    const jsonTech = await resApproveTech.json();
    assert.equal(jsonTech.status, "approved");
    assert.equal(jsonTech.publishedToSharedRetrieval, true);

    const publishedItem = store.shared_learning_knowledge.get("shared_" + verifiedQueueId);
    assert.ok(publishedItem, "Published shared learning knowledge record must exist");
    assert.equal(publishedItem.source_kind, "technician_job", "Published item must preserve source_kind='technician_job'");
    console.log("PASS: Test 6B - Confirmed technician repair successfully approved and published with verified distinction.");
  }

  // --------------------------------------------------------------------------
  // TEST 7: Homeowner Safety & Technician Diagnostic Continuation (P0 D)
  // --------------------------------------------------------------------------
  {
    console.log("\\n--- TEST 7: Safety & Mode Continuation ---");
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;

    // 7A: Homeowner mode with pump-won't-start: Non-invasive visual/auditory triage (NO false safety hold!)
    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_title: "Check Power Switch and Display",
        step_instructions: "From a dry location, check whether the equipment switch is on and observe if the display or indicator lights are illuminated.",
        safety_warning: "Do not open electrical panels or touch wiring.",
        follow_up_question: "Are any indicator lights on or is the motor humming?",
        choices: [
          { label: "Completely silent, no lights", prompt: "The pump is completely silent and display is dead." },
          { label: "Humming sound", prompt: "I hear a humming sound." }
        ],
        model_suggestions: [],
        source_label: "generic_triage",
        source_id: "",
        source_title: "",
        page_number: "",
        requires_technician: false
      }),
      steps: [{
        type: "google_search_result",
        result: [{ url: "https://support.poolcorp.com/pump-triage", title: "Pump Visual Observation Guide" }]
      }]
    }));

    const reqHomeowner = new Request("https://pooldocai.test/api/clever-handler", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "pub_session_1",
        demoTurnId: "turn_1",
        action: "troubleshoot",
        query: "My pool pump won't start",
        sessionContext: {
          category: "pump",
          symptom: "pump won't start",
          mode: "homeowner"
        }
      })
    });
    const resHomeowner = await capturedHandler!(reqHomeowner);
    assert.equal(resHomeowner.status, 200);
    const jsonHomeowner = await resHomeowner.json();
    assert.equal(jsonHomeowner.criticalHazard || false, false, "Pump won't start must NOT trigger false emergency hazard hold");
    assert.notEqual(jsonHomeowner.status, "emergency_stop", "Pump won't start must NOT trigger emergency stop");
    assert.ok(jsonHomeowner.aiReply || jsonHomeowner.step, "Homeowner pump-won't-start triage reply must be provided");
    console.log("PASS: Test 7A - Homeowner pump-won't-start triage proceeds without premature safety hold.");

    // 7B: Emergency safety stop on real hazard
    const reqEmergency = new Request("https://pooldocai.test/api/clever-handler", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "pub_session_2",
        demoTurnId: "turn_1",
        action: "troubleshoot",
        query: "I smell a strong gas leak near my pool heater and hear hissing",
        sessionContext: {
          category: "heater",
          symptom: "gas leak and hissing",
          mode: "homeowner"
        }
      })
    });
    const resEmergency = await capturedHandler!(reqEmergency);
    assert.equal(resEmergency.status, 200);
    const jsonEmergency = await resEmergency.json();
    assert.equal(jsonEmergency.status, "emergency_stop", "Real gas leak hazard MUST trigger emergency stop");
    assert.equal(jsonEmergency.criticalHazard, true);
    console.log("PASS: Test 7B - Real gas leak hazard triggers immediate non-bypassable emergency stop.");
  }

  console.log("\\n============================================================");
  console.log("ALL POOLDOCAI TASK-005 PART 3 TEST REQUIREMENTS PASSED!");
  console.log("============================================================\\n");
}

runTestSuite().catch(err => {
  console.error("FATAL TASK-005 Part 3 test suite error:", err);
  process.exit(1);
});
`;

fs.writeFileSync(runnerTsPath, runnerScript, "utf8");

try {
  console.log("Executing TASK-005 Part 3 Test Suite with Node...");
  execSync("node --experimental-strip-types scratch/task005_part3_runner.ts", {
    cwd: root,
    stdio: "inherit"
  });
  console.log("TASK-005 Part 3 test suite completed successfully.");
} catch (e) {
  console.error("TASK-005 Part 3 test suite failed:", e.message);
  process.exit(1);
}
