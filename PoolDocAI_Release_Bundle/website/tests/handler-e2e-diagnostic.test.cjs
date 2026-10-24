// True Edge Function HTTP Handler Integration Test (E2E)
// Executes the production clever-handler entrypoint with mocked Supabase and Gemini backends.
// Verifies full request/response plumbing, two-company isolation, search tool suppression,
// citation verification, ungrounded dosing rejection, and fallback search activation.
// Run: node website/tests/handler-e2e-diagnostic.test.cjs

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const handlerPath = path.join(root, "supabase/functions/clever-handler/index.ts");
let rawSource = fs.readFileSync(handlerPath, "utf8").replace(/\r\n/g, "\n");

// Replace the npm import with local bridge before running
const patchedSource = rawSource.replace(
  'import { createClient } from "npm:@supabase/supabase-js@2";',
  'const createClient = globalThis.__createMockSupabaseClient;'
);

// Write executable TS runner that globalThis shims and imports the handler
fs.mkdirSync(path.join(root, "scratch"), { recursive: true });
const runnerTsPath = path.join(root, "scratch/handler_e2e_runner.ts");

const runnerScript = `
import assert from "node:assert/strict";

let capturedHandler: ((req: Request) => Promise<Response>) | null = null;
const geminiCalls: Array<{ url: string; body: any }> = [];

// In-memory multi-tenant store
const store = {
  companies: new Map([
    ["comp_tenant_a", { id: "comp_tenant_a", name: "Alpha Pool Care", status: "active", plan_name: "pro_tech", diagnostic_learning_opt_in: true, active_industry: "pool" }],
    ["comp_tenant_b", { id: "comp_tenant_b", name: "Beta Pool Services", status: "active", plan_name: "fleet_tech", diagnostic_learning_opt_in: true, active_industry: "pool" }]
  ]),
  company_members: new Map([
    ["usr_tech_a", { user_id: "usr_tech_a", company_id: "comp_tenant_a", role: "technician", status: "active", companies: { status: "active", seat_limit: 10, industry_key: "pool" } }],
    ["usr_tech_b", { user_id: "usr_tech_b", company_id: "comp_tenant_b", role: "technician", status: "active", companies: { status: "active", seat_limit: 10, industry_key: "pool" } }]
  ]),
  company_manuals: [
    {
      id: "man_pentair_a",
      company_id: "comp_tenant_a",
      title: "Pentair IntelliFlo VSF Manual",
      active: true,
      reference_enabled: true,
      shared_learning_opt_in: true,
      equipment_category: "pump",
      manufacturer_normalized: "pentair",
      model_normalized: "intelliflo_vsf"
    }
  ],
  company_manual_chunks: [
    {
      id: "chunk_pentair_a_1",
      manual_id: "man_pentair_a",
      company_id: "comp_tenant_a",
      title: "Pentair IntelliFlo VSF Troubleshooting",
      page_number: 14,
      content_text: "Pentair IntelliFlo VSF Pump Display Inactive: If the pump will not start and the keypad display is blank or dead, inspect drive electronics and AC line voltage input to verify 240VAC power supply. Check the main circuit breaker. Ensure all wiring terminals are secure."
    }
  ],
  shared_learning_knowledge: [] as any[],
  pooldocai_rate_limits: new Map<string, any>()
};

let mockGeminiResponses: Array<(reqBody: any) => any> = [];

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
      if (func === "search_company_manual_chunks_hybrid" || func === "search_company_manual_chunks") {
        if (params.p_company_id === "comp_tenant_a") {
          return {
            data: [{
              id: "chunk_pentair_a_1",
              title: "Pentair IntelliFlo VSF Troubleshooting",
              source_url: null,
              page_number: 14,
              page_start: 14,
              page_end: 14,
              rank: 0.95,
              retrieval_method: "hybrid",
              industry_key: "pool",
              equipment_category: "pump",
              manufacturer_normalized: "pentair",
              model_normalized: "intelliflo_vsf",
              content_text: "Pentair IntelliFlo VSF Pump Display Inactive: If the pump will not start and the keypad display is blank or dead, inspect drive electronics and AC line voltage input to verify 240VAC power supply. Check the main circuit breaker. Ensure all wiring terminals are secure."
            }],
            error: null
          };
        }
        return { data: [], error: null };
      }
      if (func === "search_shared_learning" || func === "search_kb_entries") {
        return { data: [], error: null };
      }
      return { data: null, error: null };
    },
    from: (table: string) => {
      let filteredRows: any[] = [];
      if (table === "companies") filteredRows = [...store.companies.values()];
      else if (table === "company_members") filteredRows = [...store.company_members.values()];
      else if (table === "company_manuals") filteredRows = [...store.company_manuals];
      else if (table === "company_manual_chunks") filteredRows = [...store.company_manual_chunks];
      else if (table === "shared_learning_knowledge") filteredRows = [...store.shared_learning_knowledge];
      else if (table === "industry_modules") filteredRows = [{ industry_key: "pool", status: "active" }];
      else if (table === "platform_admins") filteredRows = [];
      else if (table === "temporary_access_grants") filteredRows = [];
      else if (table === "pooldocai_model_rate_cards") filteredRows = [{ grounding_usd_per_1000_units: 35, grounding_pricing_unit: "search_query", provider: "google_gemini", model: "gemini-2.5-flash", active: true }];
      else filteredRows = [];

      const queryBuilder: any = {
        _rows: filteredRows,
        select: (cols: string) => queryBuilder,
        eq: (col: string, val: any) => {
          queryBuilder._rows = queryBuilder._rows.filter((r: any) => r[col] === val);
          return queryBuilder;
        },
        neq: (col: string, val: any) => {
          queryBuilder._rows = queryBuilder._rows.filter((r: any) => r[col] !== val);
          return queryBuilder;
        },
        lte: () => queryBuilder,
        or: () => queryBuilder,
        in: (col: string, vals: any[]) => {
          queryBuilder._rows = queryBuilder._rows.filter((r: any) => vals.includes(r[col]));
          return queryBuilder;
        },
        order: () => queryBuilder,
        limit: (n: number) => {
          queryBuilder._rows = queryBuilder._rows.slice(0, n);
          return queryBuilder;
        },
        maybeSingle: async () => ({ data: queryBuilder._rows[0] || null, error: null }),
        single: async () => ({ data: queryBuilder._rows[0] || null, error: queryBuilder._rows[0] ? null : { message: "not found" } }),
        then: (resolve: any) => resolve({ data: queryBuilder._rows, error: null }),
        insert: (rows: any) => {
          const inserted = Array.isArray(rows) ? rows : [rows];
          return {
            select: () => ({
              single: async () => ({ data: { id: 1, ...(inserted[0] || {}) }, error: null }),
              maybeSingle: async () => ({ data: { id: 1, ...(inserted[0] || {}) }, error: null }),
              then: (resolve: any) => resolve({ data: inserted, error: null })
            }),
            then: (resolve: any) => resolve({ data: inserted, error: null })
          };
        },
        upsert: (rows: any) => {
          return {
            select: () => ({
              single: async () => ({ data: { id: 1 }, error: null }),
              then: (resolve: any) => resolve({ data: rows, error: null })
            }),
            then: (resolve: any) => resolve({ data: rows, error: null })
          };
        },
        update: (vals: any) => {
          return {
            eq: () => ({ eq: () => Promise.resolve({ data: null, error: null }) })
          };
        }
      };
      return queryBuilder;
    }
  };
};

// Execute Clever Handler definition
${patchedSource}

// Test Runner
async function runIntegrationTests() {
  assert.ok(capturedHandler, "Deno.serve must capture the production handler entrypoint");

  console.log("=== Running True Handler Integration Tests ===");

  // TEST 1: Tenant A matches verified internal manual -> Search tool is SUPPRESSED in first pass
  {
    geminiCalls.length = 0;
    mockGeminiResponses = [
      // First pass response conforming to DIAGNOSTIC_RESPONSE_FORMAT citing verified manual chunk
      (req) => ({
        output_text: JSON.stringify({
          response_type: "step",
          source_label: "internal_manual",
          source_id: "chunk_pentair_a_1",
          source_title: "Pentair IntelliFlo VSF Troubleshooting",
          page_number: 14,
          step_instructions: "Inspect drive electronics and AC line voltage input to verify 240VAC power supply.",
          safety_warning: "Turn off main circuit breaker before opening drive cover.",
          follow_up_question: "Do you detect 240VAC across terminals?"
        })
      })
    ];

    const req = new Request("http://localhost:54321/functions/v1/clever-handler", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer tech_token_a"
      },
      body: JSON.stringify({
        authenticatedApp: true,
        diagnosticSessionId: "session_test_diag_1",
        action: "diagnostic_query",
        query: "Pump won't start, keypad display is dead",
        category: "pump",
        brand: "Pentair",
        model: "IntelliFlo VSF",
        symptom: "Pump won't start, keypad display is dead"
      })
    });

    const res = await capturedHandler!(req);
    if (res.status !== 200) {
      console.error("Test 1 failed with non-200 status:", res.status, await res.text());
    }
    assert.equal(res.status, 200, "Handler must return 200 OK");
    const json = await res.json();

    assert.equal(json.status, "success", "Response status must be success");
    assert.equal(json.sourceMode, "manual", "Must route as verified manual");
    assert.equal(json.knowledgeDiagnostics.firstPassInternalOnly, true, "First pass must be internal only");
    assert.equal(json.knowledgeDiagnostics.forcedWebSearchAttempted, false, "Fallback web search must not be attempted");

    // CRITICAL P0 VERIFICATION: Gemini first-pass request must have tools: [] (NO search tool)
    assert.equal(geminiCalls.length, 1, "Only one Gemini call should be made when first pass succeeds");
    const firstCallBody = geminiCalls[0].body;
    assert.deepEqual(firstCallBody.tools, [], "Google Search tool MUST be completely disabled (tools: []) when KB matches");

    console.log("PASS: Test 1 - Internal manual match suppresses Search tool (tools: []) and verifies citation without fallback search.");
  }

  // TEST 2: Model returns ungrounded chemical dosage -> Citation fails & triggers Fallback Web Search
  {
    geminiCalls.length = 0;
    mockGeminiResponses = [
      // First pass returns ungrounded large dose
      (req) => ({
        output_text: JSON.stringify({
          response_type: "step",
          source_label: "internal_manual",
          source_id: "chunk_pentair_a_1",
          source_title: "Pentair IntelliFlo VSF Troubleshooting",
          step_instructions: "Add 100 gallons of liquid chlorine into the pump basket.",
          safety_warning: "Wear goggles."
        })
      }),
      // Second pass (fallback search) returns search grounded answer
      (req) => ({
        output_text: JSON.stringify({
          response_type: "step",
          source_label: "manufacturer_web",
          step_instructions: "Verify circuit breaker is reset and check power leads with voltmeter.",
          safety_warning: "High voltage hazard."
        }),
        steps: [
          { type: "tool_use", name: "google_search" }
        ]
      })
    ];

    const req = new Request("http://localhost:54321/functions/v1/clever-handler", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer tech_token_a"
      },
      body: JSON.stringify({
        authenticatedApp: true,
        diagnosticSessionId: "session_test_diag_2",
        action: "diagnostic_query",
        query: "Pump won't start, keypad display is dead",
        category: "pump",
        brand: "Pentair",
        model: "IntelliFlo VSF",
        symptom: "Pump won't start, keypad display is dead"
      })
    });

    const res = await capturedHandler!(req);
    assert.equal(res.status, 200, "Handler must return 200 OK");
    const json = await res.json();

    // Fallback search must have been invoked!
    assert.equal(geminiCalls.length, 2, "Second Gemini call must be executed for fallback search");
    const secondCallBody = geminiCalls[1].body;
    assert.ok(secondCallBody.tools.some((t: any) => t.google_search || t.type === "google_search"), "Fallback search MUST enable search tool");

    console.log("PASS: Test 2 - Ungrounded chemical dose fails citation verification and activates mandatory fallback web search.");
  }

  // TEST 3: Model returns empty source_id -> Citation fails & triggers Fallback Web Search (P0-1)
  {
    geminiCalls.length = 0;
    mockGeminiResponses = [
      // First pass returns empty source_id
      (req) => ({
        output_text: JSON.stringify({
          response_type: "step",
          source_label: "internal_manual",
          source_id: "",
          source_title: "",
          step_instructions: "Inspect drive electronics and AC line voltage input to verify 240VAC power supply."
        })
      }),
      // Fallback search responder
      (req) => ({
        output_text: JSON.stringify({
          response_type: "step",
          source_label: "manufacturer_web",
          step_instructions: "Consult Pentair authorized service technician."
        }),
        steps: [
          { type: "tool_use", name: "google_search" }
        ]
      })
    ];

    const req = new Request("http://localhost:54321/functions/v1/clever-handler", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer tech_token_a"
      },
      body: JSON.stringify({
        authenticatedApp: true,
        diagnosticSessionId: "session_test_diag_3",
        action: "diagnostic_query",
        query: "Pump won't start, keypad display is dead",
        category: "pump",
        brand: "Pentair",
        model: "IntelliFlo VSF",
        symptom: "Pump won't start, keypad display is dead"
      })
    });

    const res = await capturedHandler!(req);
    assert.equal(res.status, 200);
    assert.equal(geminiCalls.length, 2, "Empty source_id must trigger fallback search (P0-1)");

    console.log("PASS: Test 3 - Empty source_id strictly fails verification and triggers fallback search (P0-1).");
  }

  // TEST 4: Multi-tenant isolation - Tenant B cannot access Tenant A's private manual
  {
    geminiCalls.length = 0;
    mockGeminiResponses = [
      (req) => ({
        output_text: JSON.stringify({
          response_type: "step",
          source_label: "manufacturer_web",
          step_instructions: "Check electrical service panel for tripped breaker.",
          safety_warning: "Turn off power before touching wiring."
        }),
        steps: [
          {
            type: "google_search_result",
            result: [
              { title: "Pentair Support Manuals", url: "https://www.pentair.com/support" }
            ]
          }
        ]
      })
    ];

    // Tenant B queries the same pump
    const req = new Request("http://localhost:54321/functions/v1/clever-handler", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer tech_token_b" // Tenant B
      },
      body: JSON.stringify({
        authenticatedApp: true,
        diagnosticSessionId: "session_test_diag_4",
        action: "diagnostic_query",
        query: "Pump won't start, keypad display is dead",
        category: "pump",
        brand: "Pentair",
        model: "IntelliFlo VSF",
        symptom: "Pump won't start, keypad display is dead"
      })
    });

    const res = await capturedHandler!(req);
    assert.equal(res.status, 200);

    // Because Tenant B has NO manual for Pentair, first pass MUST have tools: [{ google_search }]
    assert.equal(geminiCalls.length, 1);
    const callBody = geminiCalls[0].body;
    assert.ok(callBody.tools.some((t: any) => t.google_search || t.type === "google_search"), "Tenant B has no internal manual, so search tool MUST be enabled");

    console.log("PASS: Test 4 - Strict multi-tenant isolation: Tenant B cannot access Tenant A's private manual.");
  }

  console.log("\\nALL TRUE HANDLER INTEGRATION TESTS PASSED SUCCESSFULLY.");
}

runIntegrationTests().catch(err => {
  console.error("FATAL integration test error:", err);
  process.exit(1);
});
`;

fs.writeFileSync(runnerTsPath, runnerScript, "utf8");

try {
  console.log("Executing True Edge Handler Integration Test in Node.js...");
  execSync("node --experimental-strip-types scratch/handler_e2e_runner.ts", {
    cwd: root,
    stdio: "inherit"
  });
  console.log("Integration test completed successfully.");
} catch (e) {
  console.error("Integration test failed:", e.message);
  process.exit(1);
}
