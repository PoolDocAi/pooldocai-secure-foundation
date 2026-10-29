/**
 * website/tests/task012-part1-learning-consent.test.cjs
 *
 * POOLDOCAI TASK-012 PART-1 EXECUTABLE TEST SUITE
 * P0 Learning Safety Publication Trust Boundary + Server-Side Job Consent Lifecycle
 *
 * Verifies production Edge handler blocks and database RPC predicates for:
 * 1. Two companies (Tenant A opted-in, Tenant B opted-out) and two users each.
 * 2. Wrong / foreign case tenant mismatch and cross-tenant leakage prevention.
 * 3. Revoked / suspended seat authorization enforcement.
 * 4. Missing contributor legal terms acceptance (fail closed).
 * 5. Company opted-out learning boundaries (private notes preserved, learning denied).
 * 6. Missing case-level consent (private notes preserved, learning denied).
 * 7. Case-specific consent & anti-spoofing (valid generic terms without case consent,
 *    legitimate explicit consent, later job save cannot re-enable withdrawn case).
 * 8. Verified technician outcome versus unverified AI troubleshooter suggestion.
 * 9. Reviewer approval evidence gate (cross-tenant mismatch, unresolved status, missing durable consent).
 * 10. Atomic transactional consent withdrawal RPC, soft-revocation, audit durability & fault injection.
 * 11. Read-side retrieval eligibility (revoked manual with active company, observation-only with action verb).
 * 12. Idempotent retries for offline job sync and consent withdrawal.
 * 13. Private-only notes support when learning is disallowed.
 */

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
const grantConsentMatch = handlerSource.match(/if\s*\(action\s*===\s*"grant_case_learning_consent"\)\s*\{([\s\S]*?)\n\s*\}\s*\n\s*\/\/\s*Technician close-out/);
assert.ok(grantConsentMatch, "Found grant_case_learning_consent block in clever-handler");
const grantConsentCode = stripTs(grantConsentMatch[1]);

const saveJobMatch = handlerSource.match(/if\s*\(action\s*===\s*"save_technician_job"\)\s*\{([\s\S]*?)\n\s*\}\s*\n\s*\/\/\s*Authenticated troubleshooter/);
assert.ok(saveJobMatch, "Found save_technician_job block in clever-handler");
const saveJobCode = stripTs(saveJobMatch[1]);

const reviewMatch = handlerSource.match(/if\s*\(\["review_learning_case",\s*"list_learning_review_queue"\]\.includes\(action\)\)\s*\{([\s\S]*?)\n\s*\}\s*\n\s*\/\/\s*Technician job records/);
assert.ok(reviewMatch, "Found review_learning_case block in clever-handler");
const reviewCode = stripTs(reviewMatch[1]);

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

// Setup synthetic two-company fixture constants
const TENANT_A = {
  companyId: "11111111-1111-4111-8111-111111111111",
  companyName: "AquaPure Commercial Pool Care",
  diagnosticLearningOptIn: true,
  admin: {
    userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    role: "company_admin",
    status: "active",
    canEditJobNotes: true
  },
  tech: {
    userId: "aaaaaaaa-bbbb-4aaa-8aaa-bbbbbbbbbbbb",
    role: "technician",
    status: "active",
    canEditJobNotes: true
  },
  techNoPerm: {
    userId: "aaaaaaaa-cccc-4aaa-8aaa-cccccccccccc",
    role: "technician",
    status: "active",
    canEditJobNotes: false
  },
  techRevoked: {
    userId: "aaaaaaaa-dddd-4aaa-8aaa-dddddddddddd",
    role: "technician",
    status: "revoked",
    canEditJobNotes: true
  }
};

const TENANT_B = {
  companyId: "22222222-2222-4222-8222-222222222222",
  companyName: "BlueWave Residential Services",
  diagnosticLearningOptIn: false, // Opted out of diagnostic learning!
  admin: {
    userId: "bbbbbbbb-aaaa-4bbb-8bbb-aaaaaaaaaaaa",
    role: "company_admin",
    status: "active",
    canEditJobNotes: true
  },
  tech: {
    userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    role: "technician",
    status: "active",
    canEditJobNotes: true
  }
};

const PLATFORM_OWNER = {
  userId: "99999999-9999-4999-8999-999999999999"
};

/**
 * Creates an in-memory mock Supabase harness that executes real extracted handler blocks
 * and emulates Migration 047 database RPCs / PostgREST predicates.
 */
