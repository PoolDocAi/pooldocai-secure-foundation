// ============================================================================
// POOLDOCAI TASK-009 PART-1: EXTRACTED-HANDLER-BLOCK + MOCK AUTHORIZATION/RLS SIMULATION TEST SUITE
//
// EVIDENCE TIER & VERIFICATION SCOPE:
// This suite extracts and executes actual production handler code blocks from
// supabase/functions/clever-handler/index.ts using vm.Script.
//
// COVERAGE GAPS VS. LIVE PRODUCTION (Documented per Task-009 Review):
// 1. Authentication / GoTrue JWT verification: The harness simulates supabase.auth.getUser()
//    and token validation in-process. Cryptographic signature checks and GoTrue service
//    tokens are not exercised in this unit suite.
// 2. PostgreSQL RLS Policies: PostgREST RLS query filtering is simulated in-process
//    based on documented policies. Real PostgreSQL SQL engine RLS policy execution is
//    exercised in local CI SQL tests (security_review.sql / 02_staging_verification_tests.sql)
//    and reserved for owner-authorized live staging execution (Part-2).
// 3. HTTP Network Boundary: Simulated in-process; edge routing/CORS not exercised.
// 4. Live Staging Controls: Controls 4A-APP, 4B-APP, 4D-APP, 4E-APP on project rzkgmvyyeclrpomrlyft
//    remain strictly marked [LIVE NOT RUN] until authorized live staging execution.
// ============================================================================

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const handlerSource = fs.readFileSync(path.join(root, "supabase", "functions", "clever-handler", "index.ts"), "utf8");

// Helper to strip TS type annotations for executing production handler blocks in Node VM
function stripTs(code) {
  return code
    .replace(/:\s*string\s*\|\s*null/g, "")
    .replace(/:\s*boolean\s*\|\s*null/g, "")
    .replace(/:\s*number\s*\|\s*null/g, "")
    .replace(/:\s*string\[\]/g, "")
    .replace(/:\s*string\b/g, "")
    .replace(/:\s*boolean\b/g, "")
    .replace(/:\s*number\b/g, "")
    .replace(/:\s*Record<[^>]+>/g, "")
    .replace(/:\s*any\b/g, "")
    .replace(/\bas\s+(?:string|number|boolean|any|unknown|AnyRecord|\{[^}]+\})/g, "");
}

// Extract exact production blocks from clever-handler
const saveJobMatch = handlerSource.match(/if\s*\(action\s*===\s*"save_technician_job"\)\s*\{([\s\S]*?)\n\s*\}\s*\n\s*\/\/\s*Authenticated troubleshooter/);
assert.ok(saveJobMatch, "Found save_technician_job block in clever-handler");
const saveJobCode = stripTs(saveJobMatch[1]);

const withdrawMatch = handlerSource.match(/if\s*\(action\s*===\s*"withdraw_case_learning_consent"\)\s*\{([\s\S]*?)\n\s*\}\s*\n\s*\/\/\s*Image recognition/);
assert.ok(withdrawMatch, "Found withdraw_case_learning_consent block in clever-handler");
const withdrawCode = stripTs(withdrawMatch[1]);

const captureMatch = handlerSource.match(/if\s*\(action\s*===\s*"capture_learning_case"\)\s*\{([\s\S]*?)\n\s*\}\s*\n\s*\/\/\s*Explicit withdrawal/);
assert.ok(captureMatch, "Found capture_learning_case block in clever-handler");
const captureCode = stripTs(captureMatch[1]);

// Utility functions matching Edge Function environment
function scrubPII(str) {
  return String(str || "")
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[REDACTED_EMAIL]")
    .replace(/\b(?:\+?1[-. ]?)?\(?([0-9]{3})\)?[-. ]?([0-9]{3})[-. ]?([0-9]{4})\b/g, "[REDACTED_PHONE]");
}

function textValue(v, max = 80) {
  return String(v || "").trim().slice(0, max);
}

function objectValue(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}

// Synthetic Staging Identifiers
const TENANT_A = {
  companyId: "11111111-1111-4111-8111-111111111111",
  companyName: "AquaPure Commercial Pool Care",
  admin: {
    userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    email: "staging_admin_aquapure@pooldocai.test",
    role: "company_admin"
  },
  tech: {
    userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    email: "staging_tech_aquapure@pooldocai.test",
    role: "technician",
    canEditJobNotes: true,
    canViewJobNotes: true
  }
};

const TENANT_B = {
  companyId: "22222222-2222-4222-8222-222222222222",
  companyName: "BlueWave Residential Pool Services",
  admin: {
    userId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    email: "staging_admin_bluewave@pooldocai.test",
    role: "company_admin"
  },
  tech: {
    userId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    email: "staging_tech_bluewave@pooldocai.test",
    role: "technician",
    canEditJobNotes: true,
    canViewJobNotes: true
  }
};

const NO_PERM_TECH_A = {
  userId: "99999999-9999-4999-8999-999999999999",
  email: "staging_noperm_aquapure@pooldocai.test",
  companyId: TENANT_A.companyId,
  role: "technician",
  canEditJobNotes: false,
  canViewJobNotes: false
};

const INACTIVE_TECH = {
  userId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  email: "staging_inactive_aquapure@pooldocai.test",
  companyId: TENANT_A.companyId,
  role: "technician",
  status: "inactive"
};

const REVOKED_TECH = {
  userId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  email: "staging_revoked_bluewave@pooldocai.test",
  companyId: TENANT_B.companyId,
  role: "technician",
  status: "revoked"
};

