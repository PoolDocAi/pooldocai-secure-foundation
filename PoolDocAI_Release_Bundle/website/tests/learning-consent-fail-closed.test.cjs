const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const handlerSource = fs.readFileSync(path.join(root, "supabase", "functions", "clever-handler", "index.ts"), "utf8");

// Helper to strip TS type annotations for running extracted Edge code in Node VM
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
    .replace(/\bas\s+[^;,\n)]+/g, "");
}

const reviewMatch = handlerSource.match(/if\s*\(\["review_learning_case",\s*"list_learning_review_queue"\]\.includes\(action\)\)\s*\{([\s\S]*?)\n\s*\}\s*\n\s*\/\/\s*Technician job records/);
assert.ok(reviewMatch, "Found review_learning_case block in clever-handler");
let reviewCode = stripTs(reviewMatch[1]);

const saveJobMatch = handlerSource.match(/if\s*\(action\s*===\s*"save_technician_job"\)\s*\{([\s\S]*?)\n\s*\}\s*\n\s*\/\/\s*Authenticated troubleshooter/);
assert.ok(saveJobMatch, "Found save_technician_job block in clever-handler");
let saveJobCode = stripTs(saveJobMatch[1]);

const captureMatch = handlerSource.match(/if\s*\(action\s*===\s*"capture_learning_case"\)\s*\{([\s\S]*?)\n\s*\}\s*\n\s*\/\/\s*Explicit withdrawal/);
assert.ok(captureMatch, "Found capture_learning_case block in clever-handler");
let captureCode = stripTs(captureMatch[1]);

const withdrawMatch = handlerSource.match(/if\s*\(action\s*===\s*"withdraw_case_learning_consent"\)\s*\{([\s\S]*?)\n\s*\}\s*\n\s*\/\/\s*Image recognition/);
assert.ok(withdrawMatch, "Found withdraw_case_learning_consent block in clever-handler");
let withdrawCode = stripTs(withdrawMatch[1]);

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