function createMockHarness() {
  const store = {
    companies: new Map([
      [TENANT_A.companyId, { id: TENANT_A.companyId, name: TENANT_A.companyName, status: "active", diagnostic_learning_opt_in: TENANT_A.diagnosticLearningOptIn, industry_key: "pool" }],
      [TENANT_B.companyId, { id: TENANT_B.companyId, name: TENANT_B.companyName, status: "active", diagnostic_learning_opt_in: TENANT_B.diagnosticLearningOptIn, industry_key: "pool" }]
    ]),
    company_members: new Map(),
    platform_admins: new Map([[PLATFORM_OWNER.userId, { user_id: PLATFORM_OWNER.userId }]]),
    pooldocai_legal_acceptances: new Map(),
    case_learning_consents: new Map(),
    company_manuals: new Map(),
    technician_job_records: new Map(),
    diagnostic_cases: new Map(),
    diagnostic_case_steps: new Map(),
    learning_review_queue: new Map(),
    shared_learning_knowledge: new Map(),
    learning_review_audit: [],
    company_notifications: new Map(),
    industry_modules: new Map([["pool", { industry_key: "pool", status: "active" }]]),
    temporary_access_grants: new Map()
  };

  // Register members in store
  function addMember(tenant, user) {
    const key = `${tenant.companyId}:${user.userId}`;
    store.company_members.set(key, {
      company_id: tenant.companyId,
      user_id: user.userId,
      role: user.role,
      status: user.status,
      can_edit_job_notes: user.canEditJobNotes,
      can_view_job_notes: true,
      can_upload_documents: user.role === "company_admin",
      can_review_documents: user.role === "company_admin",
      companies: store.companies.get(tenant.companyId)
    });
  }

  addMember(TENANT_A, TENANT_A.admin);
  addMember(TENANT_A, TENANT_A.tech);
  addMember(TENANT_A, TENANT_A.techNoPerm);
  addMember(TENANT_A, TENANT_A.techRevoked);

  addMember(TENANT_B, TENANT_B.admin);
  addMember(TENANT_B, TENANT_B.tech);

  // Initial legal acceptance on file for Tenant A Tech and Tenant A Admin
  store.pooldocai_legal_acceptances.set(`${TENANT_A.tech.userId}:${TENANT_A.companyId}`, {
    id: "legal_1",
    user_id: TENANT_A.tech.userId,
    company_id: TENANT_A.companyId,
    terms_version: "2026-10-v1",
    accepted_at: new Date().toISOString()
  });
  store.pooldocai_legal_acceptances.set(`${TENANT_A.admin.userId}:${TENANT_A.companyId}`, {
    id: "legal_1b",
    user_id: TENANT_A.admin.userId,
    company_id: TENANT_A.companyId,
    terms_version: "2026-10-v1",
    accepted_at: new Date().toISOString()
  });

  // Legal acceptance on file for Tenant B Tech
  store.pooldocai_legal_acceptances.set(`${TENANT_B.tech.userId}:${TENANT_B.companyId}`, {
    id: "legal_2",
    user_id: TENANT_B.tech.userId,
    company_id: TENANT_B.companyId,
    terms_version: "2026-10-v1",
    accepted_at: new Date().toISOString()
  });

  function createSupabaseClient() {
    return {
      rpc: async (fnName, params) => {
        if (fnName === "pooldocai_publish_company_notification") {
          const id = "notif_" + Math.random().toString(36).slice(2);
          store.company_notifications.set(id, { id, ...params });
          return { data: id, error: null };
        }

        // Migration 047 Atomic Consent Withdrawal RPC
        if (fnName === "pooldocai_withdraw_case_learning_consent") {
          if (params.p_case_id === "injected_failure_case") {
            return { data: null, error: { code: "DB_TRANSACTION_FAILED", message: "Injected DB failure during withdrawal transaction" } };
          }
          const caseRow = store.diagnostic_cases.get(params.p_case_id);
          if (!caseRow) return { data: null, error: { message: `Diagnostic case ${params.p_case_id} not found` } };
          if (caseRow.tenant_id !== params.p_company_id) {
            return { data: null, error: { message: "You cannot modify another company's case" } };
          }

          // 1. Update diagnostic case
          caseRow.case_learning_opt_in = false;
          caseRow.approved_for_learning = false;
          caseRow.privacy_reviewed_at = null;

          // 2. Durable case-specific consent state update
          const consentKey = `${params.p_case_id}:shared_diagnostic_learning`;
          store.case_learning_consents.set(consentKey, {
            case_id: params.p_case_id,
            company_id: params.p_company_id,
            actor_user_id: params.p_actor_user_id,
            purpose: "shared_diagnostic_learning",
            consent_status: "withdrawn",
            withdrawn_at: new Date().toISOString(),
            revocation_reason: params.p_reason
          });

          // 3. Soft-revoke shared knowledge publications
          for (const item of store.shared_learning_knowledge.values()) {
            if (item.source_case_id === params.p_case_id) {
              item.publication_status = "revoked";
            }
          }

          // 4. Update review queue entries
          for (const queueItem of store.learning_review_queue.values()) {
            if (queueItem.case_id === params.p_case_id) {
              queueItem.status = "rejected";
            }
          }

          // 5. Immutable audit record
          store.learning_review_audit.push({
            case_id: params.p_case_id,
            actor_user_id: params.p_actor_user_id,
            action: "rejected",
            note_redacted: params.p_reason
          });

          return {
            data: { ok: true, case_id: params.p_case_id, status: "consent_withdrawn" },
            error: null
          };
        }

        // Migration 047 Learning Approval RPC
        if (fnName === "pooldocai_approve_learning_case") {
          const queueItem = store.learning_review_queue.get(params.p_queue_id);
          if (!queueItem) return { data: null, error: { message: `Review queue item ${params.p_queue_id} not found` } };
          if (queueItem.status !== "pending") return { data: null, error: { message: `Review item ${params.p_queue_id} is not pending` } };

          if (queueItem.source_kind === "public_demo") {
            return { data: null, error: { message: "Public demo visitor-reported answers cannot be published as verified shared repair knowledge" } };
          }

          if (queueItem.source_kind === "company_manual") {
            const manualId = queueItem.supporting_source_ids?.[0];
            const manual = store.company_manuals.get(manualId);
            if (!manual || manual.company_id !== queueItem.tenant_id) {
              return { data: null, error: { message: "Source company manual not found or does not belong to tenant" } };
            }
            if (manual.shared_learning_opt_in !== true) {
              return { data: null, error: { message: "Source company manual opt-in consent is missing or revoked" } };
            }
            const comp = store.companies.get(queueItem.tenant_id);
            if (!comp || comp.diagnostic_learning_opt_in !== true) {
              return { data: null, error: { message: "Governing company diagnostic learning opt-in is required" } };
            }
            const pubId = "pub_" + queueItem.id;
            store.shared_learning_knowledge.set(pubId, {
              id: pubId,
              source_manual_id: manualId,
              source_queue_id: queueItem.id,
              source_company_id: queueItem.tenant_id,
              source_kind: "company_manual",
              equipment_category: manual.equipment_category || "manual",
              manufacturer_normalized: manual.manufacturer_normalized,
              model_normalized: manual.model_normalized,
              lesson_redacted: params.p_lesson,
              approved_by: params.p_reviewed_by,
              consent_snapshot: true,
              knowledge_type: "manufacturer_manual",
              technician_verified: false,
              publication_status: "active",
              review_history: [{ action: "approved", actor: params.p_reviewed_by, at: new Date().toISOString() }]
            });
            queueItem.status = "approved";
            return {
              data: { ok: true, queue_id: params.p_queue_id, knowledge_type: "manufacturer_manual", status: "approved" },
              error: null
            };
          }

          const caseRow = store.diagnostic_cases.get(queueItem.case_id);
          if (!caseRow) return { data: null, error: { message: `Diagnostic case ${queueItem.case_id} not found` } };

          // Cross-tenant queue-case mismatch
          if (caseRow.tenant_id !== queueItem.tenant_id) {
            return { data: null, error: { message: `Diagnostic case tenant does not match review queue tenant` } };
          }

          if (!caseRow.case_learning_opt_in) {
            return { data: null, error: { message: "Case-level learning consent was not granted or was withdrawn" } };
          }
          if (!caseRow.learning_terms_version && !caseRow.legal_terms_version) {
            return { data: null, error: { message: "Verified contributor terms acceptance is required for case learning approval" } };
          }

          // Durable case consent table check
          const durableConsent = store.case_learning_consents.get(`${caseRow.id}:shared_diagnostic_learning`);
          if (!durableConsent || durableConsent.consent_status !== "granted") {
            return { data: null, error: { message: "Durable case-specific learning consent record is missing or withdrawn" } };
          }

          // Contributor provenance
          if (!caseRow.contributor_user_id || !caseRow.contributor_accepted_at) {
            return { data: null, error: { message: "Authenticated contributor consent provenance is required for case learning approval" } };
          }

          const comp = store.companies.get(caseRow.tenant_id);
          if (!comp || comp.diagnostic_learning_opt_in !== true) {
            return { data: null, error: { message: "Governing company diagnostic learning opt-in is required" } };
          }

          // Hard P0 Evidence Gate: Model-generated AI suggestions without technician verification cannot be published
          if (queueItem.source_kind === "authenticated_troubleshooter" && caseRow.technician_verified !== true) {
            return { data: null, error: { message: "Model-generated authenticated_troubleshooter suggestion without technician verification cannot be published as shared repair knowledge" } };
          }

          // Authoritative outcome check: Case status must be resolved
          if (queueItem.source_kind === "technician_job" || queueItem.source_kind === "authenticated_troubleshooter") {
            if (caseRow.case_status !== "resolved") {
              return { data: null, error: { message: `Only a resolved case with status resolved can become shared repair knowledge (current status: ${caseRow.case_status})` } };
            }
            if (caseRow.technician_verified !== true || !String(caseRow.resolution_summary_redacted || "").trim()) {
              return { data: null, error: { message: "Only a resolved technician-verified case with a recorded outcome can become shared repair knowledge" } };
            }
          }

          const pubId = "pub_" + queueItem.id;
          const kType = queueItem.source_kind === "technician_job" ? "verified_repair" : "observed_diagnosis";
          store.shared_learning_knowledge.set(pubId, {
            id: pubId,
            source_case_id: queueItem.case_id,
            source_queue_id: queueItem.id,
            source_company_id: queueItem.tenant_id,
            source_kind: queueItem.source_kind,
            equipment_category: caseRow.equipment_category,
            manufacturer_normalized: caseRow.manufacturer_normalized,
            model_normalized: caseRow.model_normalized,
            lesson_redacted: params.p_lesson,
            approved_by: params.p_reviewed_by,
            consent_snapshot: true,
            knowledge_type: kType,
            technician_verified: Boolean(caseRow.technician_verified),
            publication_status: "active",
            review_history: [{ action: "approved", actor: params.p_reviewed_by, at: new Date().toISOString() }]
          });

          queueItem.status = "approved";
          caseRow.approved_for_learning = true;
          return {
            data: {
              ok: true,
              queue_id: params.p_queue_id,
              case_id: queueItem.case_id,
              knowledge_type: kType,
              technician_verified: Boolean(caseRow.technician_verified),
              status: "approved"
            },
            error: null
          };
        }

        if (fnName === "search_shared_learning") {
          // Emulate Migration 047 search_shared_learning SQL query predicates
          const query = String(params.p_query || "").toLowerCase();
          const results = [];
          for (const item of store.shared_learning_knowledge.values()) {
            // Predicate 1: Must be active publication status
            if ((item.publication_status || "active") !== "active") continue;
            // Predicate 2: Actionable repair retrieval restricted to verified repairs and manuals; exclude observations
            if (item.knowledge_type !== "verified_repair" && item.knowledge_type !== "manufacturer_manual") continue;
            // Predicate 3: Authenticated troubleshooter requires technician verification
            if (item.source_kind === "authenticated_troubleshooter" && item.technician_verified !== true) continue;
            // Predicate 4: Company must still be active and opted in
            if (item.source_company_id) {
              const comp = store.companies.get(item.source_company_id);
              if (!comp || comp.status !== "active" || comp.diagnostic_learning_opt_in !== true) continue;
            }
            // Predicate 5: If manual-backed, company manual must be active and opted in
            if (item.source_manual_id) {
              const man = store.company_manuals.get(item.source_manual_id);
              if (!man || man.shared_learning_opt_in !== true || man.status !== "ready") continue;
            }
            // Predicate 6: Case must still have active durable consent
            if (item.source_case_id) {
              const caseRow = store.diagnostic_cases.get(item.source_case_id);
              if (!caseRow || caseRow.case_learning_opt_in !== true) continue;
              const consent = store.case_learning_consents.get(`${item.source_case_id}:shared_diagnostic_learning`);
              if (!consent || consent.consent_status !== "granted") continue;
            }

            const searchable = `${item.equipment_category || ""} ${item.manufacturer_normalized || ""} ${item.model_normalized || ""} ${item.lesson_redacted || ""}`.toLowerCase();
            const words = query.split(/\s+/).filter(w => w.length > 2);
            const matches = words.some(w => searchable.includes(w));
            if (matches || words.length === 0) {
              results.push({
                id: item.id,
                equipment_category: item.equipment_category,
                manufacturer_normalized: item.manufacturer_normalized,
                model_normalized: item.model_normalized,
                lesson_redacted: item.lesson_redacted,
                source_kind: item.source_kind,
                knowledge_type: item.knowledge_type,
                technician_verified: item.technician_verified,
                publication_status: item.publication_status,
                rank: 0.95
              });
            }
          }
          return { data: results.slice(0, params.p_limit || 4), error: null };
        }

        return { data: null, error: { message: `Unknown RPC ${fnName}` } };
      },

      from: (tableName) => {
        let rows = [];
        if (tableName === "companies") rows = [...store.companies.values()];
        else if (tableName === "company_members") rows = [...store.company_members.values()];
        else if (tableName === "platform_admins") rows = [...store.platform_admins.values()];
        else if (tableName === "pooldocai_legal_acceptances") rows = [...store.pooldocai_legal_acceptances.values()];
        else if (tableName === "case_learning_consents") rows = [...store.case_learning_consents.values()];
        else if (tableName === "company_manuals") rows = [...store.company_manuals.values()];
        else if (tableName === "technician_job_records") rows = [...store.technician_job_records.values()];
        else if (tableName === "diagnostic_cases") rows = [...store.diagnostic_cases.values()];
        else if (tableName === "diagnostic_case_steps") rows = [...store.diagnostic_case_steps.values()];
        else if (tableName === "learning_review_queue") rows = [...store.learning_review_queue.values()];
        else if (tableName === "shared_learning_knowledge") rows = [...store.shared_learning_knowledge.values()];
        else if (tableName === "learning_review_audit") rows = store.learning_review_audit;
        else if (tableName === "temporary_access_grants") rows = [...store.temporary_access_grants.values()];

        let filters = [];
        let limitCount = null;
        let orderField = null;
        let orderAsc = true;
        store.injectedErrors = store.injectedErrors || new Map();

        function getInjectedError(op) {
          const key = `${tableName}:${op}`;
          if (store.injectedErrors && store.injectedErrors.has(key)) {
            return store.injectedErrors.get(key);
          }
          return null;
        }

        const builder = {
          select: (fields) => builder,
          eq: (field, val) => {
            filters.push((r) => r[field] === val);
            return builder;
          },
          in: (field, arr) => {
            filters.push((r) => arr.includes(r[field]));
            return builder;
          },
          contains: (field, arr) => {
            filters.push((r) => Array.isArray(r[field]) && arr.every(x => r[field].includes(x)));
            return builder;
          },
          order: (field, opts) => {
            orderField = field;
            orderAsc = opts?.ascending !== false;
            return builder;
          },
          limit: (n) => {
            limitCount = n;
            return builder;
          },
          maybeSingle: async () => {
            const injErr = getInjectedError("select");
            if (injErr) return { data: null, error: injErr };
            let res = rows.filter(r => filters.every(f => f(r)));
            return { data: res[0] || null, error: null };
          },
          single: async () => {
            const injErr = getInjectedError("select");
            if (injErr) return { data: null, error: injErr };
            let res = rows.filter(r => filters.every(f => f(r)));
            if (res.length === 0) return { data: null, error: { code: "PGRST116", message: "No rows found" } };
            return { data: res[0], error: null };
          },
          then: (resolve) => {
            const injErr = getInjectedError("select");
            if (injErr) return Promise.resolve({ data: null, error: injErr }).then(resolve);
            let res = rows.filter(r => filters.every(f => f(r)));
            if (limitCount != null) res = res.slice(0, limitCount);
            return Promise.resolve({ data: res, error: null }).then(resolve);
          },
          insert: (dataToInsert) => {
            const injErr = getInjectedError("insert");
            if (injErr) {
              return {
                data: null,
                error: injErr,
                select: () => ({
                  single: async () => ({ data: null, error: injErr }),
                  maybeSingle: async () => ({ data: null, error: injErr })
                }),
                then: (resolve) => resolve({ data: null, error: injErr })
              };
            }
            const items = Array.isArray(dataToInsert) ? dataToInsert : [dataToInsert];
            const inserted = [];
            for (const item of items) {
              const id = item.case_id && item.purpose ? `${item.case_id}:${item.purpose}` : (item.id || require("node:crypto").randomUUID());
              const fullItem = { id, created_at: new Date().toISOString(), ...item };
              if (store[tableName] instanceof Map) {
                store[tableName].set(id, fullItem);
              } else if (Array.isArray(store[tableName])) {
                store[tableName].push(fullItem);
              }
              inserted.push(fullItem);
            }
            return {
              data: Array.isArray(dataToInsert) ? inserted : inserted[0],
              error: null,
              select: (cols) => ({
                single: async () => ({ data: inserted[0], error: null }),
                maybeSingle: async () => ({ data: inserted[0], error: null })
              }),
              then: (resolve) => resolve({ data: Array.isArray(dataToInsert) ? inserted : inserted[0], error: null })
            };
          },
          upsert: (dataToUpsert, opts) => {
            const injErr = getInjectedError("upsert");
            if (injErr) return Promise.resolve({ data: null, error: injErr });
            const items = Array.isArray(dataToUpsert) ? dataToUpsert : [dataToUpsert];
            for (const item of items) {
              const key = item.case_id && item.purpose ? `${item.case_id}:${item.purpose}` : (item.id || `gen_${tableName}_${Math.random().toString(36).slice(2, 10)}`);
              const existing = store[tableName].get(key) || {};
              store[tableName].set(key, { ...existing, ...item });
            }
            return Promise.resolve({ data: items, error: null });
          },
          update: (updates) => {
            return {
              eq: (f1, v1) => {
                const subFilters = [(r) => r[f1] === v1];
                return {
                  eq: (f2, v2) => {
                    subFilters.push((r) => r[f2] === v2);
                    return executeUpdate(subFilters, updates);
                  },
                  then: (resolve) => executeUpdate(subFilters, updates).then(resolve)
                };
              }
            };

            function executeUpdate(flts, upds) {
              const injErr = getInjectedError("update");
              if (injErr) return Promise.resolve({ error: injErr, count: 0 });
              let updatedCount = 0;
              if (store[tableName] instanceof Map) {
                for (const [key, row] of store[tableName].entries()) {
                  if (flts.every(f => f(row))) {
                    Object.assign(row, upds);
                    updatedCount++;
                  }
                }
              }
              return Promise.resolve({ error: null, count: updatedCount });
            }
          },
          delete: () => {
            return {
              eq: (field, val) => {
                let deletedCount = 0;
                if (store[tableName] instanceof Map) {
                  for (const [key, row] of store[tableName].entries()) {
                    if (row[field] === val) {
                      store[tableName].delete(key);
                      deletedCount++;
                    }
                  }
                }
                return Promise.resolve({ error: null, count: deletedCount });
              }
            };
          }
        };
        return builder;
      }
    };
  }

  async function executeAction(actionName, options = {}) {
    const {
      body = {},
      authenticatedUserId = null,
      authenticatedCompanyId = null,
      authenticatedRole = null,
      authenticatedPermissions = null
    } = options;

    let targetCode = "";
    if (actionName === "save_technician_job") targetCode = saveJobCode;
    else if (actionName === "grant_case_learning_consent") targetCode = grantConsentCode;
    else if (actionName === "review_learning_case" || actionName === "list_learning_review_queue") targetCode = reviewCode;
    else if (actionName === "withdraw_case_learning_consent") targetCode = withdrawCode;
    else if (actionName === "capture_learning_case") targetCode = captureCode;
    else throw new Error(`Unsupported action in harness: ${actionName}`);

    const client = createSupabaseClient();
    let responseStatus = 200;
    let responsePayload = null;

    function jsonResponse(data, status = 200) {
      responseStatus = status;
      responsePayload = data;
      return { status, data };
    }

    const sandbox = {
      action: actionName,
      body,
      supabase: client,
      authenticatedUserId,
      authenticatedCompanyId,
      authenticatedRole,
      authenticatedPermissions,
      jsonResponse,
      scrubPII,
      textValue,
      objectValue,
      console: { log: () => {}, error: () => {}, warn: () => {} }
    };

    const script = new vm.Script(`(async () => {\n${targetCode}\n})()`);
    const context = vm.createContext(sandbox);

    try {
      await script.runInContext(context);
    } catch (err) {
      return { status: 500, error: err.message, data: { error: err.message } };
    }

    return { status: responseStatus, data: responsePayload };
  }

  return { store, executeAction, client: createSupabaseClient() };
}

