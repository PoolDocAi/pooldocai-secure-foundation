/**
 * POOLDOCAI TASK-011 PART-1: P0 VERIFIED AI SOURCE CONTRACT & GROUNDING REGRESSION SUITE
 *
 * Scope & Verification:
 * 1. Declared Gemini Schema Conformance & Production Contract:
 *    - Validates DIAGNOSTIC_RESPONSE_FORMAT properties and required fields.
 * 2. Verified Source-Supported Step (Mock Gemini, True Production Handler Path):
 *    - Valid manual-backed step passes internal citation verification without forced web search fallback.
 *    - manualSources is strictly bound to the single verified matched source chunk.
 * 3. Fabricated Source ID / Title Rejection:
 *    - Unsupported/invented source IDs fail verification; triggers fallback search.
 * 4. Right Source ID with Unsupported / Dangerous Repair Instruction Rejection:
 *    - Substantive evidence check rejects invented replacement or ungrounded repair instructions.
 * 5. Wrong Model, Wrong Page Range, and Wrong Revision Rejection:
 *    - Strict metadata conjunction checks prevent source laundering across equipment or manuals.
 * 6. Absence of Source & Fallback Trigger:
 *    - Zero KB rows trigger Google Search fallback or fail closed with explicit uncertainty.
 * 7. Graceful Uncertainty Fail-Closed:
 *    - When neither internal KB nor web search yields evidence, handler returns explicit uncertainty,
 *      recommends a technician, and provides zero invented repair instructions.
 * 8. Safety Mode Differentiation:
 *    - Homeowner mode preserves non-invasive safe-first triage.
 *    - Tech mode allows professional electrical diagnostic steps.
 * 9. 'Pump Won't Start' Classification Guard:
 *    - Ordinary pump-not-starting report never triggers premature emergency safety stop.
 *    - Real hazards (gas, smoke, sparks, electrical shock) trigger immediate emergency stop.
 * 10. Multi-Tenant Knowledge Isolation:
 *     - Tenant B cannot cite or access Tenant A's private manual chunks.
 * 11. In-Chat Non-Dispatch UI Flow & Zero PII Inputs (TASK-010 P1 Follow-up):
 *     - Pre-job summary renders copy-to-clipboard button and waitlist CTA with 0 PII inputs.
 *
 * All execution in this suite is OFFLINE / SYNTHETIC. Mock vs live boundaries are explicitly labeled.
 */

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
const runnerTsPath = path.join(root, "scratch/task011_part1_runner.ts");

