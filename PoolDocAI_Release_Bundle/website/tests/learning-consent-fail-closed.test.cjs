const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const handlerSource = fs.readFileSync(path.join(root, "supabase", "functions", "clever-handler", "index.ts"), "utf8");

// Extract the review_learning_case block
function stripTs(code) {
  return code
    .replace(/:\s*string\s*\|\s*null/g, "")
    .replace(/:\s*boolean\s*\|\s*null/g, "")
    .replace(/:\s*number\s*\|\s*null/g, "")
    .replace(/:\s*string\[\]/g, "")
    .replace(/:\s*string\b/g, "")
    .replace(/:\s*boolean\b/g, "")
    .replace(/:\s*number\b/g, "")
    .replace(/:\s*Record<[^>]+>/g, "");
}

const reviewMatch = handlerSource.match(/if\s*\(\["review_learning_case",\s*"list_learning_review_queue"\]\.includes\(action\)\)\s*\{([\s\S]*?)\n\s*\}\s*\n\s*\/\/\s*Technician job records/);
assert.ok(reviewMatch, "Found review_learning_case block in clever-handler");
let reviewCode = stripTs(reviewMatch[1]);

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
          const comp = store.companies.get(caseRow.tenant_id);
          if (!comp || !comp.diagnostic_learning_opt_in) return { error: { message: "Governing company diagnostic learning opt-in is required" } };
        } else {
          // Public demo consent check
          const hasCaseConsent = Boolean(caseRow.case_learning_opt_in || (caseRow.learning_permission_granted && caseRow.legal_terms_version));
          if (!hasCaseConsent) return { error: { message: "Public demo case-level learning consent was not granted or was withdrawn" } };
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

        insert(record) {
          if (table === "diagnostic_cases") {
            const id = record.id || `case_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const row = { id, ...record };
            store.diagnostic_cases.set(id, row);
            return {
              select() {
                return {
                  single: async () => ({ data: { id, ...row }, error: null })
                };
              }
            };
          }
          if (table === "diagnostic_case_steps") {
            store.diagnostic_case_steps.push(record);
            return Promise.resolve({ data: null, error: null });
          }
          if (table === "learning_review_queue") {
            const id = record.id || `queue_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
            const row = { id, ...record };
            store.learning_review_queue.set(id, row);
            return Promise.resolve({ data: null, error: null });
          }
          if (table === "shared_learning_knowledge") {
            const id = record.source_queue_id || `slk_${Date.now()}`;
            store.shared_learning_knowledge.set(id, record);
            return Promise.resolve({ data: null, error: null });
          }
          if (table === "learning_review_audit") {
            store.learning_review_audit.push(record);
            return Promise.resolve({ data: null, error: null });
          }
          throw new Error(`Unexpected insert table: ${table}`);
        },

        update(updates) {
          const chain = {
            eq(col, val) {
              if (table === "learning_review_queue") {
                for (const item of store.learning_review_queue.values()) {
                  if (item[col] === val || item.id === val) Object.assign(item, updates);
                }
              } else if (table === "diagnostic_cases") {
                const existing = store.diagnostic_cases.get(val);
                if (existing) Object.assign(existing, updates);
              }
              return chain;
            },
            then(resolve, reject) {
              return Promise.resolve({ data: null, error: null }).then(resolve, reject);
            }
          };
          return chain;
        },

        delete() {
          const chain = {
            eq(col, val) {
              if (table === "shared_learning_knowledge") {
                for (const [id, item] of store.shared_learning_knowledge.entries()) {
                  if (item[col] === val || item.source_case_id === val || item.source_queue_id === val || id === val) {
                    store.shared_learning_knowledge.delete(id);
                  }
                }
              }
              return chain;
            },
            then(resolve, reject) {
              return Promise.resolve({ data: null, error: null }).then(resolve, reject);
            }
          };
          return chain;
        }
      };
    }
  };

  return {
    store,
    setRpcOverride: (fn) => { rpcOverride = fn; },
    executeAction: async (action, { body = {}, authenticatedUserId = "usr_platform_admin_1", authenticatedCompanyId = null, authenticatedRole = "platform_admin" }) => {
      let codeToRun = "";
      if (action === "review_learning_case") codeToRun = reviewCode;
      else if (action === "capture_learning_case") codeToRun = captureCode;
      else if (action === "withdraw_case_learning_consent") codeToRun = withdrawCode;
      else throw new Error(`Unknown action for test: ${action}`);

      const sandbox = {
        action,
        body,
        authenticatedUserId,
        authenticatedCompanyId,
        authenticatedRole,
        supabase: mockSupabase,
        scrubPII,
        textValue,
        jsonResponse: (data, status = 200) => ({ data, status }),
        console
      };

      const script = new vm.Script(`(async () => {\n${codeToRun}\n})()`);
      const context = vm.createContext(sandbox);
      return await script.runInContext(context);
    }
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

    // Must return 500 APPROVAL_TRANSACTION_FAILED
    assert.equal(res.status, 500);
    assert.equal(res.data.code, "APPROVAL_TRANSACTION_FAILED");

    // CRITICAL SECURITY ASSERTION: No direct publication fallback permitted!
    assert.equal(harness.store.shared_learning_knowledge.size, 0, "No row should be published to shared_learning_knowledge");
    
    // The review queue item status must remain 'pending' and NOT 'approved'
    assert.equal(harness.store.learning_review_queue.get(queueId).status, "pending");
    console.log("PASS: Test 1 - Learning approval fails closed with 500 when RPC errors; direct publication fallback blocked.");
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
      case_learning_opt_in: false, // legacy flag pattern
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
      proposed_lesson_redacted: "Unconsented visitor troubleshooting lesson that must never publish."
    });

    const resUnconsented = await harness.executeAction("review_learning_case", {
      body: {
        authenticatedApp: true,
        queueId: unconsentedQueueId,
        decision: "approve",
        editedLesson: "Unconsented visitor troubleshooting lesson that must never publish."
      },
      authenticatedUserId: "usr_platform_admin_1"
    });

    assert.equal(resUnconsented.status, 403);
    assert.equal(resUnconsented.data.code, "CASE_LEARNING_OPT_IN_REQUIRED");
    assert.equal(harness.store.shared_learning_knowledge.has(unconsentedQueueId), false);
    console.log("PASS: Test 2b - Unconsented public demo case is strictly blocked from approval.");
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
        caseLearningOptIn: true, // Client asserts consent!
        learningTermsVersion: "client-faked-v999" // Client supplied string
      },
      authenticatedUserId: "usr_unaccepted_tech", // No terms accepted in store
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
      authenticatedCompanyId: "comp_opted_out", // diagnostic_learning_opt_in = false
      authenticatedRole: "technician"
    });

    assert.equal(resCompanyOptedOut.status, 200);
    assert.equal(resCompanyOptedOut.data.learningStatus, "company_private");
    const capturedCase3 = harness.store.diagnostic_cases.get(resCompanyOptedOut.data.caseId);
    assert.equal(capturedCase3.case_learning_opt_in, true);
    // Queue should still only have 1 item (from 3b), not increased
    assert.equal(harness.store.learning_review_queue.size, 1);
    console.log("PASS: Test 3c - Governing company opt-out keeps records private even when contributor consents.");
  }

  // -------------------------------------------------------------------------
  // Test 4: Explicit Case Consent Withdrawal
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
    console.log("PASS: Test 4 - Explicit consent withdrawal successfully updates database records.");
  }

  console.log("\nALL LEARNING CONSENT & FAIL-CLOSED APPROVAL TESTS PASSED.");
}

runLearningConsentTests().catch(err => {
  console.error("FAIL in learning consent tests:", err);
  process.exit(1);
});