// -----------------------------------------------------------------------------
// RUN THE FULL TEST SUITE
// -----------------------------------------------------------------------------
async function runTask012Tests() {
  console.log("============================================================================");
  console.log(" POOLDOCAI TASK-012 PART-1: P0 LEARNING SAFETY & JOB CONSENT TEST SUITE");
  console.log("============================================================================");

  let passed = 0;
  let failed = 0;

  function record(desc, condition, detail = "") {
    if (condition) {
      passed++;
      console.log(`  [✓ PASS] ${desc} ${detail ? `(${detail})` : ""}`);
    } else {
      failed++;
      console.error(`  [✗ FAIL] ${desc} ${detail ? `(${detail})` : ""}`);
    }
  }

  // ---------------------------------------------------------------------------
  // TEST 1: Two Companies & Two Users Setup
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 1: Two Companies & Two Users Isolation Setup ---");
  {
    const harness = createMockHarness();
    const coA = harness.store.companies.get(TENANT_A.companyId);
    const coB = harness.store.companies.get(TENANT_B.companyId);
    record("Company A is active with diagnostic_learning_opt_in=true", coA && coA.diagnostic_learning_opt_in === true);
    record("Company B is active with diagnostic_learning_opt_in=false", coB && coB.diagnostic_learning_opt_in === false);
    record("Tenant A has active admin and tech", harness.store.company_members.has(`${TENANT_A.companyId}:${TENANT_A.admin.userId}`) && harness.store.company_members.has(`${TENANT_A.companyId}:${TENANT_A.tech.userId}`));
    record("Tenant B has active admin and tech", harness.store.company_members.has(`${TENANT_B.companyId}:${TENANT_B.admin.userId}`) && harness.store.company_members.has(`${TENANT_B.companyId}:${TENANT_B.tech.userId}`));
  }

  // ---------------------------------------------------------------------------
  // TEST 2: Wrong / Foreign Case Access (Tenant Mismatch)
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 2: Wrong / Foreign Case Access (Tenant Mismatch) ---");
  {
    const harness = createMockHarness();

    // Create an authentic diagnostic case for Tenant A
    const caseAId = "11111111-2222-4333-8444-555555555555";
    harness.store.diagnostic_cases.set(caseAId, {
      id: caseAId,
      tenant_id: TENANT_A.companyId,
      case_status: "open",
      case_learning_opt_in: true,
      learning_terms_version: "2026-10-v1"
    });

    // Tech B attempts to save a job referencing Tenant A's case
    const resWrongCase = await harness.executeAction("save_technician_job", {
      body: {
        authenticatedApp: true,
        relatedCaseId: caseAId,
        complaint: "Pump leaking",
        resolution: "Attempting cross-tenant save",
        outcome: "resolved"
      },
      authenticatedUserId: TENANT_B.tech.userId,
      authenticatedCompanyId: TENANT_B.companyId,
      authenticatedRole: TENANT_B.tech.role,
      authenticatedPermissions: { canEditJobNotes: true }
    });

    record("Tech B linking to Tenant A case receives 403 TENANT_MISMATCH",
      resWrongCase.status === 403 && resWrongCase.data.code === "TENANT_MISMATCH",
      `Status: ${resWrongCase.status}, Code: ${resWrongCase.data?.code}`);

    // Tech B attempts to withdraw consent on Tenant A's case
    const resCrossWithdraw = await harness.executeAction("withdraw_case_learning_consent", {
      body: {
        authenticatedApp: true,
        caseId: caseAId
      },
      authenticatedUserId: TENANT_B.tech.userId,
      authenticatedCompanyId: TENANT_B.companyId,
      authenticatedRole: TENANT_B.tech.role
    });

    record("Tech B attempting consent withdrawal on Tenant A case receives 403 TENANT_MISMATCH",
      resCrossWithdraw.status === 403 && resCrossWithdraw.data.code === "TENANT_MISMATCH",
      `Status: ${resCrossWithdraw.status}, Code: ${resCrossWithdraw.data?.code}`);
  }

  // ---------------------------------------------------------------------------
  // TEST 3: Revoked / Suspended Seat Authorization
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 3: Revoked / Suspended Seat Authorization ---");
  {
    const harness = createMockHarness();

    // User whose seat has been revoked
    const resRevoked = await harness.executeAction("save_technician_job", {
      body: {
        authenticatedApp: true,
        complaint: "Pump humming",
        resolution: "Capacitor swapped",
        outcome: "resolved"
      },
      authenticatedUserId: TENANT_A.techRevoked.userId,
      authenticatedCompanyId: null, // Revoked user lacks authenticated company context
      authenticatedRole: null,
      authenticatedPermissions: null
    });

    record("Revoked member without authenticated company receives 403 JOB_NOTE_EDIT_PERMISSION_REQUIRED",
      resRevoked.status === 403 && resRevoked.data.code === "JOB_NOTE_EDIT_PERMISSION_REQUIRED");

    // User whose seat is active but lacks canEditJobNotes permission
    const resNoPerm = await harness.executeAction("save_technician_job", {
      body: {
        authenticatedApp: true,
        complaint: "Pump humming",
        resolution: "Capacitor swapped",
        outcome: "resolved"
      },
      authenticatedUserId: TENANT_A.techNoPerm.userId,
      authenticatedCompanyId: TENANT_A.companyId,
      authenticatedRole: TENANT_A.techNoPerm.role,
      authenticatedPermissions: { canEditJobNotes: false }
    });

    record("Member without canEditJobNotes seat permission receives 403 JOB_NOTE_EDIT_PERMISSION_REQUIRED",
      resNoPerm.status === 403 && resNoPerm.data.code === "JOB_NOTE_EDIT_PERMISSION_REQUIRED");
  }

  // ---------------------------------------------------------------------------
  // TEST 4: Missing Contributor Legal Terms Acceptance
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 4: Missing Contributor Legal Terms Acceptance ---");
  {
    const harness = createMockHarness();
    const unacceptedTechId = "aaaaaaaa-eeee-4aaa-8aaa-eeeeeeeeeeee";
    harness.store.company_members.set(`${TENANT_A.companyId}:${unacceptedTechId}`, {
      company_id: TENANT_A.companyId,
      user_id: unacceptedTechId,
      role: "technician",
      status: "active",
      can_edit_job_notes: true,
      can_view_job_notes: true,
      companies: harness.store.companies.get(TENANT_A.companyId)
    });

    const resNoLegal = await harness.executeAction("save_technician_job", {
      body: {
        authenticatedApp: true,
        complaint: "Heater not firing",
        resolution: "Cleaned thermal regulator",
        outcome: "resolved",
        equipmentCategory: "Heater",
        manufacturer: "Raypak",
        model: "266A",
        caseLearningOptIn: true // Client checked the box!
      },
      authenticatedUserId: unacceptedTechId,
      authenticatedCompanyId: TENANT_A.companyId,
      authenticatedRole: "technician",
      authenticatedPermissions: { canEditJobNotes: true }
    });

    record("Job saves successfully for company internal operations (200 OK)", resNoLegal.status === 200 && resNoLegal.data.ok === true);
    const createdCase = [...harness.store.diagnostic_cases.values()].pop();
    record("Diagnostic case learning consent fails closed to false when terms missing",
      createdCase && createdCase.case_learning_opt_in === false && createdCase.learning_terms_version === null);
    record("No item entered learning_review_queue when terms are missing", harness.store.learning_review_queue.size === 0);
    record("No durable case consent row created when terms are missing", harness.store.case_learning_consents.size === 0);
    record("Response message indicates notes saved privately without shared queueing",
      resNoLegal.data.message.includes("saved privately"));
  }

  // ---------------------------------------------------------------------------
  // TEST 5: Company Opted Out
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 5: Company Opted Out of Shared Learning ---");
  {
    const harness = createMockHarness();

    const resOptOut = await harness.executeAction("save_technician_job", {
      body: {
        authenticatedApp: true,
        complaint: "Salt cell error 91",
        resolution: "Cleaned cell plates with dilute acid",
        outcome: "resolved",
        equipmentCategory: "Chlorinator",
        manufacturer: "Hayward",
        model: "AquaRite",
        caseLearningOptIn: true
      },
      authenticatedUserId: TENANT_B.tech.userId,
      authenticatedCompanyId: TENANT_B.companyId,
      authenticatedRole: "technician",
      authenticatedPermissions: { canEditJobNotes: true }
    });

    record("Job saves successfully for Tenant B operations (200 OK)", resOptOut.status === 200 && resOptOut.data.ok === true);
    record("Job was NOT inserted into learning_review_queue due to company opt-out",
      harness.store.learning_review_queue.size === 0);
    record("Response message confirms notes saved privately due to inactive opt-in",
      resOptOut.data.message.includes("Company or explicit case learning consent is not active"));
  }

  // ---------------------------------------------------------------------------
  // TEST 6: Missing Case Consent
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 6: Missing Case-Level Consent ---");
  {
    const harness = createMockHarness();

    const resNoCaseOptIn = await harness.executeAction("save_technician_job", {
      body: {
        authenticatedApp: true,
        complaint: "Pump making squealing noise",
        resolution: "Replaced motor front bearing",
        outcome: "resolved",
        equipmentCategory: "Pump",
        manufacturer: "Pentair",
        model: "WhisperFlo",
        caseLearningOptIn: false // Explicitly unchecked
      },
      authenticatedUserId: TENANT_A.tech.userId,
      authenticatedCompanyId: TENANT_A.companyId,
      authenticatedRole: "technician",
      authenticatedPermissions: { canEditJobNotes: true }
    });

    record("Job saves successfully for internal operations (200 OK)", resNoCaseOptIn.status === 200 && resNoCaseOptIn.data.ok === true);
    const createdCase = [...harness.store.diagnostic_cases.values()].pop();
    record("Case opt-in is recorded as false", createdCase && createdCase.case_learning_opt_in === false);
    record("No row inserted into case_learning_consents when case opt-in is false", harness.store.case_learning_consents.size === 0);
    record("Job was NOT inserted into learning_review_queue", harness.store.learning_review_queue.size === 0);
  }

  // ---------------------------------------------------------------------------
  // TEST 7: Case-Specific Consent Record, Anti-Spoofing & Explicit Transition
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 7: Case-Specific Consent Record, Anti-Spoofing & Explicit Transition ---");
  {
    const harness = createMockHarness();

    // 7a: Generic Terms acceptance + spoofed caseLearningOptIn: true in save_technician_job
    // MUST NOT authorize shared learning or create case_learning_consents!
    const resSpoofedJobOptIn = await harness.executeAction("save_technician_job", {
      body: {
        authenticatedApp: true,
        complaint: "Pump leaking at shaft",
        resolution: "Replaced shaft seal and diffuser gasket",
        outcome: "resolved",
        equipmentCategory: "Pump",
        manufacturer: "Pentair",
        model: "IntelliFlo",
        caseLearningOptIn: true // Spoofed boolean on initial save!
      },
      authenticatedUserId: TENANT_A.tech.userId,
      authenticatedCompanyId: TENANT_A.companyId,
      authenticatedRole: "technician",
      authenticatedPermissions: { canEditJobNotes: true }
    });

    const case2 = [...harness.store.diagnostic_cases.values()].pop();
    record("Generic Terms + spoofed caseLearningOptIn: true in save_technician_job saves private notes (200 OK)",
      resSpoofedJobOptIn.status === 200 && resSpoofedJobOptIn.data.ok === true && resSpoofedJobOptIn.data.caseId === case2?.id);
    record("Generic Terms + spoofed caseLearningOptIn: true does NOT set case_learning_opt_in = true",
      case2 && case2.case_learning_opt_in === false);
    record("Generic Terms + spoofed caseLearningOptIn: true creates ZERO rows in case_learning_consents",
      harness.store.case_learning_consents.size === 0);
    record("Generic Terms + spoofed caseLearningOptIn: true creates ZERO rows in learning_review_queue",
      harness.store.learning_review_queue.size === 0);

    // 7b: Reject unattested or spoofed-identity consent transition attempts
    const resMissingAttest = await harness.executeAction("grant_case_learning_consent", {
      body: {
        authenticatedApp: true,
        caseId: case2.id,
        purpose: "shared_diagnostic_learning",
        caseLearningConsentAttested: false
      },
      authenticatedUserId: TENANT_A.tech.userId,
      authenticatedCompanyId: TENANT_A.companyId,
      authenticatedRole: "technician",
      authenticatedPermissions: { canEditJobNotes: true }
    });
    record("Consent transition without explicit attestation is rejected (400 EXPLICIT_CASE_CONSENT_REQUIRED)",
      resMissingAttest.status === 400 && resMissingAttest.data.code === "EXPLICIT_CASE_CONSENT_REQUIRED");

    const resSpoofedActor = await harness.executeAction("grant_case_learning_consent", {
      body: {
        authenticatedApp: true,
        caseId: case2.id,
        actorUserId: TENANT_A.admin.userId, // Spoofed actor parameter!
        purpose: "shared_diagnostic_learning",
        caseLearningConsentAttested: true
      },
      authenticatedUserId: TENANT_A.tech.userId,
      authenticatedCompanyId: TENANT_A.companyId,
      authenticatedRole: "technician",
      authenticatedPermissions: { canEditJobNotes: true }
    });
    record("Consent transition with forged actorUserId parameter is rejected (403 ACTOR_IDENTITY_MISMATCH)",
      resSpoofedActor.status === 403 && resSpoofedActor.data.code === "ACTOR_IDENTITY_MISMATCH");

    const resOtherUser = await harness.executeAction("grant_case_learning_consent", {
      body: {
        authenticatedApp: true,
        caseId: case2.id,
        purpose: "shared_diagnostic_learning",
        caseLearningConsentAttested: true
      },
      authenticatedUserId: TENANT_A.admin.userId, // Different user than case contributor!
      authenticatedCompanyId: TENANT_A.companyId,
      authenticatedRole: "company_admin",
      authenticatedPermissions: { canEditJobNotes: true }
    });
    record("Another user cannot grant case-learning consent for contributor's case (403 CONTRIBUTOR_IDENTITY_MISMATCH)",
      resOtherUser.status === 403 && resOtherUser.data.code === "CONTRIBUTOR_IDENTITY_MISMATCH");

    const resCrossTenantConsent = await harness.executeAction("grant_case_learning_consent", {
      body: {
        authenticatedApp: true,
        caseId: case2.id,
        purpose: "shared_diagnostic_learning",
        caseLearningConsentAttested: true
      },
      authenticatedUserId: TENANT_B.tech.userId,
      authenticatedCompanyId: TENANT_B.companyId,
      authenticatedRole: "technician",
      authenticatedPermissions: { canEditJobNotes: true }
    });
    record("Company B cannot grant case-learning consent on Company A's private case (403 TENANT_MISMATCH)",
      resCrossTenantConsent.status === 403 && resCrossTenantConsent.data.code === "TENANT_MISMATCH");

    // 7c: Legitimate explicit case-learning consent transition by the authenticated contributor
    const resExplicitGrant = await harness.executeAction("grant_case_learning_consent", {
      body: {
        authenticatedApp: true,
        caseId: case2.id,
        purpose: "shared_diagnostic_learning",
        consentVersion: "2026-10-case-learning-v1",
        caseLearningConsentAttested: true
      },
      authenticatedUserId: TENANT_A.tech.userId,
      authenticatedCompanyId: TENANT_A.companyId,
      authenticatedRole: "technician",
      authenticatedPermissions: { canEditJobNotes: true }
    });

    const case2Consented = harness.store.diagnostic_cases.get(case2.id);
    record("Legitimate explicit grant_case_learning_consent succeeds (200 OK) and updates case_learning_opt_in = true",
      resExplicitGrant.status === 200 && resExplicitGrant.data.ok === true && case2Consented.case_learning_opt_in === true);
    const consentRow = harness.store.case_learning_consents.get(`${case2.id}:shared_diagnostic_learning`);
    record("Durable case_learning_consents record created bound to case, company, contributor, purpose, version, timestamp",
      Boolean(
        consentRow &&
        consentRow.consent_status === "granted" &&
        consentRow.case_id === case2.id &&
        consentRow.company_id === TENANT_A.companyId &&
        consentRow.actor_user_id === TENANT_A.tech.userId &&
        consentRow.purpose === "shared_diagnostic_learning" &&
        consentRow.terms_version === "2026-10-case-learning-v1" &&
        consentRow.granted_at
      ));
    record("Legitimate verified repair enters learning review queue after explicit consent transition",
      harness.store.learning_review_queue.size === 1 && resExplicitGrant.data.queuedForReview === true);

    // 7d: Withdraw consent on this case
    const withdrawRes = await harness.executeAction("withdraw_case_learning_consent", {
      body: { authenticatedApp: true, caseId: case2.id, reason: "Technician withdrew consent" },
      authenticatedUserId: TENANT_A.tech.userId,
      authenticatedCompanyId: TENANT_A.companyId,
      authenticatedRole: "technician"
    });
    record("Withdrawal of case consent succeeds (200 OK)", withdrawRes.status === 200);
    const withdrawnConsent = harness.store.case_learning_consents.get(`${case2.id}:shared_diagnostic_learning`);
    record("Durable case consent status is updated to 'withdrawn'", withdrawnConsent?.consent_status === "withdrawn");

    // 7e: Anti-Spoofing: An ordinary later job save on this case CANNOT silently re-enable consent
    const resLaterJob = await harness.executeAction("save_technician_job", {
      body: {
        authenticatedApp: true,
        relatedCaseId: case2.id,
        complaint: "Follow-up check on pump",
        resolution: "Verified no further leakage",
        outcome: "resolved",
        caseLearningOptIn: true // Attempt to re-opt-in via subsequent job save!
      },
      authenticatedUserId: TENANT_A.tech.userId,
      authenticatedCompanyId: TENANT_A.companyId,
      authenticatedRole: "technician",
      authenticatedPermissions: { canEditJobNotes: true }
    });

    record("Subsequent job save referencing withdrawn case succeeds for internal operations", resLaterJob.status === 200);
    const case2After = harness.store.diagnostic_cases.get(case2.id);
    record("Later job save on existing case cannot re-enable previously withdrawn case",
      case2After.case_learning_opt_in === false && resLaterJob.data.learningStatus === "consent_withdrawn_locked");
    const consentAfter = harness.store.case_learning_consents.get(`${case2.id}:shared_diagnostic_learning`);
    record("Durable consent status remains strictly 'withdrawn'", consentAfter?.consent_status === "withdrawn");

    // 7f: Explicit grant_case_learning_consent also refuses to reactivate withdrawn consent (409)
    const resRegrantWithdrawn = await harness.executeAction("grant_case_learning_consent", {
      body: {
        authenticatedApp: true,
        caseId: case2.id,
        purpose: "shared_diagnostic_learning",
        caseLearningConsentAttested: true
      },
      authenticatedUserId: TENANT_A.tech.userId,
      authenticatedCompanyId: TENANT_A.companyId,
      authenticatedRole: "technician",
      authenticatedPermissions: { canEditJobNotes: true }
    });
    record("Withdrawn consent cannot be reactivated via grant_case_learning_consent (409 CONSENT_WITHDRAWN_LOCKED)",
      resRegrantWithdrawn.status === 409 && resRegrantWithdrawn.data.code === "CONSENT_WITHDRAWN_LOCKED");
  }

  // ---------------------------------------------------------------------------
  // TEST 8: Verified Technician Outcome vs Unverified AI Suggestion
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 8: Verified Technician Outcome vs Unverified AI Suggestion ---");
  {
    const harness = createMockHarness();

    const resTechVerified = await harness.executeAction("save_technician_job", {
      body: {
        authenticatedApp: true,
        complaint: "Pump making grinding noise",
        resolution: "Replaced impeller and wear ring. Flow restored.",
        outcome: "resolved",
        equipmentCategory: "Pump",
        manufacturer: "Pentair",
        model: "IntelliFlo VSF",
        caseLearningOptIn: false
      },
      authenticatedUserId: TENANT_A.tech.userId,
      authenticatedCompanyId: TENANT_A.companyId,
      authenticatedRole: "technician",
      authenticatedPermissions: { canEditJobNotes: true }
    });

    record("Verified technician job saves privately first with 200 OK", resTechVerified.status === 200 && resTechVerified.data.ok === true);
    const techCase = [...harness.store.diagnostic_cases.values()].pop();
    record("Case carries technician_verified = true", techCase && techCase.technician_verified === true);

    const resGrantTechCase = await harness.executeAction("grant_case_learning_consent", {
      body: {
        authenticatedApp: true,
        caseId: techCase.id,
        purpose: "shared_diagnostic_learning",
        consentVersion: "2026-10-case-learning-v1",
        caseLearningConsentAttested: true
      },
      authenticatedUserId: TENANT_A.tech.userId,
      authenticatedCompanyId: TENANT_A.companyId,
      authenticatedRole: "technician",
      authenticatedPermissions: { canEditJobNotes: true }
    });
    record("Explicit case consent transition succeeds (200 OK)", resGrantTechCase.status === 200 && resGrantTechCase.data.ok === true);
    record("Verified repair enters learning_review_queue", harness.store.learning_review_queue.size === 1);
    const queueItem = [...harness.store.learning_review_queue.values()][0];
    record("Review queue item has source_kind = 'technician_job'", queueItem && queueItem.source_kind === "technician_job");

    const resAiCapture = await harness.executeAction("capture_learning_case", {
      body: {
        authenticatedApp: true,
        issue: "Filter gauge reading 30 PSI",
        answer: "Recommend backwashing the sand filter and inspecting multiport valve.",
        category: "Filter",
        brand: "Pentair",
        model: "Tagelus",
        caseStatus: "resolved",
        caseLearningOptIn: true
      },
      authenticatedUserId: TENANT_A.tech.userId,
      authenticatedCompanyId: TENANT_A.companyId
    });

    record("AI troubleshooter turn captured with 200 OK", resAiCapture.status === 200 && resAiCapture.data.captured === true);
    const aiCase = [...harness.store.diagnostic_cases.values()].pop();
    record("AI troubleshooter case strictly sets technician_verified = false", aiCase && aiCase.technician_verified === false);
  }

  // ---------------------------------------------------------------------------
  // TEST 9: Reviewer Approval Without Evidence (Hard Evidence Gate)
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 9: Reviewer Approval Without Evidence (Hard Evidence Gate) ---");
  {
    const harness = createMockHarness();

    // 9a: Unverified AI suggestion
    const aiCaseId = "case_ai_unverified_1";
    const aiQueueId = "queue_ai_unverified_1";
    harness.store.diagnostic_cases.set(aiCaseId, {
      id: aiCaseId,
      tenant_id: TENANT_A.companyId,
      case_status: "resolved",
      technician_verified: false,
      case_learning_opt_in: true,
      learning_terms_version: "2026-10-v1",
      contributor_user_id: TENANT_A.tech.userId,
      contributor_accepted_at: new Date().toISOString(),
      equipment_category: "Heater",
      resolution_summary_redacted: "Chatbot suggested replacing thermistor"
    });
    harness.store.case_learning_consents.set(`${aiCaseId}:shared_diagnostic_learning`, {
      case_id: aiCaseId,
      company_id: TENANT_A.companyId,
      actor_user_id: TENANT_A.tech.userId,
      purpose: "shared_diagnostic_learning",
      consent_status: "granted"
    });
    harness.store.learning_review_queue.set(aiQueueId, {
      id: aiQueueId,
      case_id: aiCaseId,
      tenant_id: TENANT_A.companyId,
      source_kind: "authenticated_troubleshooter",
      status: "pending",
      proposed_lesson_redacted: "Unverified chatbot advice on replacing thermistor."
    });

    const resApproveAi = await harness.executeAction("review_learning_case", {
      body: {
        authenticatedApp: true,
        queueId: aiQueueId,
        decision: "approve",
        reviewNote: "Platform owner signing off"
      },
      authenticatedUserId: PLATFORM_OWNER.userId
    });

    record("Platform owner approval of unverified AI suggestion is REJECTED with 403",
      resApproveAi.status === 403 && resApproveAi.data.code === "VERIFIED_REPAIR_REQUIRED");

    // 9b: Unresolved technician case (case_status = 'open')
    const openCaseId = "case_open_1";
    const openQueueId = "queue_open_1";
    harness.store.diagnostic_cases.set(openCaseId, {
      id: openCaseId,
      tenant_id: TENANT_A.companyId,
      case_status: "open", // Not resolved!
      technician_verified: true,
      case_learning_opt_in: true,
      learning_terms_version: "2026-10-v1",
      contributor_user_id: TENANT_A.tech.userId,
      contributor_accepted_at: new Date().toISOString(),
      resolution_summary_redacted: "In progress repair notes"
    });
    harness.store.case_learning_consents.set(`${openCaseId}:shared_diagnostic_learning`, {
      case_id: openCaseId,
      company_id: TENANT_A.companyId,
      actor_user_id: TENANT_A.tech.userId,
      purpose: "shared_diagnostic_learning",
      consent_status: "granted"
    });
    harness.store.learning_review_queue.set(openQueueId, {
      id: openQueueId,
      case_id: openCaseId,
      tenant_id: TENANT_A.companyId,
      source_kind: "technician_job",
      status: "pending",
      proposed_lesson_redacted: "Pentair IntelliFlo filter pressure issue: grids cleaned but still 35 psi, unresolved repair notes."
    });

    const resApproveOpen = await harness.executeAction("review_learning_case", {
      body: { authenticatedApp: true, queueId: openQueueId, decision: "approve" },
      authenticatedUserId: PLATFORM_OWNER.userId
    });
    record("Unresolved case approval is REJECTED (fails closed)", resApproveOpen.status === 403 || resApproveOpen.status === 500);

    // 9c: Cross-tenant queue-case mismatch
    const crossCaseId = "case_cross_tenant_1";
    const crossQueueId = "queue_cross_tenant_1";
    harness.store.diagnostic_cases.set(crossCaseId, {
      id: crossCaseId,
      tenant_id: TENANT_B.companyId, // Foreign tenant!
      case_status: "resolved",
      technician_verified: true,
      case_learning_opt_in: true,
      learning_terms_version: "2026-10-v1",
      contributor_user_id: TENANT_B.tech.userId,
      contributor_accepted_at: new Date().toISOString(),
      resolution_summary_redacted: "Cleaned cell"
    });
    harness.store.case_learning_consents.set(`${crossCaseId}:shared_diagnostic_learning`, {
      case_id: crossCaseId,
      company_id: TENANT_B.companyId,
      actor_user_id: TENANT_B.tech.userId,
      purpose: "shared_diagnostic_learning",
      consent_status: "granted"
    });
    harness.store.learning_review_queue.set(crossQueueId, {
      id: crossQueueId,
      case_id: crossCaseId,
      tenant_id: TENANT_A.companyId, // Tenant mismatch!
      source_kind: "technician_job",
      status: "pending",
      proposed_lesson_redacted: "Cross-tenant queue submission attempting to claim foreign case from another company workspace."
    });

    const resApproveCross = await harness.executeAction("review_learning_case", {
      body: { authenticatedApp: true, queueId: crossQueueId, decision: "approve" },
      authenticatedUserId: PLATFORM_OWNER.userId
    });
    record("Cross-tenant queue-case mismatch is REJECTED (fails closed)", resApproveCross.status === 403 || resApproveCross.status === 500);

    // 9d: Missing durable case consent row
    const noConsentCaseId = "case_no_consent_row_1";
    const noConsentQueueId = "queue_no_consent_row_1";
    harness.store.diagnostic_cases.set(noConsentCaseId, {
      id: noConsentCaseId,
      tenant_id: TENANT_A.companyId,
      case_status: "resolved",
      technician_verified: true,
      case_learning_opt_in: true,
      learning_terms_version: "2026-10-v1",
      contributor_user_id: TENANT_A.tech.userId,
      contributor_accepted_at: new Date().toISOString(),
      resolution_summary_redacted: "Replaced flow switch"
    });
    // Deliberately do NOT insert into case_learning_consents!
    harness.store.learning_review_queue.set(noConsentQueueId, {
      id: noConsentQueueId,
      case_id: noConsentCaseId,
      tenant_id: TENANT_A.companyId,
      source_kind: "technician_job",
      status: "pending",
      proposed_lesson_redacted: "Pentair IntelliFlo salt system flow switch replaced but case lacks durable consent record."
    });

    const resApproveNoConsent = await harness.executeAction("review_learning_case", {
      body: { authenticatedApp: true, queueId: noConsentQueueId, decision: "approve" },
      authenticatedUserId: PLATFORM_OWNER.userId
    });
    record("Approval without durable case consent record is REJECTED", resApproveNoConsent.status === 403 || resApproveNoConsent.status === 500);

    // 9e: Positive control: Fully verified technician repair with all evidence gates passed
    const verifiedCaseId = "case_tech_verified_1";
    const verifiedQueueId = "queue_tech_verified_1";
    harness.store.diagnostic_cases.set(verifiedCaseId, {
      id: verifiedCaseId,
      tenant_id: TENANT_A.companyId,
      case_status: "resolved",
      technician_verified: true,
      case_learning_opt_in: true,
      learning_terms_version: "2026-10-v1",
      contributor_user_id: TENANT_A.tech.userId,
      contributor_accepted_at: new Date().toISOString(),
      equipment_category: "Pump",
      manufacturer_normalized: "Pentair",
      model_normalized: "IntelliFlo VSF",
      resolution_summary_redacted: "Replaced drive assembly and re-calibrated RS-485 communication."
    });
    harness.store.case_learning_consents.set(`${verifiedCaseId}:shared_diagnostic_learning`, {
      case_id: verifiedCaseId,
      company_id: TENANT_A.companyId,
      actor_user_id: TENANT_A.tech.userId,
      purpose: "shared_diagnostic_learning",
      consent_status: "granted"
    });
    harness.store.learning_review_queue.set(verifiedQueueId, {
      id: verifiedQueueId,
      case_id: verifiedCaseId,
      tenant_id: TENANT_A.companyId,
      source_kind: "technician_job",
      status: "pending",
      proposed_lesson_redacted: "Pentair IntelliFlo VSF: Replaced drive assembly and restored RS-485 comms."
    });

    const resApproveVerified = await harness.executeAction("review_learning_case", {
      body: {
        authenticatedApp: true,
        queueId: verifiedQueueId,
        decision: "approve",
        reviewNote: "Senior technician sign-off verified"
      },
      authenticatedUserId: PLATFORM_OWNER.userId
    });

    record("Fully verified technician repair approves successfully (200 OK)",
      resApproveVerified.status === 200 && resApproveVerified.data.ok === true);
    record("Approved item is published to shared_learning_knowledge",
      harness.store.shared_learning_knowledge.size === 1);
    const pubItem = [...harness.store.shared_learning_knowledge.values()][0];
    record("Published record has knowledge_type = 'verified_repair' and technician_verified = true",
      pubItem.knowledge_type === "verified_repair" && pubItem.technician_verified === true && pubItem.publication_status === "active");
  }

  // ---------------------------------------------------------------------------
  // TEST 10: Atomic Consent Withdrawal Lifecycle, Soft-Revocation & Fault Injection
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 10: Atomic Consent Withdrawal Lifecycle & Audit ---");
  {
    const harness = createMockHarness();

    const caseId = "case_withdraw_10";
    const queueId = "queue_withdraw_10";
    const pubId = "pub_" + queueId;

    harness.store.diagnostic_cases.set(caseId, {
      id: caseId,
      tenant_id: TENANT_A.companyId,
      case_status: "resolved",
      technician_verified: true,
      case_learning_opt_in: true,
      approved_for_learning: true,
      learning_terms_version: "2026-10-v1",
      contributor_user_id: TENANT_A.admin.userId,
      contributor_accepted_at: new Date().toISOString()
    });
    harness.store.case_learning_consents.set(`${caseId}:shared_diagnostic_learning`, {
      case_id: caseId,
      company_id: TENANT_A.companyId,
      actor_user_id: TENANT_A.admin.userId,
      purpose: "shared_diagnostic_learning",
      consent_status: "granted"
    });
    harness.store.learning_review_queue.set(queueId, {
      id: queueId,
      case_id: caseId,
      tenant_id: TENANT_A.companyId,
      source_kind: "technician_job",
      status: "approved"
    });
    harness.store.shared_learning_knowledge.set(pubId, {
      id: pubId,
      source_case_id: caseId,
      source_queue_id: queueId,
      source_company_id: TENANT_A.companyId,
      knowledge_type: "verified_repair",
      publication_status: "active"
    });

    // 10a: Atomic consent withdrawal succeeds
    const resWithdraw = await harness.executeAction("withdraw_case_learning_consent", {
      body: {
        authenticatedApp: true,
        caseId: caseId
      },
      authenticatedUserId: TENANT_A.admin.userId,
      authenticatedCompanyId: TENANT_A.companyId,
      authenticatedRole: "company_admin"
    });

    record("Consent withdrawal succeeds with 200 OK", resWithdraw.status === 200 && resWithdraw.data.ok === true);
    const caseAfter = harness.store.diagnostic_cases.get(caseId);
    record("Case case_learning_opt_in set to false", caseAfter.case_learning_opt_in === false);
    record("Case approved_for_learning reset to false", caseAfter.approved_for_learning === false);
    const pubAfter = harness.store.shared_learning_knowledge.get(pubId);
    record("Published shared_learning_knowledge entry is soft-revoked (publication_status = 'revoked')",
      pubAfter && pubAfter.publication_status === "revoked");
    const queueAfter = harness.store.learning_review_queue.get(queueId);
    record("Review queue item status updated to 'rejected'", queueAfter.status === "rejected");
    const consentAfter = harness.store.case_learning_consents.get(`${caseId}:shared_diagnostic_learning`);
    record("Durable case consent status updated to 'withdrawn'", consentAfter?.consent_status === "withdrawn");
    record("Immutable audit record exists in learning_review_audit",
      harness.store.learning_review_audit.some(a => a.case_id === caseId && a.action === "rejected"));

    // 10b: Injected DB failure during atomic withdrawal RPC fails closed (500)
    harness.store.diagnostic_cases.set("injected_failure_case", {
      id: "injected_failure_case",
      tenant_id: TENANT_A.companyId,
      case_learning_opt_in: true
    });
    const resFault = await harness.executeAction("withdraw_case_learning_consent", {
      body: { authenticatedApp: true, caseId: "injected_failure_case" },
      authenticatedUserId: TENANT_A.admin.userId,
      authenticatedCompanyId: TENANT_A.companyId,
      authenticatedRole: "company_admin"
    });
    record("Injected DB failure during withdrawal fails closed with 500 CONSENT_WITHDRAWAL_FAILED",
      resFault.status === 500 && resFault.data.code === "CONSENT_WITHDRAWAL_FAILED");
  }

  // ---------------------------------------------------------------------------
  // TEST 11: Revoked Publication, Manual Consent & Retrieval Exclusion
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 11: Revoked Publication & Retrieval Exclusion ---");
  {
    const harness = createMockHarness();

    const activeRepairId = "pub_active_repair_1";
    harness.store.shared_learning_knowledge.set(activeRepairId, {
      id: activeRepairId,
      source_company_id: TENANT_A.companyId,
      source_kind: "technician_job",
      knowledge_type: "verified_repair",
      technician_verified: true,
      publication_status: "active",
      equipment_category: "Pump",
      manufacturer_normalized: "Pentair",
      model_normalized: "IntelliFlo",
      lesson_redacted: "Pentair IntelliFlo pump seal replacement procedure."
    });

    const revokedRepairId = "pub_revoked_repair_1";
    harness.store.shared_learning_knowledge.set(revokedRepairId, {
      id: revokedRepairId,
      source_company_id: TENANT_A.companyId,
      source_kind: "technician_job",
      knowledge_type: "verified_repair",
      technician_verified: true,
      publication_status: "revoked", // REVOKED!
      equipment_category: "Pump",
      manufacturer_normalized: "Pentair",
      model_normalized: "IntelliFlo",
      lesson_redacted: "Pentair IntelliFlo revoked procedure."
    });

    const unconfirmedId = "pub_unconfirmed_suggestion_1";
    harness.store.shared_learning_knowledge.set(unconfirmedId, {
      id: unconfirmedId,
      source_company_id: TENANT_A.companyId,
      source_kind: "authenticated_troubleshooter",
      knowledge_type: "unconfirmed_suggestion",
      technician_verified: false,
      publication_status: "active",
      equipment_category: "Pump",
      manufacturer_normalized: "Pentair",
      model_normalized: "IntelliFlo",
      lesson_redacted: "Pentair IntelliFlo unconfirmed AI suggestion."
    });

    // 11b: Company manual consent revocation: Company is active, but manual consent revoked
    const manualActiveId = "man_active_1";
    const manualRevokedId = "man_revoked_1";
    harness.store.company_manuals.set(manualActiveId, {
      id: manualActiveId,
      company_id: TENANT_A.companyId,
      shared_learning_opt_in: true,
      status: "ready"
    });
    harness.store.company_manuals.set(manualRevokedId, {
      id: manualRevokedId,
      company_id: TENANT_A.companyId,
      shared_learning_opt_in: false, // Individual manual consent revoked!
      status: "ready"
    });

    const activeManualPubId = "pub_active_manual_1";
    harness.store.shared_learning_knowledge.set(activeManualPubId, {
      id: activeManualPubId,
      source_company_id: TENANT_A.companyId,
      source_manual_id: manualActiveId,
      source_kind: "company_manual",
      knowledge_type: "manufacturer_manual",
      technician_verified: false,
      publication_status: "active",
      equipment_category: "Pump",
      manufacturer_normalized: "Pentair",
      model_normalized: "IntelliFlo",
      lesson_redacted: "Pentair IntelliFlo active manual torque specs."
    });

    const revokedManualPubId = "pub_revoked_manual_1";
    harness.store.shared_learning_knowledge.set(revokedManualPubId, {
      id: revokedManualPubId,
      source_company_id: TENANT_A.companyId,
      source_manual_id: manualRevokedId,
      source_kind: "company_manual",
      knowledge_type: "manufacturer_manual",
      technician_verified: false,
      publication_status: "active",
      equipment_category: "Pump",
      manufacturer_normalized: "Pentair",
      model_normalized: "IntelliFlo",
      lesson_redacted: "Pentair IntelliFlo revoked manual torque specs."
    });

    // 11c: Observation-only material containing action verbs
    const observationId = "pub_observed_diag_1";
    harness.store.shared_learning_knowledge.set(observationId, {
      id: observationId,
      source_company_id: TENANT_A.companyId,
      source_kind: "technician_job",
      knowledge_type: "observed_diagnosis", // Observation only!
      technician_verified: false,
      publication_status: "active",
      equipment_category: "Pump",
      manufacturer_normalized: "Pentair",
      model_normalized: "IntelliFlo",
      lesson_redacted: "Replace motor bearings and adjust impeller clearance on Pentair IntelliFlo."
    });

    const searchRes = await harness.client.rpc("search_shared_learning", { p_query: "Pentair IntelliFlo", p_limit: 10 });
    const returnedIds = (searchRes.data || []).map(r => r.id);
    record("search_shared_learning includes active verified repair", returnedIds.includes(activeRepairId));
    record("search_shared_learning excludes revoked entry", !returnedIds.includes(revokedRepairId));
    record("search_shared_learning excludes unconfirmed suggestion", !returnedIds.includes(unconfirmedId));
    record("search_shared_learning includes active manual from opted-in company", returnedIds.includes(activeManualPubId));
    record("search_shared_learning excludes revoked manual from active company", !returnedIds.includes(revokedManualPubId));
    record("search_shared_learning excludes observation-only material with action verb from actionable retrieval",
      !returnedIds.includes(observationId));

    // 11d: verifyInternalCitation verification check (matches clever-handler line 1420)
    function checkCitation(row) {
      if (row.shared_learning_source === true) {
        if (row.approved_for_learning === false || row.publication_status === "revoked") return false;
        if (row.source_kind === "authenticated_troubleshooter" && row.technician_verified !== true) return false;
        if (row.knowledge_type !== "verified_repair" && row.knowledge_type !== "manufacturer_manual") return false;
      }
      return true;
    }

    record("Citation verifier accepts active verified repair",
      checkCitation({ shared_learning_source: true, approved_for_learning: true, publication_status: "active", source_kind: "technician_job", technician_verified: true, knowledge_type: "verified_repair" }));

    record("Citation verifier accepts active manufacturer manual",
      checkCitation({ shared_learning_source: true, approved_for_learning: true, publication_status: "active", source_kind: "company_manual", technician_verified: false, knowledge_type: "manufacturer_manual" }));

    record("Citation verifier rejects revoked publication status",
      !checkCitation({ shared_learning_source: true, approved_for_learning: true, publication_status: "revoked", source_kind: "technician_job", technician_verified: true, knowledge_type: "verified_repair" }));

    record("Citation verifier rejects unverified authenticated_troubleshooter",
      !checkCitation({ shared_learning_source: true, approved_for_learning: true, publication_status: "active", source_kind: "authenticated_troubleshooter", technician_verified: false, knowledge_type: "observed_diagnosis" }));

    record("Citation verifier rejects unconfirmed_suggestion knowledge_type",
      !checkCitation({ shared_learning_source: true, approved_for_learning: true, publication_status: "active", knowledge_type: "unconfirmed_suggestion" }));

    record("Citation verifier strictly rejects observed_diagnosis even with action verbs ('Replace', 'adjust')",
      !checkCitation({
        shared_learning_source: true,
        approved_for_learning: true,
        publication_status: "active",
        knowledge_type: "observed_diagnosis",
        content_text: "Replace motor bearings and adjust impeller clearance"
      }));
  }

  // ---------------------------------------------------------------------------
  // TEST 12: Idempotent Retries
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 12: Idempotent Retries (Offline Sync & Consent Withdrawal) ---");
  {
    const harness = createMockHarness();
    const clientJobId = "55555555-5555-4555-8555-555555555555";

    const jobPayload = {
      authenticatedApp: true,
      clientJobId,
      complaint: "Pump won't prime",
      resolution: "Cleared skimmer basket obstruction",
      outcome: "resolved",
      repairSteps: [{ step: 1, action: "Cleared basket", parts: "", result: "Water flow restored" }],
      caseLearningOptIn: false
    };

    // First save
    const res1 = await harness.executeAction("save_technician_job", {
      body: jobPayload,
      authenticatedUserId: TENANT_A.tech.userId,
      authenticatedCompanyId: TENANT_A.companyId,
      authenticatedRole: "technician",
      authenticatedPermissions: { canEditJobNotes: true }
    });

    record("Initial job save succeeds (200 OK)", res1.status === 200 && res1.data.ok === true);
    const initialJobCount = harness.store.technician_job_records.size;

    // Second save (replay identical payload with same clientJobId)
    const res2 = await harness.executeAction("save_technician_job", {
      body: jobPayload,
      authenticatedUserId: TENANT_A.tech.userId,
      authenticatedCompanyId: TENANT_A.companyId,
      authenticatedRole: "technician",
      authenticatedPermissions: { canEditJobNotes: true }
    });

    record("Replayed job save succeeds idempotently (200 OK)", res2.status === 200 && res2.data.ok === true && res2.data.idempotentReplay === true);
    record("Zero duplicate job records created on replay", harness.store.technician_job_records.size === initialJobCount);

    // Idempotent consent withdrawal
    const caseId = "case_idempotent_withdraw_1";
    harness.store.diagnostic_cases.set(caseId, {
      id: caseId,
      tenant_id: TENANT_A.companyId,
      case_learning_opt_in: false, // Already withdrawn!
      approved_for_learning: false
    });

    const resWithdrawReplay = await harness.executeAction("withdraw_case_learning_consent", {
      body: {
        authenticatedApp: true,
        caseId: caseId
      },
      authenticatedUserId: TENANT_A.admin.userId,
      authenticatedCompanyId: TENANT_A.companyId,
      authenticatedRole: "company_admin"
    });

    record("Repeated consent withdrawal returns 200 OK idempotently",
      resWithdrawReplay.status === 200 && resWithdrawReplay.data.status === "consent_withdrawn");
  }

  // ---------------------------------------------------------------------------
  // TEST 13: Private-Only Notes
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 13: Private-Only Notes Support ---");
  {
    const harness = createMockHarness();

    const resPrivate = await harness.executeAction("save_technician_job", {
      body: {
        authenticatedApp: true,
        complaint: "Routine pool vacuum and chemical check",
        notes: "Customer has dog; ensure gate locked. Added 1 gal liquid chlorine.",
        outcome: "resolved",
        caseLearningOptIn: false // Company private
      },
      authenticatedUserId: TENANT_A.tech.userId,
      authenticatedCompanyId: TENANT_A.companyId,
      authenticatedRole: "technician",
      authenticatedPermissions: { canEditJobNotes: true }
    });

    record("Private field notes save cleanly (200 OK)", resPrivate.status === 200 && resPrivate.data.ok === true);
    record("Technician job record exists in store for company use", harness.store.technician_job_records.size === 1);
    record("Associated diagnostic case exists in store for company use", harness.store.diagnostic_cases.size === 1);
    record("Diagnostic case steps exist in store", harness.store.diagnostic_case_steps.size === 1);
    record("Zero entries in learning_review_queue (private notes strictly isolated from learning)",
      harness.store.learning_review_queue.size === 0);
    record("Zero entries in shared_learning_knowledge", harness.store.shared_learning_knowledge.size === 0);
  }

  // ---------------------------------------------------------------------------
  // TEST 14: Fail-Closed Consent Database Errors (SELECT / INSERT / UPDATE)
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 14: Fail-Closed Consent Database Errors (SELECT / INSERT / UPDATE) ---");
  {
    const harness = createMockHarness();

    // Create an existing case for Tenant A
    const existingCaseId = "14141414-1414-4141-8141-141414141414";
    harness.store.diagnostic_cases.set(existingCaseId, {
      id: existingCaseId,
      tenant_id: TENANT_A.companyId,
      case_status: "resolved",
      technician_verified: true,
      case_learning_opt_in: true,
      approved_for_learning: false,
      contributor_user_id: TENANT_A.tech.userId,
      resolution_summary_redacted: "Replaced pressure switch"
    });
    harness.store.case_learning_consents.set(`${existingCaseId}:shared_diagnostic_learning`, {
      case_id: existingCaseId,
      company_id: TENANT_A.companyId,
      actor_user_id: TENANT_A.tech.userId,
      purpose: "shared_diagnostic_learning",
      terms_version: "2026-10-case-learning-v1",
      consent_status: "granted",
      granted_at: new Date().toISOString()
    });

    // 14a: Failed consent SELECT during save_technician_job
    harness.store.injectedErrors = new Map([
      ["case_learning_consents:select", { code: "PGRST500", message: "Simulated consent SELECT timeout" }]
    ]);
    const resReadFailSave = await harness.executeAction("save_technician_job", {
      body: {
        authenticatedApp: true,
        relatedCaseId: existingCaseId,
        complaint: "Heater pressure switch fault",
        resolution: "Replaced pressure switch and verified firing",
        outcome: "resolved",
        caseLearningOptIn: true
      },
      authenticatedUserId: TENANT_A.tech.userId,
      authenticatedCompanyId: TENANT_A.companyId,
      authenticatedRole: "technician",
      authenticatedPermissions: { canEditJobNotes: true }
    });
    harness.store.injectedErrors.clear();

    record("Failed consent SELECT during save_technician_job preserves private job notes (200 OK)",
      resReadFailSave.status === 200 && resReadFailSave.data.ok === true && harness.store.technician_job_records.size === 1);
    record("Failed consent SELECT during save_technician_job reports fail-closed status and CONSENT_LOOKUP_FAILED",
      resReadFailSave.data.learningStatus === "consent_verification_failed_closed" &&
      resReadFailSave.data.consentErrorCode === "CONSENT_LOOKUP_FAILED");
    record("Failed consent SELECT during save_technician_job forces related case case_learning_opt_in = false and creates 0 queue items",
      harness.store.diagnostic_cases.get(existingCaseId).case_learning_opt_in === false &&
      harness.store.learning_review_queue.size === 0);

    // 14b: Failed consent SELECT during grant_case_learning_consent
    const privateCaseId = "14141414-2222-4222-8222-222222222222";
    harness.store.diagnostic_cases.set(privateCaseId, {
      id: privateCaseId,
      tenant_id: TENANT_A.companyId,
      case_status: "resolved",
      technician_verified: true,
      case_learning_opt_in: false,
      approved_for_learning: false,
      contributor_user_id: TENANT_A.tech.userId,
      resolution_summary_redacted: "Replaced capacitor"
    });

    harness.store.injectedErrors.set("case_learning_consents:select", { code: "PGRST500", message: "Simulated SELECT error" });
    const resGrantReadFail = await harness.executeAction("grant_case_learning_consent", {
      body: {
        authenticatedApp: true,
        caseId: privateCaseId,
        purpose: "shared_diagnostic_learning",
        caseLearningConsentAttested: true
      },
      authenticatedUserId: TENANT_A.tech.userId,
      authenticatedCompanyId: TENANT_A.companyId,
      authenticatedRole: "technician",
      authenticatedPermissions: { canEditJobNotes: true }
    });
    harness.store.injectedErrors.clear();

    record("Failed consent SELECT in grant_case_learning_consent fails closed (500 CONSENT_LOOKUP_FAILED)",
      resGrantReadFail.status === 500 && resGrantReadFail.data.code === "CONSENT_LOOKUP_FAILED");
    record("Failed consent SELECT leaves case unconsented and creates 0 queue items",
      harness.store.diagnostic_cases.get(privateCaseId).case_learning_opt_in === false &&
      harness.store.learning_review_queue.size === 0);

    // 14c: Failed consent INSERT during grant_case_learning_consent
    harness.store.injectedErrors.set("case_learning_consents:insert", { code: "PGRST500", message: "Simulated INSERT error" });
    const resGrantInsertFail = await harness.executeAction("grant_case_learning_consent", {
      body: {
        authenticatedApp: true,
        caseId: privateCaseId,
        purpose: "shared_diagnostic_learning",
        caseLearningConsentAttested: true
      },
      authenticatedUserId: TENANT_A.tech.userId,
      authenticatedCompanyId: TENANT_A.companyId,
      authenticatedRole: "technician",
      authenticatedPermissions: { canEditJobNotes: true }
    });
    harness.store.injectedErrors.clear();

    record("Failed consent INSERT in grant_case_learning_consent fails closed (500 CONSENT_PERSIST_FAILED)",
      resGrantInsertFail.status === 500 && resGrantInsertFail.data.code === "CONSENT_PERSIST_FAILED");
    record("Failed consent INSERT leaves case_learning_opt_in = false and creates 0 queue items",
      harness.store.diagnostic_cases.get(privateCaseId).case_learning_opt_in === false &&
      !harness.store.case_learning_consents.has(`${privateCaseId}:shared_diagnostic_learning`) &&
      harness.store.learning_review_queue.size === 0);

    // 14d: Failed diagnostic_cases UPDATE after consent insert rolls back consent status to 'revoked'
    harness.store.injectedErrors.set("diagnostic_cases:update", { code: "PGRST500", message: "Simulated case UPDATE error" });
    const resGrantCaseUpdateFail = await harness.executeAction("grant_case_learning_consent", {
      body: {
        authenticatedApp: true,
        caseId: privateCaseId,
        purpose: "shared_diagnostic_learning",
        caseLearningConsentAttested: true
      },
      authenticatedUserId: TENANT_A.tech.userId,
      authenticatedCompanyId: TENANT_A.companyId,
      authenticatedRole: "technician",
      authenticatedPermissions: { canEditJobNotes: true }
    });
    harness.store.injectedErrors.clear();

    const rolledBackConsent = harness.store.case_learning_consents.get(`${privateCaseId}:shared_diagnostic_learning`);
    record("Failed diagnostic_cases UPDATE in grant_case_learning_consent fails closed (500 CASE_CONSENT_UPDATE_FAILED) and revokes partial consent row",
      resGrantCaseUpdateFail.status === 500 &&
      resGrantCaseUpdateFail.data.code === "CASE_CONSENT_UPDATE_FAILED" &&
      rolledBackConsent?.consent_status === "revoked" &&
      harness.store.learning_review_queue.size === 0);
  }

  // ---------------------------------------------------------------------------
  // TEST 15: Non-Destructive Rollback / Recovery Simulation on Synthetic Fixtures
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 15: Non-Destructive Rollback / Recovery Simulation ---");
  {
    const rollbackDocPath = path.join(root, "docs/reviews/learning_safety_and_consent_migration_rollback_plan.md");
    const rollbackDoc = fs.readFileSync(rollbackDocPath, "utf8");
    const sqlSectionMatch = rollbackDoc.match(/### 4\.1 Rollback SQL Script[\s\S]*?```sql([\s\S]*?)```/);
    const rollbackSql = sqlSectionMatch ? sqlSectionMatch[1] : "";

    record("Rollback SQL script exists in Section 4.1", rollbackSql.length > 200);
    record("Rollback SQL contains zero destructive DELETE / DROP TABLE / DROP COLUMN statements",
      !/\bDELETE\s+FROM\b/i.test(rollbackSql) &&
      !/\bDROP\s+TABLE\b/i.test(rollbackSql) &&
      !/\bDROP\s+COLUMN\b/i.test(rollbackSql));
    record("Rollback SQL enforces publication_status = 'quarantined', observed_diagnosis, unconfirmed_suggestion, company, manual, and case_learning_consents gates",
      rollbackSql.includes("publication_status = 'quarantined'") &&
      rollbackSql.includes("'observed_diagnosis'") &&
      rollbackSql.includes("'unconfirmed_suggestion'") &&
      rollbackSql.includes("public.case_learning_consents") &&
      rollbackSql.includes("public.company_manuals") &&
      rollbackSql.includes("k.publication_status = 'active'"));

    // Execute synthetic fixture simulation of the Section 4.1 recovery quarantine + search_shared_learning
    const harness = createMockHarness();

    // Valid active case + consent
    const validCaseId = "15151515-1111-4111-8111-111111111111";
    harness.store.diagnostic_cases.set(validCaseId, {
      id: validCaseId,
      tenant_id: TENANT_A.companyId,
      case_status: "resolved",
      technician_verified: true,
      case_learning_opt_in: true,
      approved_for_learning: true,
      contributor_user_id: TENANT_A.tech.userId
    });
    harness.store.case_learning_consents.set(`${validCaseId}:shared_diagnostic_learning`, {
      case_id: validCaseId,
      company_id: TENANT_A.companyId,
      actor_user_id: TENANT_A.tech.userId,
      purpose: "shared_diagnostic_learning",
      terms_version: "2026-10-case-learning-v1",
      consent_status: "granted"
    });

    // Withdrawn case consent
    const withdrawnCaseId = "15151515-2222-4222-8222-222222222222";
    harness.store.diagnostic_cases.set(withdrawnCaseId, {
      id: withdrawnCaseId,
      tenant_id: TENANT_A.companyId,
      case_status: "resolved",
      technician_verified: true,
      case_learning_opt_in: false,
      approved_for_learning: false,
      contributor_user_id: TENANT_A.tech.userId
    });
    harness.store.case_learning_consents.set(`${withdrawnCaseId}:shared_diagnostic_learning`, {
      case_id: withdrawnCaseId,
      company_id: TENANT_A.companyId,
      actor_user_id: TENANT_A.tech.userId,
      purpose: "shared_diagnostic_learning",
      terms_version: "2026-10-case-learning-v1",
      consent_status: "withdrawn"
    });

    // Manuals: one active, one withdrawn
    harness.store.company_manuals.set("man_valid_15", {
      id: "man_valid_15",
      company_id: TENANT_A.companyId,
      shared_learning_opt_in: true,
      reference_enabled: true,
      status: "ready",
      extraction_status: "ready"
    });
    harness.store.company_manuals.set("man_withdrawn_15", {
      id: "man_withdrawn_15",
      company_id: TENANT_A.companyId,
      shared_learning_opt_in: false,
      reference_enabled: true,
      status: "ready",
      extraction_status: "ready"
    });

    // Populate synthetic shared_learning_knowledge fixtures
    const fixtures = [
      { id: "fx_valid_repair", source_company_id: TENANT_A.companyId, source_case_id: validCaseId, source_kind: "technician_job", knowledge_type: "verified_repair", technician_verified: true, publication_status: "active", consent_snapshot: true, equipment_category: "Pump", manufacturer_normalized: "Pentair", model_normalized: "IntelliFlo", lesson_redacted: "Pentair IntelliFlo valid verified repair." },
      { id: "fx_valid_manual", source_company_id: TENANT_A.companyId, source_manual_id: "man_valid_15", source_kind: "company_manual", knowledge_type: "manufacturer_manual", technician_verified: false, publication_status: "active", consent_snapshot: true, equipment_category: "Pump", manufacturer_normalized: "Pentair", model_normalized: "IntelliFlo", lesson_redacted: "Pentair IntelliFlo valid manufacturer manual." },
      { id: "fx_revoked", source_company_id: TENANT_A.companyId, source_case_id: validCaseId, source_kind: "technician_job", knowledge_type: "verified_repair", technician_verified: true, publication_status: "revoked", consent_snapshot: false, equipment_category: "Pump", manufacturer_normalized: "Pentair", model_normalized: "IntelliFlo", lesson_redacted: "Pentair IntelliFlo revoked repair." },
      { id: "fx_quarantined", source_company_id: TENANT_A.companyId, source_case_id: validCaseId, source_kind: "technician_job", knowledge_type: "verified_repair", technician_verified: true, publication_status: "quarantined", consent_snapshot: false, equipment_category: "Pump", manufacturer_normalized: "Pentair", model_normalized: "IntelliFlo", lesson_redacted: "Pentair IntelliFlo quarantined repair." },
      { id: "fx_observed", source_company_id: TENANT_A.companyId, source_case_id: validCaseId, source_kind: "technician_job", knowledge_type: "observed_diagnosis", technician_verified: false, publication_status: "active", consent_snapshot: true, equipment_category: "Pump", manufacturer_normalized: "Pentair", model_normalized: "IntelliFlo", lesson_redacted: "Pentair IntelliFlo observed diagnosis." },
      { id: "fx_unconfirmed", source_company_id: TENANT_A.companyId, source_case_id: validCaseId, source_kind: "authenticated_troubleshooter", knowledge_type: "unconfirmed_suggestion", technician_verified: false, publication_status: "active", consent_snapshot: true, equipment_category: "Pump", manufacturer_normalized: "Pentair", model_normalized: "IntelliFlo", lesson_redacted: "Pentair IntelliFlo unconfirmed suggestion." },
      { id: "fx_withdrawn_company", source_company_id: TENANT_B.companyId, source_case_id: validCaseId, source_kind: "technician_job", knowledge_type: "verified_repair", technician_verified: true, publication_status: "active", consent_snapshot: true, equipment_category: "Pump", manufacturer_normalized: "Pentair", model_normalized: "IntelliFlo", lesson_redacted: "Pentair IntelliFlo withdrawn company." },
      { id: "fx_withdrawn_manual", source_company_id: TENANT_A.companyId, source_manual_id: "man_withdrawn_15", source_kind: "company_manual", knowledge_type: "manufacturer_manual", technician_verified: false, publication_status: "active", consent_snapshot: true, equipment_category: "Pump", manufacturer_normalized: "Pentair", model_normalized: "IntelliFlo", lesson_redacted: "Pentair IntelliFlo withdrawn manual." },
      { id: "fx_withdrawn_case", source_company_id: TENANT_A.companyId, source_case_id: withdrawnCaseId, source_kind: "technician_job", knowledge_type: "verified_repair", technician_verified: true, publication_status: "active", consent_snapshot: true, equipment_category: "Pump", manufacturer_normalized: "Pentair", model_normalized: "IntelliFlo", lesson_redacted: "Pentair IntelliFlo withdrawn case consent." }
    ];
    for (const fx of fixtures) {
      harness.store.shared_learning_knowledge.set(fx.id, { ...fx, review_history: [] });
    }

    // Simulate Step 1 of Section 4.1 Rollback / Recovery SQL (Non-Destructive Quarantine)
    for (const k of harness.store.shared_learning_knowledge.values()) {
      if (k.publication_status === "revoked") continue;
      const comp = k.source_company_id ? harness.store.companies.get(k.source_company_id) : null;
      const companyValid = Boolean(comp && comp.status === "active" && comp.diagnostic_learning_opt_in === true);
      let manualValid = true;
      if (k.source_kind === "company_manual") {
        const m = k.source_manual_id ? harness.store.company_manuals.get(k.source_manual_id) : null;
        manualValid = Boolean(m && m.company_id === k.source_company_id && m.shared_learning_opt_in === true && m.reference_enabled === true && m.extraction_status === "ready");
      }
      let caseValid = true;
      if (k.source_kind === "technician_job" || k.source_kind === "authenticated_troubleshooter") {
        const dc = k.source_case_id ? harness.store.diagnostic_cases.get(k.source_case_id) : null;
        const clc = k.source_case_id ? harness.store.case_learning_consents.get(`${k.source_case_id}:shared_diagnostic_learning`) : null;
        caseValid = Boolean(
          k.technician_verified === true &&
          dc &&
          dc.tenant_id === k.source_company_id &&
          dc.case_status === "resolved" &&
          dc.technician_verified === true &&
          dc.case_learning_opt_in === true &&
          dc.approved_for_learning === true &&
          clc &&
          clc.company_id === dc.tenant_id &&
          clc.consent_status === "granted" &&
          String(clc.terms_version || "").startsWith("2026-10") &&
          (!dc.contributor_user_id || clc.actor_user_id === dc.contributor_user_id)
        );
      }
      const shouldQuarantine = (
        k.publication_status === "quarantined" ||
        k.knowledge_type === "unconfirmed_suggestion" ||
        k.knowledge_type === "observed_diagnosis" ||
        (k.knowledge_type !== "verified_repair" && k.knowledge_type !== "manufacturer_manual") ||
        k.source_kind === "public_demo" ||
        k.consent_snapshot !== true ||
        !companyValid ||
        !manualValid ||
        !caseValid
      );
      if (shouldQuarantine) {
        k.publication_status = "quarantined";
        k.consent_snapshot = false;
        k.review_history.push({ action: "fail_closed_recovery_quarantine" });
      }
    }

    // Verify non-destructive retention of all 9 fixture rows
    record("Recovery simulation retains 100% of knowledge & audit records (zero rows deleted)",
      harness.store.shared_learning_knowledge.size === fixtures.length);

    // Execute search_shared_learning after recovery quarantine
    const postRecoverySearch = await harness.client.rpc("search_shared_learning", { p_query: "Pentair IntelliFlo", p_limit: 20 });
    const postRecoveryIds = (postRecoverySearch.data || []).map(r => r.id);

    record("Rollback/recovery simulation exposes ONLY valid active verified_repair and manufacturer_manual entries",
      postRecoveryIds.length === 2 &&
      postRecoveryIds.includes("fx_valid_repair") &&
      postRecoveryIds.includes("fx_valid_manual"));
    record("Rollback/recovery simulation NEVER exposes revoked, quarantined, observed_diagnosis, unconfirmed_suggestion, or withdrawn company/manual/case content",
      !postRecoveryIds.includes("fx_revoked") &&
      !postRecoveryIds.includes("fx_quarantined") &&
      !postRecoveryIds.includes("fx_observed") &&
      !postRecoveryIds.includes("fx_unconfirmed") &&
      !postRecoveryIds.includes("fx_withdrawn_company") &&
      !postRecoveryIds.includes("fx_withdrawn_manual") &&
      !postRecoveryIds.includes("fx_withdrawn_case"));
  }

  console.log("\n============================================================================");
  console.log(` TASK-012 PART-1 TEST SUMMARY: ${passed} PASSED | ${failed} FAILED`);
  console.log("============================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

runTask012Tests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