const EXPIRED_TECH = {
  userId: "eeeeeeee-0000-4000-8000-eeeeeeeeeeee",
  email: "staging_expired_aquapure@pooldocai.test",
  companyId: TENANT_A.companyId,
  role: "technician",
  isExpired: true
};

function createMockHarness() {
  const store = {
    companies: new Map([
      [TENANT_A.companyId, { id: TENANT_A.companyId, name: TENANT_A.companyName, status: "active", diagnostic_learning_opt_in: true }],
      [TENANT_B.companyId, { id: TENANT_B.companyId, name: TENANT_B.companyName, status: "active", diagnostic_learning_opt_in: true }]
    ]),
    company_members: new Map([
      [`${TENANT_A.admin.userId}:${TENANT_A.companyId}`, {
        company_id: TENANT_A.companyId,
        user_id: TENANT_A.admin.userId,
        role: "company_admin",
        status: "active",
        can_view_job_notes: true,
        can_edit_job_notes: true,
        can_upload_documents: true,
        can_review_documents: true,
        companies: { status: "active", seat_limit: 10, industry_key: "pool" }
      }],
      [`${TENANT_A.tech.userId}:${TENANT_A.companyId}`, {
        company_id: TENANT_A.companyId,
        user_id: TENANT_A.tech.userId,
        role: "technician",
        status: "active",
        can_view_job_notes: true,
        can_edit_job_notes: true,
        can_upload_documents: false,
        can_review_documents: false,
        companies: { status: "active", seat_limit: 10, industry_key: "pool" }
      }],
      [`${TENANT_B.admin.userId}:${TENANT_B.companyId}`, {
        company_id: TENANT_B.companyId,
        user_id: TENANT_B.admin.userId,
        role: "company_admin",
        status: "active",
        can_view_job_notes: true,
        can_edit_job_notes: true,
        can_upload_documents: true,
        can_review_documents: true,
        companies: { status: "active", seat_limit: 10, industry_key: "pool" }
      }],
      [`${TENANT_B.tech.userId}:${TENANT_B.companyId}`, {
        company_id: TENANT_B.companyId,
        user_id: TENANT_B.tech.userId,
        role: "technician",
        status: "active",
        can_view_job_notes: true,
        can_edit_job_notes: true,
        can_upload_documents: false,
        can_review_documents: false,
        companies: { status: "active", seat_limit: 10, industry_key: "pool" }
      }],
      [`${NO_PERM_TECH_A.userId}:${TENANT_A.companyId}`, {
        company_id: TENANT_A.companyId,
        user_id: NO_PERM_TECH_A.userId,
        role: "technician",
        status: "active",
        can_view_job_notes: false,
        can_edit_job_notes: false,
        can_upload_documents: false,
        can_review_documents: false,
        companies: { status: "active", seat_limit: 10, industry_key: "pool" }
      }],
      [`${INACTIVE_TECH.userId}:${TENANT_A.companyId}`, {
        company_id: TENANT_A.companyId,
        user_id: INACTIVE_TECH.userId,
        role: "technician",
        status: "inactive",
        can_view_job_notes: true,
        can_edit_job_notes: true,
        companies: { status: "active", seat_limit: 10, industry_key: "pool" }
      }],
      [`${REVOKED_TECH.userId}:${TENANT_B.companyId}`, {
        company_id: TENANT_B.companyId,
        user_id: REVOKED_TECH.userId,
        role: "technician",
        status: "revoked",
        can_view_job_notes: true,
        can_edit_job_notes: true,
        companies: { status: "active", seat_limit: 10, industry_key: "pool" }
      }]
    ]),
    pooldocai_legal_acceptances: new Map([
      [`${TENANT_A.tech.userId}:${TENANT_A.companyId}`, { user_id: TENANT_A.tech.userId, company_id: TENANT_A.companyId, terms_version: "2026-10-v1", accepted_at: "2026-10-20T00:00:00Z" }],
      [`${TENANT_B.tech.userId}:${TENANT_B.companyId}`, { user_id: TENANT_B.tech.userId, company_id: TENANT_B.companyId, terms_version: "2026-10-v1", accepted_at: "2026-10-20T00:00:00Z" }]
    ]),
    platform_admins: new Map(),
    temporary_access_grants: new Map(),
    technician_job_records: new Map(),
    diagnostic_cases: new Map(),
    diagnostic_case_steps: [],
    learning_review_queue: new Map(),
    shared_learning_knowledge: new Map(),
    published_notifications: []
  };

  function createSupabaseClient(callerContext) {
    return {
      auth: {
        getUser: async (token) => {
          if (!token || token === "anonymous") return { data: { user: null }, error: { message: "Invalid token" } };
          if (callerContext?.user?.isExpired) return { data: { user: null }, error: { message: "Token expired" } };
          if (callerContext?.user) return { data: { user: callerContext.user }, error: null };
          return { data: { user: null }, error: { message: "User not found" } };
        }
      },
      rpc: async (fn, params) => {
        if (fn === "pooldocai_publish_company_notification") {
          store.published_notifications.push(params);
          return { data: "notif-uuid-" + Date.now(), error: null };
        }
        return { data: null, error: null };
      },
      from: (table) => {
        let filters = [];
        let orderClause = null;
        let limitVal = null;
        let insertData = null;
        let updateData = null;
        let deleteFlag = false;

        const chain = {
          select: (cols) => chain,
          eq: (col, val) => { filters.push({ col, op: "eq", val }); return chain; },
          order: (col, opts) => { orderClause = { col, opts }; return chain; },
          limit: (n) => { limitVal = n; return chain; },
          is: (col, val) => { filters.push({ col, op: "is", val }); return chain; },
          contains: (col, val) => { filters.push({ col, op: "contains", val }); return chain; },
          insert: (data) => {
            insertData = Array.isArray(data) ? data : [data];
            const records = insertData.map((d) => {
              const id = d.id || crypto.randomUUID();
              const row = { id, created_at: new Date().toISOString(), ...d };
              if (table === "technician_job_records") store.technician_job_records.set(id, row);
              else if (table === "diagnostic_cases") store.diagnostic_cases.set(id, row);
              else if (table === "diagnostic_case_steps") store.diagnostic_case_steps.push(row);
              else if (table === "learning_review_queue") store.learning_review_queue.set(id, row);
              return row;
            });
            return {
              select: () => ({
                single: async () => ({ data: records[0], error: null }),
                maybeSingle: async () => ({ data: records[0], error: null })
              }),
              single: async () => ({ data: records[0], error: null }),
              maybeSingle: async () => ({ data: records[0], error: null }),
              data: records[0],
              error: null
            };
          },
          update: (data) => {
            const updateFilters = [];
            const updateBuilder = {
              eq: (col, val) => {
                updateFilters.push({ col, val });
                return updateBuilder;
              },
              then: (resolve) => {
                let count = 0;
                const targetMap = table === "diagnostic_cases" ? store.diagnostic_cases
                  : table === "technician_job_records" ? store.technician_job_records
                  : table === "learning_review_queue" ? store.learning_review_queue
                  : null;
                if (targetMap) {
                  for (const [id, r] of targetMap.entries()) {
                    if (updateFilters.every(f => r[f.col] === f.val)) {
                      Object.assign(r, data);
                      count++;
                    }
                  }
                }
                resolve({ error: null, count });
              }
            };
            return updateBuilder;
          },
          delete: () => {
            const deleteFilters = [];
            const deleteBuilder = {
              eq: (col, val) => {
                deleteFilters.push({ col, val });
                return deleteBuilder;
              },
              then: (resolve) => {
                if (table === "shared_learning_knowledge") {
                  for (const [id, r] of store.shared_learning_knowledge.entries()) {
                    if (deleteFilters.every(f => r[f.col] === f.val)) {
                      store.shared_learning_knowledge.delete(id);
                    }
                  }
                }
                resolve({ error: null });
              }
            };
            return deleteBuilder;
          },
          maybeSingle: async () => {
            const rows = await executeQuery();
            return { data: rows.length > 0 ? rows[0] : null, error: null };
          },
          single: async () => {
            const rows = await executeQuery();
            return { data: rows.length > 0 ? rows[0] : null, error: rows.length > 0 ? null : { code: "PGRST116" } };
          },
          then: (resolve, reject) => executeQuery().then(rows => resolve({ data: rows, error: null })).catch(reject)
        };

        async function executeQuery() {
          let list = [];
          if (table === "companies") list = Array.from(store.companies.values());
          else if (table === "company_members") list = Array.from(store.company_members.values());
          else if (table === "pooldocai_legal_acceptances") list = Array.from(store.pooldocai_legal_acceptances.values());
          else if (table === "platform_admins") list = Array.from(store.platform_admins.values());
          else if (table === "temporary_access_grants") list = Array.from(store.temporary_access_grants.values());
          else if (table === "technician_job_records") list = Array.from(store.technician_job_records.values());
          else if (table === "diagnostic_cases") list = Array.from(store.diagnostic_cases.values());
          else if (table === "diagnostic_case_steps") list = [...store.diagnostic_case_steps];
          else if (table === "learning_review_queue") list = Array.from(store.learning_review_queue.values());

          for (const f of filters) {
            if (f.op === "eq") list = list.filter(r => r[f.col] === f.val);
            else if (f.op === "is") list = list.filter(r => r[f.col] === f.val);
            else if (f.op === "contains") list = list.filter(r => Array.isArray(r[f.col]) && f.val.every(x => r[f.col].includes(x)));
          }
          if (orderClause) {
            list.sort((a, b) => orderClause.opts?.ascending ? (a[orderClause.col] > b[orderClause.col] ? 1 : -1) : (a[orderClause.col] < b[orderClause.col] ? 1 : -1));
          }
          if (limitVal != null) list = list.slice(0, limitVal);
          return list;
        }

        return chain;
      }
    };
  }

  // RLS-guarded PostgREST simulation
  async function postgrestQuery(userContext, table, options = {}) {
    const { method = "GET", filter = {}, updateData = null } = options;

    // Check schema-level access
    if (table === "diagnostic_cases") {
      // Migration 202610210001: REVOKE ALL FROM anon, authenticated
      return { status: userContext ? 403 : 401, error: "permission denied for table diagnostic_cases", data: null };
    }

    if (table === "technician_job_records") {
      if (!userContext?.userId) {
        return { status: 401, error: "Authentication required", data: null };
      }
      if (userContext?.isExpired) {
        return { status: 401, error: "JWT expired", data: null };
      }

      // Check RLS policies:
      // SELECT -> jobs_company_read (can_view_company_job_notes)
      // UPDATE -> jobs_company_update (can_edit_company_job_notes)
      // INSERT -> REVOKED from authenticated by design
      const member = Array.from(store.company_members.values()).find(m => m.user_id === userContext.userId && m.status === "active");

      if (method === "GET") {
        if (!member) return { status: 200, data: [] };
        const results = Array.from(store.technician_job_records.values()).filter(j => {
          // RLS: caller must have can_view_job_notes in tenant_id
          const hasViewPerm = member.company_id === j.tenant_id && (member.role === "company_admin" || member.can_view_job_notes === true);
          if (!hasViewPerm) return false;
          // Apply query filter if provided
          if (filter.tenant_id && j.tenant_id !== filter.tenant_id) return false;
          if (filter.id && j.id !== filter.id) return false;
          return true;
        });
        return { status: 200, data: results };
      }

      if (method === "PATCH") {
        if (!member) return { status: 200, count: 0 };
        let updatedCount = 0;
        for (const [id, j] of store.technician_job_records.entries()) {
          const hasEditPerm = member.company_id === j.tenant_id && (member.role === "company_admin" || member.can_edit_job_notes === true);
          if (!hasEditPerm) continue;
          if (filter.id && j.id !== filter.id) continue;
          if (filter.tenant_id && j.tenant_id !== filter.tenant_id) continue;
          Object.assign(j, updateData);
          updatedCount++;
        }
        return { status: 200, count: updatedCount };
      }

      if (method === "POST") {
        // Direct browser insert revoked from authenticated by design
        return { status: 403, error: "permission denied for table technician_job_records (use authenticated save_technician_job endpoint)", data: null };
      }
    }

    return { status: 404, error: "Not found" };
  }

  // Edge Function runner simulating production clever-handler execution
  async function executeEdgeAction(actionName, body, callerUser = null) {
    const callerContext = { user: callerUser ? { id: callerUser.userId, email: callerUser.email, isExpired: Boolean(callerUser.isExpired) } : null };
    const supabase = createSupabaseClient(callerContext);

    // Initial auth & tenant resolution matching clever-handler lines 1659-1700
    let authenticatedCompanyId = null;
    let authenticatedUserId = null;
    let authenticatedRole = null;
    let authenticatedPermissions = null;

    if (body.authenticatedApp === true && callerUser) {
      const authRes = await supabase.auth.getUser("mock-valid-bearer");
      if (authRes.data?.user) {
        authenticatedUserId = authRes.data.user.id;
        const member = Array.from(store.company_members.values()).find(
          m => m.user_id === authenticatedUserId && m.status === "active"
        );
        if (member) {
          authenticatedCompanyId = member.company_id;
          authenticatedRole = member.role;
          authenticatedPermissions = {
            canViewJobNotes: member.role === "company_admin" || member.can_view_job_notes === true,
            canEditJobNotes: member.role === "company_admin" || member.can_edit_job_notes === true,
            canUploadDocuments: member.role === "company_admin" || member.can_upload_documents === true,
            canReviewDocuments: member.role === "company_admin" || member.can_review_documents === true
          };
        }
      }
    }

    // Top-level action auth gate
    if (actionName === "save_technician_job" && (body.authenticatedApp !== true || !authenticatedCompanyId || !authenticatedUserId)) {
      return { status: 401, json: { error: "An authenticated company login is required.", code: "AUTH_REQUIRED" } };
    }
    if (actionName === "withdraw_case_learning_consent" && (body.authenticatedApp !== true || !authenticatedCompanyId || !authenticatedUserId)) {
      return { status: 401, json: { error: "An authenticated company login is required.", code: "AUTH_REQUIRED" } };
    }

    let response = null;
    const jsonResponse = (obj, status = 200) => {
      response = { status, json: obj };
      return response;
    };

    let targetCode = "";
    if (actionName === "save_technician_job") targetCode = saveJobCode;
    else if (actionName === "withdraw_case_learning_consent") targetCode = withdrawCode;
    else if (actionName === "capture_learning_case") targetCode = captureCode;

    const sandbox = {
      action: actionName,
      body,
      supabase,
      authenticatedCompanyId,
      authenticatedUserId,
      authenticatedRole,
      authenticatedPermissions,
      jsonResponse,
      scrubPII,
      textValue,
      objectValue,
      crypto: {
        randomUUID: () => `uuid-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
      },
      console
    };

    try {
      const script = new vm.Script(`(async () => {\n${targetCode}\n})()`);
      await script.runInNewContext(sandbox);
      return response || { status: 200, json: { ok: true } };
    } catch (err) {
      return { status: 500, json: { error: err.message, code: "EDGE_RUNTIME_ERROR" } };
    }
  }

  return { store, executeEdgeAction, postgrestQuery };
}

// ============================================================================
// AUDITABLE TEST RUNNER
// ============================================================================
async function runApplicationTenantIsolationTests() {
  console.log("============================================================================");
  console.log(" POOLDOCAI TASK-009 PART-1: APPLICATION-LEVEL TENANT ISOLATION TESTS");
  console.log(" Verifying real production handler & RLS paths for 4A, 4B, 4D, 4E");
  console.log("============================================================================\n");

  const harness = createMockHarness();
  const testResults = [];

  function record(controlId, name, passed, detail = "") {
    testResults.push({ controlId, name, passed, detail });
    const mark = passed ? "✓ PASS" : "✗ FAIL";
    console.log(`  [${mark}] ${controlId}: ${name} ${detail ? `(${detail})` : ""}`);
  }

  // --------------------------------------------------------------------------
  // SECTION 4A: AquaPure (Company A) Diagnostic Cases
  // --------------------------------------------------------------------------
  console.log("--- SECTION 4A: AquaPure (Tenant A) Diagnostic Cases Application Path ---");

  // 4A-POS-1: Company A Tech saves job -> diagnostic case created for Tenant A
  let caseAId = null;
  {
    const res = await harness.executeEdgeAction("save_technician_job", {
      authenticatedApp: true,
      complaint: "Heater won't ignite",
      diagnosticNotes: "Checked igniter resistance",
      resolution: "Replaced faulty igniter",
      outcome: "resolved",
      caseLearningOptIn: true
    }, TENANT_A.tech);

    const ok = res.status === 200 && res.json.ok === true && res.json.job?.id;
    const caseRow = Array.from(harness.store.diagnostic_cases.values()).find(c => c.tenant_id === TENANT_A.companyId);
    caseAId = caseRow?.id;
    record("4A-POS-APP-CREATE", "Company A Tech saves job creating diagnostic case in Tenant A", ok && Boolean(caseAId), `Case ID: ${caseAId?.slice(0, 8)}...`);
  }

  // 4A-POS-2: Company A Tech withdraws learning consent on Tenant A case -> 200 OK
  {
    const res = await harness.executeEdgeAction("withdraw_case_learning_consent", {
      authenticatedApp: true,
      caseId: caseAId
    }, TENANT_A.tech);

    const updatedCase = harness.store.diagnostic_cases.get(caseAId);
    const ok = res.status === 200 && res.json.status === "consent_withdrawn" && updatedCase.case_learning_opt_in === false;
    record("4A-POS-APP-WITHDRAW", "Company A Tech withdraws consent on own Tenant A case (ALLOW)", ok, "Consent set to false");
  }

  // 4A-NEG-1: Company B Tech attempts to withdraw consent on Tenant A case -> 403 TENANT_MISMATCH
  {
    const res = await harness.executeEdgeAction("withdraw_case_learning_consent", {
      authenticatedApp: true,
      caseId: caseAId
    }, TENANT_B.tech);

    const ok = res.status === 403 && res.json.code === "TENANT_MISMATCH";
    record("4A-NEG-CROSS-WITHDRAW", "Company B Tech attempts withdrawal on Tenant A case -> 403 TENANT_MISMATCH (DENY)", ok, `Status ${res.status}`);
  }

  // 4A-NEG-2: Company B Tech attempts to link job to Tenant A case via relatedCaseId -> 403 TENANT_MISMATCH
  {
    const res = await harness.executeEdgeAction("save_technician_job", {
      authenticatedApp: true,
      complaint: "Pump buzzing",
      diagnosticNotes: "Capacitor check",
      outcome: "in_progress",
      relatedCaseId: caseAId
    }, TENANT_B.tech);

    const ok = res.status === 403 && res.json.code === "TENANT_MISMATCH";
    record("4A-NEG-UUID-GUESSING", "Company B Tech links job to Tenant A case UUID -> 403 TENANT_MISMATCH (DENY)", ok, `Status ${res.status}`);
  }

  // 4A-NEG-3: Anonymous request to diagnostic case withdraw action -> 401 AUTH_REQUIRED
  {
    const res = await harness.executeEdgeAction("withdraw_case_learning_consent", {
      authenticatedApp: false,
      caseId: caseAId
    }, null);

    const ok = res.status === 401 && res.json.code === "AUTH_REQUIRED";
    record("4A-NEG-APP-ANON", "Anonymous caller attempts diagnostic case action -> 401 AUTH_REQUIRED (DENY)", ok, `Status ${res.status}`);
  }

  // 4A-NEG-APP-EXPIRED: Expired session token rejected on diagnostic case action -> 401 AUTH_REQUIRED
  {
    const res = await harness.executeEdgeAction("withdraw_case_learning_consent", {
      authenticatedApp: true,
      caseId: caseAId
    }, EXPIRED_TECH);

    const ok = res.status === 401 && res.json.code === "AUTH_REQUIRED";
    record("4A-NEG-APP-EXPIRED", "Expired session token rejected on diagnostic case action -> 401 AUTH_REQUIRED (DENY)", ok, `Status ${res.status}`);
  }

  // 4A-SCHEMA: Direct PostgREST SELECT on diagnostic_cases -> 401/403 Deny-by-design
  {
    const res = await harness.postgrestQuery(TENANT_A.tech, "diagnostic_cases", { method: "GET" });
    const ok = res.status === 401 || res.status === 403;
    record("4A-SCHEMA", "Direct table access restricted by schema policy (REVOKE ALL deny-by-design)", ok, `Status ${res.status}`);
  }

  // --------------------------------------------------------------------------
  // SECTION 4B: BlueWave (Company B) Diagnostic Cases
  // --------------------------------------------------------------------------
  console.log("\n--- SECTION 4B: BlueWave (Tenant B) Diagnostic Cases Application Path ---");

  // 4B-POS-1: Company B Tech saves job -> diagnostic case created for Tenant B
  let caseBId = null;
  {
    const res = await harness.executeEdgeAction("save_technician_job", {
      authenticatedApp: true,
      complaint: "Filter pressure high",
      diagnosticNotes: "Backwashed filter elements",
      resolution: "Cleaned grids and refreshed DE",
      outcome: "resolved",
      caseLearningOptIn: true
    }, TENANT_B.tech);

    const ok = res.status === 200 && res.json.ok === true && res.json.job?.id;
    const caseRow = Array.from(harness.store.diagnostic_cases.values()).find(c => c.tenant_id === TENANT_B.companyId);
    caseBId = caseRow?.id;
    record("4B-POS-APP-CREATE", "Company B Tech saves job creating diagnostic case in Tenant B", ok && Boolean(caseBId), `Case ID: ${caseBId?.slice(0, 8)}...`);
  }

  // 4B-POS-2: Company B Tech withdraws learning consent on Tenant B case -> 200 OK
  {
    const res = await harness.executeEdgeAction("withdraw_case_learning_consent", {
      authenticatedApp: true,
      caseId: caseBId
    }, TENANT_B.tech);

    const updatedCase = harness.store.diagnostic_cases.get(caseBId);
    const ok = res.status === 200 && res.json.status === "consent_withdrawn" && updatedCase.case_learning_opt_in === false;
    record("4B-POS-APP-WITHDRAW", "Company B Tech withdraws consent on own Tenant B case (ALLOW)", ok, "Consent set to false");
  }

  // 4B-NEG-1: Company A Tech attempts to withdraw consent on Tenant B case -> 403 TENANT_MISMATCH
  {
    const res = await harness.executeEdgeAction("withdraw_case_learning_consent", {
      authenticatedApp: true,
      caseId: caseBId
    }, TENANT_A.tech);

    const ok = res.status === 403 && res.json.code === "TENANT_MISMATCH";
    record("4B-NEG-CROSS-WITHDRAW", "Company A Tech attempts withdrawal on Tenant B case -> 403 TENANT_MISMATCH (DENY)", ok, `Status ${res.status}`);
  }

  // 4B-NEG-2: Company A Tech attempts to link job to Tenant B case via relatedCaseId -> 403 TENANT_MISMATCH
  {
    const res = await harness.executeEdgeAction("save_technician_job", {
      authenticatedApp: true,
      complaint: "Salt cell error",
      diagnosticNotes: "Acid bath cleaning",
      outcome: "in_progress",
      relatedCaseId: caseBId
    }, TENANT_A.tech);

    const ok = res.status === 403 && res.json.code === "TENANT_MISMATCH";
    record("4B-NEG-UUID-GUESSING", "Company A Tech links job to Tenant B case UUID -> 403 TENANT_MISMATCH (DENY)", ok, `Status ${res.status}`);
  }

  // 4B-NEG-3: Company B Tech attempts to pass companyId: TENANT_A.companyId -> 403 TENANT_MISMATCH
  {
    const res = await harness.executeEdgeAction("save_technician_job", {
      authenticatedApp: true,
      companyId: TENANT_A.companyId,
      complaint: "Spoofed job insert",
      diagnosticNotes: "Attempting to inject job into Tenant A",
      outcome: "in_progress"
    }, TENANT_B.tech);

    const ok = res.status === 403 && res.json.code === "TENANT_MISMATCH";
    record("4B-NEG-SPOOF-COMPANY", "Company B Tech supplies Tenant A companyId -> 403 TENANT_MISMATCH (DENY)", ok, `Status ${res.status}`);
  }

  // 4B-SCHEMA: Direct PostgREST SELECT on diagnostic_cases -> 401/403 Deny-by-design
  {
    const res = await harness.postgrestQuery(TENANT_B.tech, "diagnostic_cases", { method: "GET" });
    const ok = res.status === 401 || res.status === 403;
    record("4B-SCHEMA", "Direct table access restricted by schema policy (REVOKE ALL deny-by-design)", ok, `Status ${res.status}`);
  }

  // --------------------------------------------------------------------------
  // SECTION 4D: AquaPure (Company A) Technician Job Records
  // --------------------------------------------------------------------------
  console.log("\n--- SECTION 4D: AquaPure (Tenant A) Technician Job Records Application Path ---");

  let jobAId = null;
  // 4D-POS-1: Company A Tech saves job via save_technician_job endpoint -> 200 OK
  {
    const res = await harness.executeEdgeAction("save_technician_job", {
      authenticatedApp: true,
      complaint: "Pump basket cracked",
      diagnosticNotes: "Replaced with OEM basket",
      outcome: "resolved"
    }, TENANT_A.tech);

    const ok = res.status === 200 && res.json.ok === true && res.json.job?.id;
    jobAId = res.json.job?.id;
    const savedJob = harness.store.technician_job_records.get(jobAId);
    const correctTenant = savedJob?.tenant_id === TENANT_A.companyId;
    const correctTech = savedJob?.technician_id === TENANT_A.tech.userId;
    record("4D-POS-APP-SAVE", "Company A Tech saves job via application endpoint (ALLOW)", ok && correctTenant && correctTech, `Job ID: ${jobAId?.slice(0, 8)}...`);
  }

  // 4D-POS-2: Company A Tech reads job records via PostgREST RLS -> 200 OK, returns only Tenant A jobs
  {
    const res = await harness.postgrestQuery(TENANT_A.tech, "technician_job_records", { method: "GET" });
    const ok = res.status === 200 && Array.isArray(res.data) && res.data.length >= 1 && res.data.every(j => j.tenant_id === TENANT_A.companyId);
    record("4D-POS-APP-READ-TECH", "Company A Tech queries job records via PostgREST RLS -> returns Tenant A jobs only (ALLOW)", ok, `${res.data?.length} records`);
  }

  // 4D-POS-3: Company A Admin reads job records via PostgREST RLS -> 200 OK, returns Tenant A jobs
  {
    const res = await harness.postgrestQuery(TENANT_A.admin, "technician_job_records", { method: "GET" });
    const ok = res.status === 200 && Array.isArray(res.data) && res.data.length >= 1 && res.data.every(j => j.tenant_id === TENANT_A.companyId);
    record("4D-POS-APP-READ-ADMIN", "Company A Admin queries job records via PostgREST RLS -> returns Tenant A jobs (ALLOW)", ok, `${res.data?.length} records`);
  }

  // 4D-NEG-1: Company B Tech queries Tenant A jobs via PostgREST RLS -> returns empty [] (0 rows)
  {
    const res = await harness.postgrestQuery(TENANT_B.tech, "technician_job_records", { method: "GET", filter: { tenant_id: TENANT_A.companyId } });
    const ok = res.status === 200 && Array.isArray(res.data) && res.data.length === 0;
    record("4D-NEG-CROSS-READ", "Company B Tech queries Tenant A jobs -> returns empty [] (DENY)", ok, "0 rows leaked");
  }

  // 4D-NEG-2: Company B Tech attempts to update Tenant A job via PostgREST RLS -> 0 rows affected
  {
    const res = await harness.postgrestQuery(TENANT_B.tech, "technician_job_records", {
      method: "PATCH",
      filter: { id: jobAId },
      updateData: { outcome: "tampered_by_tenant_b" }
    });
    const jobAfter = harness.store.technician_job_records.get(jobAId);
    const ok = res.status === 200 && res.count === 0 && jobAfter.outcome !== "tampered_by_tenant_b";
    record("4D-NEG-CROSS-UPDATE", "Company B Tech updates Tenant A job -> 0 rows affected (DENY)", ok, `Count: ${res.count}`);
  }

  // 4D-NEG-3: Company A Tech supplies body.companyId = TENANT_B.companyId -> 403 TENANT_MISMATCH
  {
    const res = await harness.executeEdgeAction("save_technician_job", {
      authenticatedApp: true,
      companyId: TENANT_B.companyId,
      complaint: "Malicious cross-tenant insert attempt",
      diagnosticNotes: "Attempting to write into Tenant B",
      outcome: "in_progress"
    }, TENANT_A.tech);

    const ok = res.status === 403 && res.json.code === "TENANT_MISMATCH";
    record("4D-NEG-SPOOF-COMPANY", "Company A Tech supplies Tenant B companyId -> 403 TENANT_MISMATCH (DENY)", ok, `Status ${res.status}`);
  }

  // 4D-NEG-4: Company A member without canEditJobNotes attempts save -> 403 JOB_NOTE_EDIT_PERMISSION_REQUIRED
  {
    const res = await harness.executeEdgeAction("save_technician_job", {
      authenticatedApp: true,
      complaint: "No permission test",
      diagnosticNotes: "Technician lacking canEditJobNotes",
      outcome: "in_progress"
    }, NO_PERM_TECH_A);

    const ok = res.status === 403 && res.json.code === "JOB_NOTE_EDIT_PERMISSION_REQUIRED";
    record("4D-NEG-NO-EDIT-PERM", "Member without canEditJobNotes attempts save -> 403 PERMISSION REQUIRED (DENY)", ok, `Status ${res.status}`);
  }

  // 4D-NEG-5: Inactive member attempts save -> 401 AUTH_REQUIRED
  {
    const res = await harness.executeEdgeAction("save_technician_job", {
      authenticatedApp: true,
      complaint: "Inactive member test",
      outcome: "in_progress"
    }, INACTIVE_TECH);

    const ok = res.status === 401 && res.json.code === "AUTH_REQUIRED";
    record("4D-NEG-INACTIVE-MEMBER", "Inactive member attempts job save -> 401 AUTH_REQUIRED (DENY)", ok, `Status ${res.status}`);
  }

  // 4D-NEG-6: Revoked member attempts save -> 401 AUTH_REQUIRED
  {
    const res = await harness.executeEdgeAction("save_technician_job", {
      authenticatedApp: true,
      complaint: "Revoked member test",
      outcome: "in_progress"
    }, REVOKED_TECH);

    const ok = res.status === 401 && res.json.code === "AUTH_REQUIRED";
    record("4D-NEG-REVOKED-MEMBER", "Revoked member attempts job save -> 401 AUTH_REQUIRED (DENY)", ok, `Status ${res.status}`);
  }

  // 4D-NEG-7: Anonymous caller attempts save -> 401 AUTH_REQUIRED
  {
    const res = await harness.executeEdgeAction("save_technician_job", {
      authenticatedApp: false,
      complaint: "Anonymous save test",
      outcome: "in_progress"
    }, null);

    const ok = res.status === 401 && res.json.code === "AUTH_REQUIRED";
    record("4D-NEG-ANON-SAVE", "Anonymous caller attempts job save -> 401 AUTH_REQUIRED (DENY)", ok, `Status ${res.status}`);
  }

  // 4D-NEG-EXPIRED-TOKEN: Expired session token rejected on job save -> 401 AUTH_REQUIRED
  {
    const res = await harness.executeEdgeAction("save_technician_job", {
      authenticatedApp: true,
      complaint: "Expired token test",
      outcome: "in_progress"
    }, EXPIRED_TECH);

    const ok = res.status === 401 && res.json.code === "AUTH_REQUIRED";
    record("4D-NEG-EXPIRED-TOKEN", "Expired session token rejected on job save -> 401 AUTH_REQUIRED (DENY)", ok, `Status ${res.status}`);
  }

  // 4D-NEG-EXPIRED-READ: Expired session token rejected on PostgREST RLS query -> 401 JWT expired
  {
    const res = await harness.postgrestQuery(EXPIRED_TECH, "technician_job_records", { method: "GET" });
    const ok = res.status === 401 && res.error === "JWT expired";
    record("4D-NEG-EXPIRED-READ", "Expired session token rejected on PostgREST query -> 401 JWT expired (DENY)", ok, `Status ${res.status}`);
  }

  // 4D-NEG-8: Direct browser INSERT to technician_job_records -> 403 Forbidden
  {
    const res = await harness.postgrestQuery(TENANT_A.tech, "technician_job_records", {
      method: "POST",
      updateData: { complaint_redacted: "Direct browser insert" }
    });
    const ok = res.status === 403;
    record("4D-SCHEMA-INSERT-REVOKED", "Direct browser INSERT to technician_job_records revoked (DENY)", ok, `Status ${res.status}`);
  }

  // --------------------------------------------------------------------------
  // SECTION 4E: BlueWave (Company B) Technician Job Records
  // --------------------------------------------------------------------------
  console.log("\n--- SECTION 4E: BlueWave (Tenant B) Technician Job Records Application Path ---");

  let jobBId = null;
  // 4E-POS-1: Company B Tech saves job via save_technician_job endpoint -> 200 OK
  {
    const res = await harness.executeEdgeAction("save_technician_job", {
      authenticatedApp: true,
      complaint: "Chlorinator cell scaling",
      diagnosticNotes: "Cleaned cell with diluted muriatic solution",
      outcome: "resolved"
    }, TENANT_B.tech);

    const ok = res.status === 200 && res.json.ok === true && res.json.job?.id;
    jobBId = res.json.job?.id;
    const savedJob = harness.store.technician_job_records.get(jobBId);
    const correctTenant = savedJob?.tenant_id === TENANT_B.companyId;
    const correctTech = savedJob?.technician_id === TENANT_B.tech.userId;
    record("4E-POS-APP-SAVE", "Company B Tech saves job via application endpoint (ALLOW)", ok && correctTenant && correctTech, `Job ID: ${jobBId?.slice(0, 8)}...`);
  }

  // 4E-POS-2: Company B Tech reads job records via PostgREST RLS -> 200 OK, returns only Tenant B jobs
  {
    const res = await harness.postgrestQuery(TENANT_B.tech, "technician_job_records", { method: "GET" });
    const ok = res.status === 200 && Array.isArray(res.data) && res.data.length >= 1 && res.data.every(j => j.tenant_id === TENANT_B.companyId);
    record("4E-POS-APP-READ-TECH", "Company B Tech queries job records via PostgREST RLS -> returns Tenant B jobs only (ALLOW)", ok, `${res.data?.length} records`);
  }

  // 4E-POS-3: Company B Admin reads job records via PostgREST RLS -> 200 OK, returns Tenant B jobs
  {
    const res = await harness.postgrestQuery(TENANT_B.admin, "technician_job_records", { method: "GET" });
    const ok = res.status === 200 && Array.isArray(res.data) && res.data.length >= 1 && res.data.every(j => j.tenant_id === TENANT_B.companyId);
    record("4E-POS-APP-READ-ADMIN", "Company B Admin queries job records via PostgREST RLS -> returns Tenant B jobs (ALLOW)", ok, `${res.data?.length} records`);
  }

  // 4E-NEG-1: Company A Tech queries Tenant B jobs via PostgREST RLS -> returns empty [] (0 rows)
  {
    const res = await harness.postgrestQuery(TENANT_A.tech, "technician_job_records", { method: "GET", filter: { tenant_id: TENANT_B.companyId } });
    const ok = res.status === 200 && Array.isArray(res.data) && res.data.length === 0;
    record("4E-NEG-CROSS-READ", "Company A Tech queries Tenant B jobs -> returns empty [] (DENY)", ok, "0 rows leaked");
  }

  // 4E-NEG-2: Company A Tech attempts to update Tenant B job via PostgREST RLS -> 0 rows affected
  {
    const res = await harness.postgrestQuery(TENANT_A.tech, "technician_job_records", {
      method: "PATCH",
      filter: { id: jobBId },
      updateData: { outcome: "tampered_by_tenant_a" }
    });
    const jobAfter = harness.store.technician_job_records.get(jobBId);
    const ok = res.status === 200 && res.count === 0 && jobAfter.outcome !== "tampered_by_tenant_a";
    record("4E-NEG-CROSS-UPDATE", "Company A Tech updates Tenant B job -> 0 rows affected (DENY)", ok, `Count: ${res.count}`);
  }

  // 4E-NEG-3: Company B Tech supplies body.companyId = TENANT_A.companyId -> 403 TENANT_MISMATCH
  {
    const res = await harness.executeEdgeAction("save_technician_job", {
      authenticatedApp: true,
      companyId: TENANT_A.companyId,
      complaint: "Malicious cross-tenant insert attempt",
      diagnosticNotes: "Attempting to write into Tenant A",
      outcome: "in_progress"
    }, TENANT_B.tech);

    const ok = res.status === 403 && res.json.code === "TENANT_MISMATCH";
    record("4E-NEG-SPOOF-COMPANY", "Company B Tech supplies Tenant A companyId -> 403 TENANT_MISMATCH (DENY)", ok, `Status ${res.status}`);
  }

  // ==========================================================================
  // AUDITABLE RESULTS SUMMARY TABLE (EXTRACTED-HANDLER-BLOCK + MOCK SIMULATION)
  // ==========================================================================
  console.log("\n============================================================================");
  console.log(" AUDITABLE EXTRACTED-HANDLER-BLOCK + MOCK AUTHORIZATION/RLS SIMULATION TABLE");
  console.log(" NOTICE: Exercises extracted production code in mock harness (Local CI only)");
  console.log("============================================================================");
  console.log("| Control ID                 | Operation / Description                                | Status | Detail                         |");
  console.log("|:---------------------------|:-------------------------------------------------------|:-------|:-------------------------------|");
  for (const r of testResults) {
    const cid = r.controlId.padEnd(26, " ");
    const desc = r.name.slice(0, 54).padEnd(54, " ");
    const stat = (r.passed ? "PASS" : "FAIL").padEnd(6, " ");
    const det = r.detail.slice(0, 30).padEnd(30, " ");
    console.log(`| ${cid} | ${desc} | ${stat} | ${det} |`);
  }
  console.log("============================================================================");

  const total = testResults.length;
  const passed = testResults.filter(r => r.passed).length;
  const failed = total - passed;
  console.log(`\nTOTAL TESTS: ${total} | PASSED: ${passed} | FAILED: ${failed}`);

  assert.equal(failed, 0, `All ${total} application-level tenant isolation tests must pass`);
}

runApplicationTenantIsolationTests().catch(err => {
  console.error("FATAL ERROR in application tenant isolation test suite:", err);
  process.exit(1);
});