function createHarness() {
  const store = {
    platform_admins: new Map([["usr_platform_admin_1", { user_id: "usr_platform_admin_1" }]]),
    companies: new Map([
      ["comp_opted_in", { id: "comp_opted_in", name: "Opted In Pool Co", diagnostic_learning_opt_in: true }],
      ["comp_opted_out", { id: "comp_opted_out", name: "Private Pool Co", diagnostic_learning_opt_in: false }]
    ]),
    pooldocai_legal_acceptances: new Map([
      ["usr_consented_tech:comp_opted_in", { user_id: "usr_consented_tech", company_id: "comp_opted_in", terms_version: "2026-10-v1", accepted_at: "2026-10-01T00:00:00Z" }],
      ["usr_consented_tech:comp_opted_out", { user_id: "usr_consented_tech", company_id: "comp_opted_out", terms_version: "2026-10-v1", accepted_at: "2026-10-01T00:00:00Z" }]
    ]),
    technician_job_records: new Map(),
    diagnostic_cases: new Map(),
    diagnostic_case_steps: [],
    learning_review_queue: new Map(),
    shared_learning_knowledge: new Map(),
    learning_review_audit: [],
    company_manuals: new Map()
  };

  let rpcOverride = null;

  const mockSupabase = {
    rpc: async (funcName, params) => {
      if (rpcOverride) return rpcOverride(funcName, params);
      if (funcName === "pooldocai_approve_learning_case") {
        const item = store.learning_review_queue.get(params.p_queue_id);
        if (!item) return { error: { message: `Review queue item ${params.p_queue_id} not found` } };
        if (item.status !== "pending") return { error: { message: `Review item is not pending (status: ${item.status})` } };

        const caseRow = store.diagnostic_cases.get(item.case_id);
        if (!caseRow) return { error: { message: `Diagnostic case ${item.case_id} not found` } };

        if (caseRow.tenant_id) {
          if (!caseRow.case_learning_opt_in) return { error: { message: "Case-level learning consent was not granted or was withdrawn" } };
          if (!caseRow.learning_terms_version && !caseRow.legal_terms_version) {
            return { error: { message: "Verified contributor terms acceptance is required for case learning approval" } };
          }
          const comp = store.companies.get(caseRow.tenant_id);
          if (!comp || !comp.diagnostic_learning_opt_in) return { error: { message: "Governing company diagnostic learning opt-in is required" } };
        } else {
          // Public demo consent check
          const hasCaseConsent = Boolean(caseRow.case_learning_opt_in || (caseRow.learning_permission_granted && (caseRow.legal_terms_version || caseRow.learning_terms_version)));
          if (!hasCaseConsent) return { error: { message: "Public demo case-level learning consent was not granted or was withdrawn" } };
        }

        // Verified repair requirement: Chatbot turns or field notes without confirmed outcome cannot be approved
        if (["technician_job", "authenticated_troubleshooter"].includes(item.source_kind)) {
          if (!caseRow.technician_verified || !String(caseRow.resolution_summary_redacted || "").trim()) {
            return { error: { message: "Only a resolved technician-verified case with a recorded outcome can become shared repair knowledge" } };
          }
        }

        // Publish to shared knowledge
        store.shared_learning_knowledge.set(item.id, {
          source_case_id: item.case_id,
          source_queue_id: item.id,
          source_company_id: item.tenant_id,
          source_kind: item.source_kind,
          lesson_redacted: params.p_lesson,
          approved_by: params.p_reviewed_by
        });

        // Update case and queue
        caseRow.approved_for_learning = true;
        caseRow.privacy_reviewed_at = new Date().toISOString();
        item.status = "approved";
        item.reviewed_by = params.p_reviewed_by;
        item.reviewed_at = new Date().toISOString();

        store.learning_review_audit.push({
          queue_id: params.p_queue_id,
          case_id: item.case_id,
          actor_user_id: params.p_reviewed_by,
          action: "approved"
        });

        return { data: { ok: true, status: "approved" }, error: null };
      }
      throw new Error(`Unexpected RPC: ${funcName}`);
    },

    from(table) {
      return {
        select(cols) {
          return {
            eq(col1, val1) {
              const chain2 = {
                eq(col2, val2) {
                  return {
                    order() {
                      return {
                        limit() {
                          return {
                            maybeSingle: async () => {
                              if (table === "pooldocai_legal_acceptances") {
                                const key = `${val1}:${val2}`;
                                return { data: store.pooldocai_legal_acceptances.get(key) || null, error: null };
                              }
                              return { data: null, error: null };
                            }
                          };
                        }
                      };
                    },
                    maybeSingle: async () => {
                      if (table === "learning_review_queue") {
                        for (const row of store.learning_review_queue.values()) {
                          if (row[col1] === val1 && row[col2] === val2) return { data: { ...row }, error: null };
                        }
                        return { data: null, error: null };
                      }
                      if (table === "technician_job_records") {
                        for (const row of store.technician_job_records.values()) {
                          if (row[col1] === val1 && row[col2] === val2) return { data: { ...row }, error: null };
                        }
                        return { data: null, error: null };
                      }
                      return { data: null, error: null };
                    }
                  };
                },
                maybeSingle: async () => {
                  if (table === "platform_admins") {
                    return { data: store.platform_admins.get(val1) || null, error: null };
                  }
                  if (table === "companies") {
                    return { data: store.companies.get(val1) || null, error: null };
                  }
                  if (table === "diagnostic_cases") {
                    return { data: store.diagnostic_cases.get(val1) || null, error: null };
                  }
                  if (table === "learning_review_queue") {
                    return { data: store.learning_review_queue.get(val1) || null, error: null };
                  }
                  if (table === "company_manuals") {
                    return { data: store.company_manuals.get(val1) || null, error: null };
                  }
                  return { data: null, error: null };
                }
              };
              return chain2;
            }
          };
        },

        insert(rowOrRows) {
          const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
          const results = [];
          for (const row of rows) {
            const id = row.id || `gen_${Math.random().toString(36).substring(2, 9)}`;
            const saved = { ...row, id };
            if (table === "diagnostic_cases") store.diagnostic_cases.set(id, saved);
            if (table === "technician_job_records") store.technician_job_records.set(id, saved);
            if (table === "diagnostic_case_steps") store.diagnostic_case_steps.push(saved);
            if (table === "learning_review_queue") store.learning_review_queue.set(id, saved);
            if (table === "shared_learning_knowledge") store.shared_learning_knowledge.set(id, saved);
            if (table === "learning_review_audit") store.learning_review_audit.push(saved);
            results.push(saved);
          }
          return {
            select(cols) {
              return {
                single: async () => ({ data: results[0], error: null }),
                maybeSingle: async () => ({ data: results[0] || null, error: null })
              };
            },
            then(resolve) {
              resolve({ data: results, error: null });
            }
          };
        },

        update(updates) {
          const updateObj = {
            eq(col, val) {
              if (table === "diagnostic_cases") {
                const row = store.diagnostic_cases.get(val);
                if (row) Object.assign(row, updates);
              }
              if (table === "learning_review_queue") {
                const row = store.learning_review_queue.get(val);
                if (row) Object.assign(row, updates);
              }
              if (table === "technician_job_records") {
                const row = store.technician_job_records.get(val);
                if (row) Object.assign(row, updates);
              }
              return updateObj;
            },
            then(resolve) {
              resolve({ error: null });
            }
          };
          return updateObj;
        },

        delete() {
          return {
            eq(col, val) {
              if (table === "shared_learning_knowledge") {
                for (const [k, v] of store.shared_learning_knowledge.entries()) {
                  if (v[col] === val) store.shared_learning_knowledge.delete(k);
                }
              }
              return Promise.resolve({ error: null });
            }
          };
        }
      };
    }
  };

  async function executeAction(actionName, { body, authenticatedUserId, authenticatedCompanyId, authenticatedRole, authenticatedPermissions }) {
    let capturedResponse = null;
    function jsonResponse(data, status = 200) {
      capturedResponse = { status, data };
      return capturedResponse;
    }

    const sandbox = {
      action: actionName,
      body: body || {},
      authenticatedUserId: authenticatedUserId || null,
      authenticatedCompanyId: authenticatedCompanyId || null,
      authenticatedRole: authenticatedRole || (authenticatedUserId ? "company_admin" : null),
      authenticatedPermissions: authenticatedPermissions || { canEditJobNotes: true },
      supabase: mockSupabase,
      jsonResponse,
      scrubPII,
      textValue,
      objectValue,
      console
    };

    let codeToRun = "";
    if (actionName === "review_learning_case" || actionName === "list_learning_review_queue") {
      codeToRun = reviewCode;
    } else if (actionName === "save_technician_job") {
      codeToRun = saveJobCode;
    } else if (actionName === "capture_learning_case") {
      codeToRun = captureCode;
    } else if (actionName === "withdraw_case_learning_consent") {
      codeToRun = withdrawCode;
    } else {
      throw new Error(`Unsupported action in harness: ${actionName}`);
    }

    const script = new vm.Script(`(async () => { ${codeToRun} })()`);
    const context = vm.createContext(sandbox);
    await script.runInContext(context);
    return capturedResponse;
  }

  return {
    store,
    executeAction,
    setRpcOverride: (fn) => { rpcOverride = fn; }
  };
}