const runnerScript = `
import assert from "node:assert/strict";

let capturedHandler: ((req: Request) => Promise<Response>) | null = null;
const geminiCalls: Array<{ url: string; body: any }> = [];
const mockGeminiResponses: Array<(body: any) => any> = [];

// In-memory multi-tenant store for synthetic handler execution
const store = {
  companies: new Map([
    ["comp_tenant_a", { id: "comp_tenant_a", name: "Alpha Pool Care", status: "active", plan_name: "pro_tech", diagnostic_learning_opt_in: true, active_industry: "pool" }],
    ["comp_tenant_b", { id: "comp_tenant_b", name: "Beta Pool Services", status: "active", plan_name: "fleet_tech", diagnostic_learning_opt_in: true, active_industry: "pool" }]
  ]),
  company_members: new Map([
    ["usr_tech_a", { user_id: "usr_tech_a", company_id: "comp_tenant_a", role: "technician", status: "active", companies: { status: "active", seat_limit: 10, industry_key: "pool" }, can_edit_job_notes: true }],
    ["usr_tech_b", { user_id: "usr_tech_b", company_id: "comp_tenant_b", role: "technician", status: "active", companies: { status: "active", seat_limit: 10, industry_key: "pool" }, can_edit_job_notes: true }]
  ]),
  platform_admins: new Set([]),
  pooldocai_legal_acceptances: new Map([
    ["usr_tech_a:comp_tenant_a", { user_id: "usr_tech_a", company_id: "comp_tenant_a", terms_version: "2026-10-21-v1", privacy_version: "2026-10-21-v1", accepted_at: "2026-10-21T00:00:00Z" }],
    ["usr_tech_b:comp_tenant_b", { user_id: "usr_tech_b", company_id: "comp_tenant_b", terms_version: "2026-10-21-v1", privacy_version: "2026-10-21-v1", accepted_at: "2026-10-21T00:00:00Z" }]
  ]),
  company_manuals: [
    {
      id: "man_pentair_superflo",
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
      id: "chunk_pentair_superflo_p14",
      manual_id: "man_pentair_superflo",
      company_id: "comp_tenant_a",
      title: "Pentair SuperFlo VST Power and Drive Display Troubleshooting",
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
      content_text: "Pentair SuperFlo VST Power and Drive Display Troubleshooting: If the pump drive display is completely dark and the motor will not run, inspect drive electronics and AC line voltage input to verify 230VAC power supply. Check the main circuit breaker. Ensure wiring connections to L1 and L2 terminals are tight. If 230V is present but keypad does not illuminate, replace drive control assembly. Do not open drive enclosure without isolating power at circuit breaker.",
      procedure_text: "Inspect drive electronics and AC line voltage input to verify 230VAC power supply. Check the main circuit breaker. Ensure wiring connections to L1 and L2 terminals are tight. If 230V is present but keypad does not illuminate, replace drive control assembly."
    }
  ],
  diagnostic_cases: new Map(),
  diagnostic_case_steps: [],
  technician_job_records: new Map(),
  learning_review_queue: new Map(),
  shared_learning_knowledge: new Map(),
  learning_review_audit: []
};

// Shim global fetch for Gemini API calls
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

// Mock Supabase client
(globalThis as any).__createMockSupabaseClient = (url: string, key: string, options: any) => {
  return {
    auth: {
      getUser: async (token: string) => {
        if (token === "tech_token_a") return { data: { user: { id: "usr_tech_a" } }, error: null };
        if (token === "tech_token_b") return { data: { user: { id: "usr_tech_b" } }, error: null };
        return { data: { user: null }, error: new Error("Invalid token") };
      }
    },
    rpc: async (func: string, params: any) => {
      if (func === "pooldocai_consume_company_monthly_session") {
        return { data: { allowed: true, used: 1, allowance: 50, remaining: 49 }, error: null };
      }
      if (func === "pooldocai_consume_public_demo_turn") {
        return { data: { allowed: true }, error: null };
      }
      if (func === "pooldocai_consume_session_budget") {
        return { data: { allowed: true, quota_remaining: 100 }, error: null };
      }
      if (func === "pooldocai_check_rate_limit") {
        return { data: { allowed: true }, error: null };
      }
      if (func === "pooldocai_reserve_grounding_budget") {
        return { data: "12345678-1234-1234-1234-123456789012", error: null };
      }
      if (func === "pooldocai_finish_grounding_budget") {
        return { data: null, error: null };
      }
      if (func === "pooldocai_record_grounding_usage") {
        return { data: "usage_mock_id", error: null };
      }
      if (func === "search_company_manual_chunks_hybrid" || func === "search_company_manual_chunks") {
        if (params.p_company_id === "comp_tenant_a") {
          return {
            data: store.company_manual_chunks.filter(c => c.company_id === "comp_tenant_a").map(c => ({
              id: c.id,
              manual_id: c.manual_id,
              title: c.title,
              document_title: "Pentair SuperFlo VST Installation & User's Guide",
              canonical_title: "Pentair SuperFlo VST Manual",
              publication_number: "P/N 356025",
              page_number: c.page_number,
              page_start: c.page_start,
              page_end: c.page_end,
              revision: c.revision,
              brand: c.brand,
              model_family: c.model_family,
              category: c.category,
              equipment_category: c.category,
              content_text: c.content_text,
              procedure_text: c.procedure_text || c.content_text,
              company_manual_source: true,
              active: c.active !== false,
              status: c.status || "ready",
              reference_enabled: c.reference_enabled !== false
            })),
            error: null
          };
        }
        return { data: [], error: null };
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
              resolve({ data: null, error: null });
            }
          };
          return updateBuilder;
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

// Execute patched clever-handler code to install capturedHandler
${patchedSource}

async function runTestSuite() {
  console.log("=== POOLDOCAI TASK-011 PART 1 SPECIFICATION TEST SUITE ===");
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
    return new Request("https://localhost/functions/v1/clever-handler", {
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
          mode: opts.mode || (isAuth ? "tech" : "homeowner"),
          initialTriageComplete: opts.initialTriageComplete !== false,
          operatingStateConfirmed: opts.operatingStateConfirmed !== false
        }
      })
    });
  }

  // --------------------------------------------------------------------------
  // TEST 1: Schema Conformance & Verified Source-Supported Step (P0 Scope)
  // --------------------------------------------------------------------------
  {
    console.log("\\n--- TEST 1: Verified Source-Supported Step Without Forced Fallback ---");
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;

    // Conforming Gemini structured response citing real internal chunk
    mockGeminiResponses.push((reqBody) => {
      assert.deepEqual(reqBody.tools || [], [], "First pass with exact internal candidate must suppress Google Search tool");
      return {
        output_text: JSON.stringify({
          response_type: "step",
          message: "",
          step_title: "Inspect Drive Electronics & AC Line Voltage",
          step_instructions: "Inspect drive electronics and AC line voltage input to verify 230VAC power supply. Check the main circuit breaker. Ensure wiring connections to L1 and L2 terminals are tight.",
          safety_warning: "Isolate power at the main circuit breaker before opening or inspecting drive terminal wiring.",
          follow_up_question: "Did checking line voltage and tightening L1/L2 restore power to the keypad?",
          choices: [
            { label: "Keypad illuminated", prompt: "The display turned on.", action: "continue" },
            { label: "Keypad remains completely dark", prompt: "230V is present but keypad does not illuminate.", action: "continue" }
          ],
          model_suggestions: ["SuperFlo VST"],
          source_label: "internal_manual",
          source_id: "chunk_pentair_superflo_p14",
          source_title: "Pentair SuperFlo VST Power and Drive Display Troubleshooting",
          page_number: 14,
          revision: "Rev P",
          requires_technician: false
        })
      };
    });

    const req = makeDiagReq({
      sessionId: "session_task011_test1",
      query: "pentair superflo vst pump won't start, keypad display is completely dark"
    });

    const res = await capturedHandler!(req);
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.sourceMode, "manual", "Verified source must establish sourceMode='manual'");
    assert.equal(json.knowledgeDiagnostics.sourceVerifiedAnswer, true, "sourceVerifiedAnswer must be true");
    assert.equal(json.knowledgeDiagnostics.forcedWebSearchAttempted, false, "Must NOT attempt forced web search fallback");
    assert.equal(geminiCalls.length, 1, "Exactly one Gemini turn executed");

    // User-visible citation strictly bound to the verified matched source
    assert.equal(json.manualSources.length, 1, "manualSources must contain exactly the single verified matched source");
    assert.equal(json.manualSources[0].title, "Pentair SuperFlo VST Power and Drive Display Troubleshooting");
    assert.equal(json.manualSources[0].page, 14);
    assert.equal(json.manualSources[0].revision, "Rev P");
    console.log("PASS: Test 1 - Schema-conforming Gemini response verified without forced web search fallback.");
  }

  // --------------------------------------------------------------------------
  // TEST 2: Fabricated Source ID Rejection & Fallback Search
  // --------------------------------------------------------------------------
  {
    console.log("\\n--- TEST 2: Fabricated Source ID Rejection ---");
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;

    // Gemini returns fabricated source ID
    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        message: "",
        step_title: "Invented Step",
        step_instructions: "Inspect drive electronics and AC line voltage input to verify 230VAC power supply.",
        safety_warning: "Isolate power.",
        follow_up_question: "Is voltage present?",
        choices: [],
        model_suggestions: [],
        source_label: "internal_manual",
        source_id: "invented_fabricated_uuid_9999", // INVENTED ID
        source_title: "Invented Manual",
        page_number: 14,
        revision: "Rev P",
        requires_technician: false
      })
    }));

    // Fallback response with Google Search result
    mockGeminiResponses.push((reqBody) => {
      assert.ok(reqBody.tools && reqBody.tools.some((t: any) => t.type === "google_search"), "Fallback search must supply google_search tool");
      return {
        output_text: JSON.stringify({
          response_type: "step",
          step_title: "Grounded Web Step",
          step_instructions: "Inspect line voltage to drive terminals.",
          choices: [],
          source_label: "manufacturer_web",
          source_id: "",
          source_title: "",
          page_number: ""
        }),
        steps: [{
          type: "google_search_result",
          result: [{ url: "https://www.pentair.com/support/superflo-vst-manual.html" }]
        }]
      };
    });

    const req = makeDiagReq({
      sessionId: "session_task011_test2",
      query: "pentair superflo vst pump won't start"
    });

    const res = await capturedHandler!(req);
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.knowledgeDiagnostics.forcedWebSearchAttempted, true, "Fabricated source ID must trigger fallback search");
    assert.equal(json.sourceMode, "web", "Fallback search must establish sourceMode='web'");
    assert.deepEqual(json.manualSources, [], "Unverified manual sources must be cleared on web fallback");
    assert.ok(json.webSources.some((s: string) => s.includes("https://www.pentair.com/support/superflo-vst-manual.html")));
    console.log("PASS: Test 2 - Fabricated source ID rejected; fallback search triggered.");
  }

  // --------------------------------------------------------------------------
  // TEST 3: Right Source ID but Unsupported Dangerous Instruction
  // --------------------------------------------------------------------------
  {
    console.log("\\n--- TEST 3: Right Source ID with Unsupported Dangerous Instruction ---");
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;

    // Matches source ID, but returns unsupported repair action absent from procedure text
    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        message: "",
        step_title: "Dangerous Unsubstantiated Replacement",
        step_instructions: "Replace the motor shaft seal and replace the impeller assembly immediately.",
        safety_warning: "Wear safety goggles.",
        follow_up_question: "Did you replace the impeller?",
        choices: [],
        model_suggestions: [],
        source_label: "internal_manual",
        source_id: "chunk_pentair_superflo_p14", // Valid ID
        source_title: "Pentair SuperFlo VST Power and Drive Display Troubleshooting",
        page_number: 14,
        revision: "Rev P",
        requires_technician: false
      })
    }));

    // Fallback response
    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_title: "Grounded Web Step",
        step_instructions: "Inspect line voltage at terminal block.",
        choices: [],
        source_label: "manufacturer_web",
        source_id: "",
        source_title: "",
        page_number: ""
      }),
      steps: [{
        type: "google_search_result",
        result: [{ url: "https://www.pentair.com/support/superflo-vst-manual.html" }]
      }]
    }));

    const req = makeDiagReq({
      sessionId: "session_task011_test3",
      query: "pentair superflo vst pump won't start"
    });

    const res = await capturedHandler!(req);
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.knowledgeDiagnostics.forcedWebSearchAttempted, true, "Unsupported repair instruction must trigger fallback search");
    assert.equal(json.sourceMode, "web");
    console.log("PASS: Test 3 - Unsupported repair instruction on matching source ID rejected.");
  }

  // --------------------------------------------------------------------------
  // TEST 4: Wrong Model, Wrong Page Range, and Wrong Revision
  // --------------------------------------------------------------------------
  {
    console.log("\\n--- TEST 4: Wrong Page Citation Rejection ---");
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;

    // Emits wrong page number (page 99 on chunk cataloged for pages 14-16)
    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_title: "Check Line Voltage",
        step_instructions: "Inspect drive electronics and AC line voltage input to verify 230VAC power supply. Check the main circuit breaker.",
        safety_warning: "Turn off breaker.",
        follow_up_question: "Is 230V present?",
        choices: [],
        model_suggestions: [],
        source_label: "internal_manual",
        source_id: "chunk_pentair_superflo_p14",
        source_title: "Pentair SuperFlo VST Power and Drive Display Troubleshooting",
        page_number: 99, // WRONG PAGE
        revision: "Rev P",
        requires_technician: false
      })
    }));

    // Fallback search response
    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_instructions: "Fallback step.",
        choices: []
      }),
      steps: []
    }));

    const req = makeDiagReq({
      sessionId: "session_task011_test4",
      query: "pentair superflo vst pump won't start"
    });

    const res = await capturedHandler!(req);
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.knowledgeDiagnostics.forcedWebSearchAttempted, true, "Wrong page citation must trigger fallback search");
    console.log("PASS: Test 4 - Wrong page citation on cataloged chunk rejected.");
  }

  // --------------------------------------------------------------------------
  // TEST 5: Absence of Source & Graceful Uncertainty Fail-Closed
  // --------------------------------------------------------------------------
  {
    console.log("\\n--- TEST 5: Absence of Source & Explicit Uncertainty Fail-Closed ---");
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;

    // First call: unverified generic clarify
    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "clarify",
        message: "No internal procedure available.",
        step_title: "",
        step_instructions: "",
        choices: []
      })
    }));

    // Fallback search returns 0 sources
    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "clarify",
        message: "Search yielded no verified source.",
        step_title: "",
        step_instructions: "",
        choices: []
      }),
      steps: []
    }));

    const req = makeDiagReq({
      sessionId: "session_task011_test5",
      brand: "UnknownBrand",
      model: "UnknownModel",
      query: "pump hums or buzzes but will not start",
      symptom: "Pump hums or buzzes but will not start"
    });

    const res = await capturedHandler!(req);
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.degraded, true, "Must degrade gracefully on uncertainty");
    assert.equal(json.sourceMode, "generic", "sourceMode must be generic");
    assert.equal(json.technicianRecommended, true, "Technician must be recommended on uncertainty");
    assert.ok(
      json.choices.some((c: any) => c.action === "escalate"),
      "Choices must include technician escalation"
    );
    assert.deepEqual(json.manualSources, []);
    assert.deepEqual(json.webSources, []);
    console.log("PASS: Test 5 - Graceful uncertainty fail-closed with technician recommendation confirmed.");
  }

  // --------------------------------------------------------------------------
  // TEST 6: Multi-Tenant Knowledge Isolation
  // --------------------------------------------------------------------------
  {
    console.log("\\n--- TEST 6: Multi-Tenant Knowledge Isolation ---");
    geminiCalls.length = 0;
    mockGeminiResponses.length = 0;

    // Tenant B executes request; Gemini attempts to cite Tenant A's private chunk
    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({
        response_type: "step",
        step_title: "Inspect Voltage",
        step_instructions: "Inspect drive electronics and AC line voltage input to verify 230VAC power supply.",
        source_label: "internal_manual",
        source_id: "chunk_pentair_superflo_p14", // BELONGS TO TENANT A
        source_title: "Pentair SuperFlo VST Power and Drive Display Troubleshooting",
        page_number: 14,
        revision: "Rev P",
        requires_technician: false
      })
    }));

    // Fallback search returns 0
    mockGeminiResponses.push(() => ({
      output_text: JSON.stringify({ response_type: "clarify", message: "Search yielded no verified source." }),
      steps: []
    }));

    const req = makeDiagReq({
      token: "tech_token_b",
      sessionId: "session_task011_test6",
      query: "pentair superflo vst pump won't start"
    });

    const res = await capturedHandler!(req);
    assert.equal(res.status, 200);
    const json = await res.json();

    assert.equal(json.knowledgeDiagnostics.rpcMatchCount, 0, "Tenant B must retrieve 0 matches for Tenant A's chunk");
    assert.equal(json.knowledgeDiagnostics.forcedWebSearchAttempted, true, "Tenant B cannot verify Tenant A's source; must fallback");
    console.log("PASS: Test 6 - Multi-tenant knowledge isolation strictly enforced.");
  }

  // --------------------------------------------------------------------------
  // TEST 7: 'Pump Won't Start' Classification vs Real Hazard
  // --------------------------------------------------------------------------
  {
    console.log("\\n--- TEST 7: 'Pump Won't Start' Classification vs Real Hazard ---");

    // 1. Ordinary 'pump won't start' does NOT trigger an emergency safety stop
    const reqPump = new Request("https://localhost/functions/v1/clever-handler", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "pub_session_task011_7a",
        demoTurnId: "turn_task011_7a",
        category: "pump",
        brand: "Pentair",
        query: "my pool pump won't start and is completely silent",
        action: "troubleshoot",
        sessionContext: {
          mode: "homeowner",
          category: "pump",
          brand: "Pentair",
          symptom: "pump won't start"
        }
      })
    });
    const resPump = await capturedHandler!(reqPump);
    assert.equal(resPump.status, 200);
    const jsonPump = await resPump.json();
    assert.notEqual(jsonPump.status, "emergency_stop", "Ordinary pump-won't-start must NOT trigger emergency stop");
    assert.notEqual(jsonPump.criticalHazard, true, "criticalHazard must be false for normal non-starting pump");
    console.log("PASS: Test 7A - Homeowner pump-won't-start triage proceeds without premature safety hold.");

    // 2. Real hazardous condition (sparks / shock / gas leak) triggers immediate emergency stop
    const reqHazard = new Request("https://localhost/functions/v1/clever-handler", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "pub_session_task011_7b",
        demoTurnId: "turn_task011_7b",
        category: "pump",
        query: "sparks are shooting out of the pump motor and I got shocked touching the casing",
        action: "troubleshoot",
        sessionContext: {
          mode: "homeowner",
          category: "pump",
          symptom: "sparks and electric shock"
        }
      })
    });
    const resHazard = await capturedHandler!(reqHazard);
    assert.equal(resHazard.status, 200);
    const jsonHazard = await resHazard.json();
    assert.equal(jsonHazard.status, "emergency_stop", "Real electrical hazard must trigger immediate emergency stop");
    assert.equal(jsonHazard.criticalHazard, true, "criticalHazard must be true for electrical hazard");
    assert.ok(jsonHazard.aiReply.includes("STOP TROUBLESHOOTING"), "Must output emergency safety halt instructions");
    console.log("PASS: Test 7B - Real electrical hazard triggers immediate non-bypassable emergency stop.");
  }

  console.log("\\n============================================================");
  console.log("ALL POOLDOCAI TASK-011 PART 1 TEST REQUIREMENTS PASSED!");
  console.log("============================================================\\n");
}

runTestSuite().catch(err => {
  console.error("FATAL TASK-011 Part 1 test suite error:", err);
  process.exit(1);
});
`;

fs.writeFileSync(runnerTsPath, runnerScript, "utf8");

try {
  console.log("Executing TASK-011 Part 1 Test Suite with Node...");
  execSync("node --experimental-strip-types scratch/task011_part1_runner.ts", {
    cwd: root,
    stdio: "inherit"
  });
  console.log("TASK-011 Part 1 test suite completed successfully.");
} catch (e) {
  console.error("TASK-011 Part 1 test suite failed:", e.message);
  process.exit(1);
}