async function runLearningConsentTests() {
  console.log("Starting Learning Approval Fail-Closed & Consent Verification Tests...");

  // -------------------------------------------------------------------------
  // Test 1: Approval Fails Closed When RPC Fails (No Direct Publication Fallback)
  // -------------------------------------------------------------------------
  {
    const harness = createHarness();
    const caseId = "case_dual_consented_1";
    const queueId = "queue_dual_consented_1";

    harness.store.diagnostic_cases.set(caseId, {
      id: caseId,
      tenant_id: "comp_opted_in",
      case_learning_opt_in: true,
      learning_terms_version: "2026-10-v1",
      technician_verified: true,
      resolution_summary_redacted: "Raypak 266A roll-out switch replaced",
      equipment_category: "Heater",
      manufacturer_normalized: "Raypak",
      model_normalized: "266A"
    });
    harness.store.learning_review_queue.set(queueId, {
      id: queueId,
      case_id: caseId,
      tenant_id: "comp_opted_in",
      source_kind: "authenticated_troubleshooter",
      status: "pending",
      proposed_lesson_redacted: "Raypak 266A heater roll-out switch tripped due to cracked burner tray."
    });

    // Force RPC pooldocai_approve_learning_case to FAIL (e.g. database serialization failure, deadlock, constraint error)
    harness.setRpcOverride(async () => {
      return { data: null, error: { message: "database deadlock or foreign key constraint violation" } };
    });

    const res = await harness.executeAction("review_learning_case", {
      body: {
        authenticatedApp: true,
        queueId,
        decision: "approve",
        editedLesson: "Raypak 266A heater roll-out switch tripped due to cracked burner tray."
      },
      authenticatedUserId: "usr_platform_admin_1"
    });

    assert.equal(res.status, 500);
    assert.equal(res.data.code, "APPROVAL_TRANSACTION_FAILED");
    assert.equal(harness.store.shared_learning_knowledge.size, 0, "No row should be published to shared_learning_knowledge");
    assert.equal(harness.store.learning_review_queue.get(queueId).status, "pending");
    console.log("PASS: Test 1 - Learning approval fails closed with 500 when RPC errors; direct publication fallback blocked.");
  }

  // -------------------------------------------------------------------------
  // Test 1b: Unverified Chatbot Turn Quarantine (P0 C: Never accumulate AI answers as confirmed fixes)
  // -------------------------------------------------------------------------
  {
    const harness = createHarness();
    const unverifiedChatbotCaseId = "case_unverified_chatbot_1";
    const unverifiedChatbotQueueId = "queue_unverified_chatbot_1";

    harness.store.diagnostic_cases.set(unverifiedChatbotCaseId, {
      id: unverifiedChatbotCaseId,
      tenant_id: "comp_opted_in",
      case_learning_opt_in: true,
      learning_terms_version: "2026-10-v1",
      technician_verified: false, // Model output only, not verified by a human technician!
      resolution_summary_redacted: "AI generated suggestion: replace switch.",
      equipment_category: "Heater",
      manufacturer_normalized: "Raypak",
      model_normalized: "266A"
    });
    harness.store.learning_review_queue.set(unverifiedChatbotQueueId, {
      id: unverifiedChatbotQueueId,
      case_id: unverifiedChatbotCaseId,
      tenant_id: "comp_opted_in",
      source_kind: "authenticated_troubleshooter",
      status: "pending",
      proposed_lesson_redacted: "Raypak 266A unverified AI chatbot troubleshooting advice."
    });

    const res = await harness.executeAction("review_learning_case", {
      body: {
        authenticatedApp: true,
        queueId: unverifiedChatbotQueueId,
        decision: "approve",
        editedLesson: "Raypak 266A unverified AI chatbot troubleshooting advice."
      },
      authenticatedUserId: "usr_platform_admin_1"
    });

    assert.equal(res.status, 403);
    assert.equal(res.data.code, "VERIFIED_REPAIR_REQUIRED");
    assert.equal(harness.store.shared_learning_knowledge.has(unverifiedChatbotQueueId), false, "Unverified AI chatbot response must never be published to shared knowledge!");
    console.log("PASS: Test 1b - Unverified chatbot turns cannot be approved into shared knowledge (P0 C verified).");
  }

  // -------------------------------------------------------------------------
  // Test 1c: Unverified Technician Job (technician_verified = false fails closed)
  // -------------------------------------------------------------------------
  {
    const harness = createHarness();
    const unverifiedTechCaseId = "case_unverified_tech_1";
    const unverifiedTechQueueId = "queue_unverified_tech_1";

    harness.store.diagnostic_cases.set(unverifiedTechCaseId, {
      id: unverifiedTechCaseId,
      tenant_id: "comp_opted_in",
      case_learning_opt_in: true,
      learning_terms_version: "2026-10-v1",
      technician_verified: false,
      resolution_summary_redacted: null,
      equipment_category: "Pump"
    });
    harness.store.learning_review_queue.set(unverifiedTechQueueId, {
      id: unverifiedTechQueueId,
      case_id: unverifiedTechCaseId,
      tenant_id: "comp_opted_in",
      source_kind: "technician_job",
      status: "pending",
      proposed_lesson_redacted: "Incomplete pump diagnostic note"
    });

    const res = await harness.executeAction("review_learning_case", {
      body: { authenticatedApp: true, queueId: unverifiedTechQueueId, decision: "approve", editedLesson: "Incomplete pump diagnostic note" },
      authenticatedUserId: "usr_platform_admin_1"
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.code, "VERIFIED_REPAIR_REQUIRED");
    assert.equal(harness.store.shared_learning_knowledge.has(unverifiedTechQueueId), false);
    console.log("PASS: Test 1c - Unverified technician jobs fail closed with VERIFIED_REPAIR_REQUIRED.");
  }

  // -------------------------------------------------------------------------
  // Test 1d: Verified Technician Job Approves Cleanly
  // -------------------------------------------------------------------------
  {
    const harness = createHarness();
    const verifiedTechCaseId = "case_verified_tech_1";
    const verifiedTechQueueId = "queue_verified_tech_1";

    harness.store.diagnostic_cases.set(verifiedTechCaseId, {
      id: verifiedTechCaseId,
      tenant_id: "comp_opted_in",
      case_learning_opt_in: true,
      learning_terms_version: "2026-10-v1",
      technician_verified: true,
      resolution_summary_redacted: "Cleaned motor impeller and restored nominal water flow.",
      equipment_category: "Pump",
      manufacturer_normalized: "Pentair",
      model_normalized: "IntelliFlo VSF"
    });
    harness.store.learning_review_queue.set(verifiedTechQueueId, {
      id: verifiedTechQueueId,
      case_id: verifiedTechCaseId,
      tenant_id: "comp_opted_in",
      source_kind: "technician_job",
      status: "pending",
      proposed_lesson_redacted: "Pentair IntelliFlo VSF reduced flow resolved by impeller cleaning."
    });

    const res = await harness.executeAction("review_learning_case", {
      body: { authenticatedApp: true, queueId: verifiedTechQueueId, decision: "approve", editedLesson: "Pentair IntelliFlo VSF reduced flow resolved by impeller cleaning." },
      authenticatedUserId: "usr_platform_admin_1"
    });
    assert.equal(res.status, 200);
    assert.equal(res.data.status, "approved");
    assert.equal(res.data.publishedToSharedRetrieval, true);
    assert.equal(harness.store.shared_learning_knowledge.has(verifiedTechQueueId), true);
    console.log("PASS: Test 1d - Fully verified technician repair with documented resolution approves successfully.");
  }

  // -------------------------------------------------------------------------
  // Test 1e: Missing Contributor Terms Version in Case Fails Closed
  // -------------------------------------------------------------------------
  {
    const harness = createHarness();
    const noTermsCaseId = "case_no_terms_1";
    const noTermsQueueId = "queue_no_terms_1";

    harness.store.diagnostic_cases.set(noTermsCaseId, {
      id: noTermsCaseId,
      tenant_id: "comp_opted_in",
      case_learning_opt_in: true,
      learning_terms_version: null, // Unverified terms version!
      technician_verified: true,
      resolution_summary_redacted: "Cleaned filter.",
      equipment_category: "Filter"
    });
    harness.store.learning_review_queue.set(noTermsQueueId, {
      id: noTermsQueueId,
      case_id: noTermsCaseId,
      tenant_id: "comp_opted_in",
      source_kind: "technician_job",
      status: "pending",
      proposed_lesson_redacted: "Filter cleaning fix."
    });

    const res = await harness.executeAction("review_learning_case", {
      body: { authenticatedApp: true, queueId: noTermsQueueId, decision: "approve", editedLesson: "Filter cleaning fix." },
      authenticatedUserId: "usr_platform_admin_1"
    });
    assert.equal(res.status, 403);
    assert.equal(res.data.code, "CASE_LEARNING_OPT_IN_REQUIRED");
    assert.equal(harness.store.shared_learning_knowledge.has(noTermsQueueId), false);
    console.log("PASS: Test 1e - Approval fails closed when contributor terms version is missing.");
  }

  // -------------------------------------------------------------------------
  // Test 2: Public-Demo Case Consent Reconciliation
  // -------------------------------------------------------------------------
  {
    const harness = createHarness();

    // 2a: Legitimate consented public-demo case (learning_permission_granted = true with legal_terms_version)
    const validPublicCaseId = "case_pub_valid_1";
    const validPublicQueueId = "queue_pub_valid_1";
    harness.store.diagnostic_cases.set(validPublicCaseId, {
      id: validPublicCaseId,
      tenant_id: null,
      learning_permission_granted: true,
      legal_terms_version: "2026-10-v1",
      case_learning_opt_in: false,
      equipment_category: "Pump",
      manufacturer_normalized: "Pentair",
      model_normalized: "IntelliFlo"
    });
    harness.store.learning_review_queue.set(validPublicQueueId, {
      id: validPublicQueueId,
      case_id: validPublicCaseId,
      tenant_id: null,
      source_kind: "public_demo",
      status: "pending",
      proposed_lesson_redacted: "Pentair IntelliFlo priming failure resolved by lubricating pump lid O-ring."
    });

    const resValid = await harness.executeAction("review_learning_case", {
      body: {
        authenticatedApp: true,
        queueId: validPublicQueueId,
        decision: "approve",
        editedLesson: "Pentair IntelliFlo priming failure resolved by lubricating pump lid O-ring."
      },
      authenticatedUserId: "usr_platform_admin_1"
    });

    assert.equal(resValid.status, 200);
    assert.equal(resValid.data.status, "approved");
    assert.equal(resValid.data.publishedToSharedRetrieval, true);
    assert.equal(harness.store.shared_learning_knowledge.has(validPublicQueueId), true);
    console.log("PASS: Test 2a - Legitimate public-demo case with prior consent and terms version approves successfully.");

    // 2b: Unconsented public-demo case (learning_permission_granted = false)
    const unconsentedCaseId = "case_pub_unconsented";
    const unconsentedQueueId = "queue_pub_unconsented";
    harness.store.diagnostic_cases.set(unconsentedCaseId, {
      id: unconsentedCaseId,
      tenant_id: null,
      learning_permission_granted: false,
      legal_terms_version: null,
      case_learning_opt_in: false,
      equipment_category: "Pump"
    });
    harness.store.learning_review_queue.set(unconsentedQueueId, {
      id: unconsentedQueueId,
      case_id: unconsentedCaseId,
      tenant_id: null,
      source_kind: "public_demo",
      status: "pending",
      proposed_lesson_redacted: "Unconsented public demo lesson."
    });

    const resUnconsented = await harness.executeAction("review_learning_case", {
      body: {
        authenticatedApp: true,
        queueId: unconsentedQueueId,
        decision: "approve",
        editedLesson: "Unconsented public demo lesson."
      },
      authenticatedUserId: "usr_platform_admin_1"
    });

    assert.equal(resUnconsented.status, 403);
    assert.equal(resUnconsented.data.code, "CASE_LEARNING_OPT_IN_REQUIRED");
    assert.equal(harness.store.shared_learning_knowledge.has(unconsentedQueueId), false);
    console.log("PASS: Test 2b - Unconsented public-demo case fails closed with 403 CASE_LEARNING_OPT_IN_REQUIRED.");
  }

  // -------------------------------------------------------------------------
  // Test 3: Server-Side Contributor Terms Verification in capture_learning_case
  // -------------------------------------------------------------------------
  {
    const harness = createHarness();

    // 3a: Contributor claims caseLearningOptIn: true, but has NO accepted terms in pooldocai_legal_acceptances
    const resNoLegal = await harness.executeAction("capture_learning_case", {
      body: {
        authenticatedApp: true,
        caseStatus: "resolved",
        category: "Heater",
        manufacturer: "Hayward",
        model: "H400FD",
        issue: "Heater display says IF (ignition failure)",
        answer: "Clean the flame rectification sensor and check gas manifold pressure.",
        caseLearningOptIn: true,
        learningTermsVersion: "client-faked-v999"
      },
      authenticatedUserId: "usr_unaccepted_tech",
      authenticatedCompanyId: "comp_opted_in",
      authenticatedRole: "technician"
    });

    assert.equal(resNoLegal.status, 200);
    assert.equal(resNoLegal.data.learningStatus, "company_private");
    const capturedCase1 = harness.store.diagnostic_cases.get(resNoLegal.data.caseId);
    assert.equal(capturedCase1.case_learning_opt_in, false, "Server must reject case opt-in when contributor terms record is absent");
    assert.equal(capturedCase1.learning_terms_version, null);
    assert.equal(harness.store.learning_review_queue.size, 0, "Unverified case must not enter review queue");
    console.log("PASS: Test 3a - Contributor terms verified server-side; client assertion without database acceptance defaults to company_private.");

    // 3b: Contributor has valid accepted terms in pooldocai_legal_acceptances, and governing company is opted in
    const resValidConsent = await harness.executeAction("capture_learning_case", {
      body: {
        authenticatedApp: true,
        caseStatus: "resolved",
        category: "Heater",
        manufacturer: "Hayward",
        model: "H400FD",
        issue: "Heater display says IF (ignition failure)",
        answer: "Clean the flame rectification sensor and check gas manifold pressure.",
        caseLearningOptIn: true
      },
      authenticatedUserId: "usr_consented_tech",
      authenticatedCompanyId: "comp_opted_in",
      authenticatedRole: "technician"
    });

    assert.equal(resValidConsent.status, 200);
    assert.equal(resValidConsent.data.learningStatus, "pending_privacy_review");
    const capturedCase2 = harness.store.diagnostic_cases.get(resValidConsent.data.caseId);
    assert.equal(capturedCase2.case_learning_opt_in, true);
    assert.equal(capturedCase2.learning_terms_version, "2026-10-v1");
    assert.equal(harness.store.learning_review_queue.size, 1);
    console.log("PASS: Test 3b - Valid contributor terms and governing company opt-in enqueues case for shared learning review.");

    // 3c: Contributor has valid accepted terms, but governing company is OPTED OUT
    const resCompanyOptedOut = await harness.executeAction("capture_learning_case", {
      body: {
        authenticatedApp: true,
        caseStatus: "resolved",
        category: "Filter",
        manufacturer: "Pentair",
        model: "Clean & Clear Plus",
        issue: "High filter pressure after backwashing",
        answer: "Tear down filter and soak cartridges in TSP/detergent solution to remove oils.",
        caseLearningOptIn: true
      },
      authenticatedUserId: "usr_consented_tech",
      authenticatedCompanyId: "comp_opted_out",
      authenticatedRole: "technician"
    });

    assert.equal(resCompanyOptedOut.status, 200);
    assert.equal(resCompanyOptedOut.data.learningStatus, "company_private");
    const capturedCase3 = harness.store.diagnostic_cases.get(resCompanyOptedOut.data.caseId);
    assert.equal(capturedCase3.case_learning_opt_in, true);
    assert.equal(harness.store.learning_review_queue.size, 1);
    console.log("PASS: Test 3c - Governing company opt-out keeps records private even when contributor consents.");
  }

  // -------------------------------------------------------------------------
  // Test 4: Server-Side Contributor Terms Verification in save_technician_job (P0 D)
  // -------------------------------------------------------------------------
  {
    const harness = createHarness();

    // 4a: Technician saves job notes with caseLearningOptIn: true, but has NO contributor terms accepted
    const resNoLegalJob = await harness.executeAction("save_technician_job", {
      body: {
        authenticatedApp: true,
        outcome: "resolved",
        equipmentCategory: "Pump",
        manufacturer: "Pentair",
        model: "IntelliFlo VSF",
        complaint: "Pump not priming",
        resolution: "Cleaned diffuser and replaced shaft seal.",
        repairSteps: [{ action: "Replaced shaft seal", result: "Primes in 30 seconds" }],
        caseLearningOptIn: true // Browser checked box without legal terms on file!
      },
      authenticatedUserId: "usr_unaccepted_tech",
      authenticatedCompanyId: "comp_opted_in",
      authenticatedRole: "technician",
      authenticatedPermissions: { canEditJobNotes: true }
    });

    assert.equal(resNoLegalJob.status, 200);
    assert.equal(resNoLegalJob.data.ok, true);
    assert.ok(harness.store.technician_job_records.size > 0, "Job record must always be saved for company operations");
    // Find diagnostic case created by save_technician_job
    const createdCases = [...harness.store.diagnostic_cases.values()];
    const jobCase1 = createdCases.find(c => c.tenant_id === "comp_opted_in");
    assert.ok(jobCase1, "Diagnostic case must be saved");
    assert.equal(jobCase1.case_learning_opt_in, false, "Server MUST reject sharing opt-in when contributor terms record is absent");
    assert.equal(jobCase1.learning_terms_version, null, "Terms version must be null");
    assert.equal(harness.store.learning_review_queue.size, 0, "Unverified contributor job must NOT enter review queue");
    console.log("PASS: Test 4a - Technician job sharing fails closed to company-private when contributor terms absent (P0 D verified).");

    // 4b: Technician has valid contributor terms on file and company is opted in
    const resConsentedJob = await harness.executeAction("save_technician_job", {
      body: {
        authenticatedApp: true,
        outcome: "resolved",
        equipmentCategory: "Pump",
        manufacturer: "Pentair",
        model: "IntelliFlo VSF",
        complaint: "Pump not priming",
        resolution: "Cleaned diffuser and replaced shaft seal.",
        repairSteps: [{ action: "Replaced shaft seal", result: "Primes in 30 seconds" }],
        caseLearningOptIn: true
      },
      authenticatedUserId: "usr_consented_tech",
      authenticatedCompanyId: "comp_opted_in",
      authenticatedRole: "technician",
      authenticatedPermissions: { canEditJobNotes: true }
    });

    assert.equal(resConsentedJob.status, 200);
    const jobCase2 = [...harness.store.diagnostic_cases.values()].pop();
    assert.equal(jobCase2.case_learning_opt_in, true);
    assert.equal(jobCase2.learning_terms_version, "2026-10-v1");
    assert.equal(harness.store.learning_review_queue.size, 1, "Verified job enters review queue");
    console.log("PASS: Test 4b - Verified technician job with active terms enters review queue.");

    // 4c: Technician has valid terms, but company is OPTED OUT
    const resCompanyOptedOutJob = await harness.executeAction("save_technician_job", {
      body: {
        authenticatedApp: true,
        outcome: "resolved",
        equipmentCategory: "Heater",
        manufacturer: "Raypak",
        model: "266A",
        complaint: "Heater won't fire",
        resolution: "Replaced igniter.",
        repairSteps: [{ action: "Replaced igniter", result: "Fires cleanly" }],
        caseLearningOptIn: true
      },
      authenticatedUserId: "usr_consented_tech",
      authenticatedCompanyId: "comp_opted_out", // diagnostic_learning_opt_in = false
      authenticatedRole: "technician",
      authenticatedPermissions: { canEditJobNotes: true }
    });

    assert.equal(resCompanyOptedOutJob.status, 200);
    const jobCase3 = [...harness.store.diagnostic_cases.values()].pop();
    assert.equal(jobCase3.case_learning_opt_in, true);
    // Queue should still only have 1 item from 4b
    assert.equal(harness.store.learning_review_queue.size, 1, "Opted-out company job must not enter review queue");
    console.log("PASS: Test 4c - Company opt-out prevents job from entering review queue even when technician consented.");
  }

  // -------------------------------------------------------------------------
  // Test 5: Explicit Case Consent Withdrawal
  // -------------------------------------------------------------------------
  {
    const harness = createHarness();
    const caseId = "case_withdraw_test_1";
    const queueId = "queue_withdraw_test_1";

    harness.store.diagnostic_cases.set(caseId, {
      id: caseId,
      tenant_id: "comp_opted_in",
      case_learning_opt_in: true,
      equipment_category: "Heater"
    });
    harness.store.learning_review_queue.set(queueId, {
      id: queueId,
      case_id: caseId,
      tenant_id: "comp_opted_in",
      source_kind: "authenticated_troubleshooter",
      status: "pending",
      proposed_lesson_redacted: "Lesson about heater manifold replacement"
    });

    const resWithdraw = await harness.executeAction("withdraw_case_learning_consent", {
      body: { authenticatedApp: true, caseId },
      authenticatedUserId: "usr_consented_tech",
      authenticatedCompanyId: "comp_opted_in",
      authenticatedRole: "technician"
    });

    assert.equal(resWithdraw.status, 200);
    assert.equal(resWithdraw.data.ok, true);
    assert.equal(resWithdraw.data.status, "consent_withdrawn");
    assert.equal(harness.store.diagnostic_cases.get(caseId).case_learning_opt_in, false);
    console.log("PASS: Test 5 - Explicit consent withdrawal successfully updates database records.");
  }

  console.log("\nALL LEARNING CONSENT & FAIL-CLOSED APPROVAL TESTS PASSED.");
}

runLearningConsentTests().catch(err => {
  console.error("FAIL in learning consent tests:", err);
  process.exit(1);
});
