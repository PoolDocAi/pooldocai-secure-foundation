const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const webhookPath = path.join(root, "supabase", "functions", "stripe-webhook", "index.ts");
const webhookSource = fs.readFileSync(webhookPath, "utf8");

function stripTypeScript(ts) {
  return ts
    .replace(/^import\s+.*?;?\s*$/gm, "")
    .replace(/:\s*Request\b/g, "")
    .replace(/:\s*Response\b/g, "")
    .replace(/:\s*Uint8Array\b/g, "")
    .replace(/:\s*\{[^}]+\}\s*\|\s*null/g, "")
    .replace(/:\s*(?:string|number)\s*\|\s*null/g, "")
    .replace(/:\s*string\[\]/g, "")
    .replace(/:\s*string\b/g, "")
    .replace(/:\s*number\b/g, "")
    .replace(/:\s*boolean\b/g, "")
    .replace(/:\s*unknown\b/g, "")
    .replace(/:\s*Record<[^>]+>\s*\|\s*null/g, "").replace(/:\s*Record<[^>]+>/g, "")
    .replace(/:\s*Promise<[^>]+>/g, "")
    .replace(/as\s+Record<string,\s*any>/g, "")
    .replace(/as\s+any/g, "")
    .replace(/as\s+Error/g, "")
    .replace(/:\s*any\b/g, "")
    .replace(/:\s*void\b/g, "");
}

// Extract the handler logic from Deno.serve(async (req: Request) => { ... })
const serveMatch = webhookSource.match(/Deno\.serve\(async\s*\(\w+:\s*Request\)\s*=>\s*\{([\s\S]*)\}\);\s*$/);
assert.ok(serveMatch, "Found Deno.serve block");
const serveBody = stripTypeScript(serveMatch[1]);

// Extract helper functions and constants before Deno.serve
const helpersMatch = webhookSource.match(/^([\s\S]*?)Deno\.serve/);
assert.ok(helpersMatch, "Found helper functions");
const helpersCode = stripTypeScript(helpersMatch[1]);

const WEBHOOK_SECRET = "whsec_test_secret_for_simulation_1234567890";
const SUPABASE_URL = "https://mock.supabase.co";
const SUPABASE_KEY = "mock_service_role_key";

function signPayload(payloadString, secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const signaturePayload = `${timestamp}.${payloadString}`;
  const hmac = crypto.createHmac("sha256", secret).update(signaturePayload).digest("hex");
  return {
    header: `t=${timestamp},v1=${hmac}`,
    timestamp,
    hmac
  };
}

function createHarness(options = {}) {
  let rpcInterceptor = options.rpcInterceptor || null;
  const tables = {
    pooldocai_stripe_webhook_events: new Map(),
    companies: new Map(),
    platform_usage_events: []
  };

  const createMockDb = () => {
    return {
      from(table) {
        if (table === "pooldocai_stripe_webhook_events") {
          return {
            select(cols) {
              return {
                eq(col, val) {
                  return {
                    maybeSingle: async () => {
                      const row = tables.pooldocai_stripe_webhook_events.get(val);
                      return { data: row ? { ...row } : null, error: null };
                    }
                  };
                }
              };
            },
            insert(record) {
              const id = record.stripe_event_id;
              if (tables.pooldocai_stripe_webhook_events.has(id)) {
                return Promise.resolve({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } });
              }
              tables.pooldocai_stripe_webhook_events.set(id, { ...record });
              return Promise.resolve({ data: null, error: null });
            },
            update(fields) {
              return {
                eq(col, val) {
                  const existing = tables.pooldocai_stripe_webhook_events.get(val);
                  if (existing) {
                    tables.pooldocai_stripe_webhook_events.set(val, { ...existing, ...fields });
                  }
                  return Promise.resolve({ data: null, error: null });
                }
              };
            }
          };
        }

        if (table === "companies") {
          return {
            select(cols) {
              return {
                eq(col, val) {
                  return {
                    maybeSingle: async () => {
                      const row = tables.companies.get(val);
                      return { data: row ? { ...row } : null, error: null };
                    }
                  };
                },
                or(filter) {
                  return {
                    maybeSingle: async () => {
                      const match = filter.match(/\.eq\.([a-zA-Z0-9_-]+)/);
                      const cusId = match ? match[1] : "";
                      for (const row of tables.companies.values()) {
                        if (row.stripe_customer_id === cusId || row.billing_customer_ref === cusId) {
                          return { data: { ...row }, error: null };
                        }
                      }
                      return { data: null, error: null };
                    }
                  };
                }
              };
            },
            update(fields) {
              return {
                eq(col, val) {
                  const existing = tables.companies.get(val);
                  if (!existing) return Promise.resolve({ data: null, error: { code: "404", message: "Company not found" } });
                  tables.companies.set(val, { ...existing, ...fields });
                  return Promise.resolve({ data: null, error: null });
                }
              };
            }
          };
        }

        if (table === "platform_usage_events") {
          return {
            insert: async (record) => {
              tables.platform_usage_events.push(record);
              return { data: null, error: null };
            }
          };
        }

        throw new Error(`Unexpected table in webhook test: ${table}`);
      },

      rpc(funcName, params) {
        if (typeof rpcInterceptor === "function") {
          const intercepted = rpcInterceptor(funcName, params);
          if (intercepted !== undefined) return Promise.resolve(intercepted);
        }
        if (funcName === "pooldocai_claim_stripe_webhook_event") {
          const eventId = params.p_event_id;
          const eventType = params.p_event_type;
          const timeoutSec = params.p_lock_timeout_seconds || 60;
          const maxAttempts = params.p_max_attempts || 5;
          const nowMs = Date.now();

          let row = tables.pooldocai_stripe_webhook_events.get(eventId);
          if (!row) {
            row = {
              stripe_event_id: eventId,
              event_type: eventType,
              processed: false,
              attempts: 0,
              claimed_at: null,
              claim_token: null,
              lease_generation: 0,
              processing_error: null
            };
            tables.pooldocai_stripe_webhook_events.set(eventId, row);
          }

          if (row.processed) {
            return Promise.resolve({ data: { status: "already_processed", processed: true, duplicate: true, lease_generation: row.lease_generation }, error: null });
          }

          if (row.claimed_at) {
            const elapsedSec = (nowMs - new Date(row.claimed_at).getTime()) / 1000;
            if (elapsedSec < timeoutSec) {
              const retryAfter = Math.max(1, Math.ceil(timeoutSec - elapsedSec));
              return Promise.resolve({ data: { status: "in_progress", retry_after: retryAfter, attempts: row.attempts, lease_generation: row.lease_generation }, error: null });
            }
          }

          if (row.attempts >= maxAttempts) {
            return Promise.resolve({ data: { status: "max_attempts_exceeded", attempts: row.attempts, processing_error: row.processing_error, lease_generation: row.lease_generation }, error: null });
          }

          const token = "claim_" + crypto.randomBytes(16).toString("hex");
          row.claimed_at = new Date(nowMs).toISOString();
          row.claim_token = token;
          row.lease_generation = (row.lease_generation || 0) + 1;
          row.attempts = (row.attempts || 0) + 1;
          row.event_type = eventType;
          row.processing_error = null;

          return Promise.resolve({ data: { status: "claimed", claim_token: token, lease_generation: row.lease_generation, attempts: row.attempts }, error: null });
        }

        if (funcName === "pooldocai_apply_and_finalize_stripe_webhook") {
          const eventId = params.p_event_id;
          const claimToken = params.p_claim_token;
          const companyId = params.p_company_id;
          const companyUpdates = params.p_company_updates;
          const usageEvent = params.p_usage_event;
          const processingNote = params.p_processing_note;
          const isIgnored = Boolean(params.p_ignored);

          if (!claimToken || typeof claimToken !== "string" || !claimToken.trim()) {
            return Promise.resolve({ data: { success: false, status: "invalid_claim_token", error: "A non-empty claim ownership token is required" }, error: null });
          }

          const row = tables.pooldocai_stripe_webhook_events.get(eventId);
          if (!row) {
            return Promise.resolve({ data: { success: false, status: "not_found", error: "Event not found" }, error: null });
          }

          if (row.processed) {
            return Promise.resolve({ data: { success: false, status: "already_processed", fenced: true, error: "Already processed" }, error: null });
          }

          if (row.claim_token !== claimToken) {
            return Promise.resolve({ data: { success: false, status: "fenced_out", fenced: true, error: "Stale claim token: lease expired or owned by newer worker" }, error: null });
          }

          if (!isIgnored && companyId && companyUpdates && typeof companyUpdates === "object") {
            const company = tables.companies.get(companyId);
            if (!company) {
              return Promise.resolve({ data: { success: false, status: "company_not_found", error: "Company not found" }, error: null });
            }

            // Migration 037 event provenance and authoritative company row-lock validation
            const prov = params.p_event_provenance || {};
            const provSubId = prov.subscription_id || companyUpdates.stripe_subscription_id;
            const provPeriod = prov.period_start || companyUpdates.billing_period_start;
            const provEventCreated = prov.event_created;
            const provEventType = prov.event_type || row.event_type;
            const currentPeriod = company.billing_period_start;
            const currentSubId = company.stripe_subscription_id;

            // Fail-closed provenance check: invoice mutations on tenants with active subscriptions MUST include subscription provenance
            if (provEventType.startsWith("invoice.") && companyUpdates.billing_status && currentSubId) {
              if (!provSubId) {
                return Promise.resolve({
                  data: {
                    success: false,
                    status: "missing_invoice_provenance",
                    error: "Invoice event lacks subscription provenance required to verify tenant subscription binding"
                  },
                  error: null
                });
              }

              if (provSubId === currentSubId && !provPeriod) {
                if (!provEventCreated && currentPeriod) {
                  return Promise.resolve({
                    data: {
                      success: false,
                      status: "missing_invoice_provenance",
                      error: "Invoice event lacks period and event timestamp provenance required to verify freshness"
                    },
                    error: null
                  });
                }
              }
            }

            const isStalePeriod = Boolean(provPeriod && currentPeriod && new Date(provPeriod).getTime() < new Date(currentPeriod).getTime());

            const isOldSub = Boolean(
              currentSubId && provSubId && provSubId !== currentSubId &&
              (
                provEventType.startsWith("invoice.") ||
                provEventType === "customer.subscription.deleted" ||
                companyUpdates.status === "cancelled" ||
                companyUpdates.billing_status === "cancelled" ||
                !provPeriod || !currentPeriod ||
                new Date(provPeriod).getTime() <= new Date(currentPeriod).getTime()
              )
            );

            let isStaleEventTime = false;
            if (!isStalePeriod && !isOldSub && provEventCreated && company.last_billing_event_created) {
              const provTime = new Date(provEventCreated).getTime();
              const lastTime = new Date(company.last_billing_event_created).getTime();
              if (provTime < lastTime) {
                isStaleEventTime = true;
              } else if (provTime === lastTime && companyUpdates.billing_status === "past_due" && company.billing_status === "active") {
                isStaleEventTime = true;
              }
            }

            if (isStalePeriod || isOldSub || isStaleEventTime) {
              const staleReason = isOldSub
                ? (row.event_type.startsWith("invoice.") ? "stale_old_subscription_invoice" : "stale_old_subscription")
                : (row.event_type.startsWith("invoice.") ? "stale_out_of_order_invoice" : "stale_out_of_order_event");
              row.processed = true;
              row.processed_at = new Date().toISOString();
              row.claimed_at = null;
              row.claim_token = null;
              row.processing_error = isOldSub
                ? "Stale event from superseded subscription skipped (newer subscription active in database)."
                : "Stale out-of-order event skipped (newer period or event already active in database).";

              return Promise.resolve({
                data: {
                  success: true,
                  status: "ignored",
                  reason: staleReason,
                  processed: true,
                  lease_generation: row.lease_generation
                },
                error: null
              });
            }

            tables.companies.set(companyId, {
              ...company,
              ...companyUpdates,
              last_billing_event_created: provEventCreated || company.last_billing_event_created || null,
              updated_at: new Date().toISOString()
            });
          }

          if (!isIgnored && usageEvent && typeof usageEvent === "object") {
            tables.platform_usage_events.push(usageEvent);
          }

          row.processed = true;
          row.processed_at = new Date().toISOString();
          row.claimed_at = null;
          row.claim_token = null;
          row.processing_error = processingNote || null;

          return Promise.resolve({ data: { success: true, status: isIgnored ? "ignored" : "applied", processed: true, lease_generation: row.lease_generation }, error: null });
        }

        if (funcName === "pooldocai_release_stripe_webhook_event") {
          const eventId = params.p_event_id;
          const claimToken = params.p_claim_token;
          const errorMsg = params.p_error;

          if (!claimToken || typeof claimToken !== "string" || !claimToken.trim()) {
            return Promise.resolve({ data: { success: false, status: "invalid_claim_token", error: "A non-empty claim token is required" }, error: null });
          }

          const row = tables.pooldocai_stripe_webhook_events.get(eventId);
          if (!row) {
            return Promise.resolve({ data: { success: false, status: "not_found" }, error: null });
          }

          if (row.processed) {
            return Promise.resolve({ data: { success: false, status: "already_processed", fenced: true }, error: null });
          }

          if (row.claim_token !== claimToken) {
            return Promise.resolve({ data: { success: false, status: "fenced_out", fenced: true, error: "Cannot release: claim token does not match active lease" }, error: null });
          }

          row.claimed_at = null;
          row.claim_token = null;
          row.processing_error = errorMsg || null;

          return Promise.resolve({ data: { success: true, status: "released", attempts: row.attempts, lease_generation: row.lease_generation }, error: null });
        }
        throw new Error(`Unexpected RPC in test harness: ${funcName}`);
      }
    };
  };

  const envVars = {
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    SUPABASE_URL: SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: SUPABASE_KEY,
    STRIPE_PRICE_SOLO_TECH: "price_solo_tech_123",
    STRIPE_PRICE_SOLO_COMPLETE: "price_solo_complete_123",
    STRIPE_PRICE_PRO_TECH: "price_pro_tech_123",
    STRIPE_PRICE_PRO_COMPLETE: "price_pro_complete_123",
    STRIPE_PRICE_FLEET_TECH: "price_fleet_tech_123",
    STRIPE_PRICE_FLEET_COMPLETE: "price_fleet_complete_123",
    STRIPE_PRICE_STARTER: "price_starter_123",
    STRIPE_PRICE_PROFESSIONAL: "price_professional_123",
    STRIPE_PRICE_ENTERPRISE: "price_enterprise_123",
    STRIPE_PRICE_PILOT: "price_pilot_123"
  };

  const executeWebhook = async (request) => {
    const sandbox = {
      Request,
      Response,
      TextEncoder,
      crypto: globalThis.crypto,
      createClient: () => createMockDb(),
      Deno: {
        env: {
          get: (k) => envVars[k] || ""
        }
      },
      console
    };

    const scriptCode = `(async () => {\n${helpersCode}\nconst handler = async (req) => {\n${serveBody}\n};\nreturn await handler(request);\n})()`;
    const script = new vm.Script(scriptCode);
    const context = vm.createContext({ ...sandbox, request });
    const response = await script.runInContext(context);
    const bodyText = await response.text();
    let bodyJson = null;
    try { bodyJson = JSON.parse(bodyText); } catch (_) {}
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: bodyJson || bodyText
    };
  };

  const setRpcInterceptor = (fn) => { rpcInterceptor = fn; };
  return { tables, executeWebhook, createMockDb, setRpcInterceptor };
}

async function runExecutableWebhookTests() {
  const harness = createHarness();

  // Seed test company
  const companyId = "comp_simulation_test_1";
  harness.tables.companies.set(companyId, {
    id: companyId,
    name: "Blue Wave Pools",
    status: "active",
    billing_status: "active",
    plan_name: "pro_complete",
    seat_limit: 5,
    stripe_customer_id: "cus_sim_123",
    billing_customer_ref: "cus_sim_123",
    stripe_subscription_id: "sub_initial_123",
    billing_period_start: "2026-03-01T00:00:00.000Z"
  });

  // Test 1: Signature Verification (Valid vs Invalid vs Expired)
  {
    const payload = JSON.stringify({ id: "evt_test_sig", type: "invoice.paid", data: { object: { customer: "cus_sim_123" } } });

    // 1a: Invalid signature string rejected with 400
    const reqInvalid = new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST",
      headers: { "stripe-signature": "t=12345,v1=bad_signature_hex_0000000000000000000000000000000000000000000000000000" },
      body: payload
    });
    const resInvalid = await harness.executeWebhook(reqInvalid);
    assert.equal(resInvalid.status, 400);
    assert.match(resInvalid.body.error, /Invalid/);

    // 1b: Expired signature (> 300s drift) rejected with 400
    const expiredSig = signPayload(payload, WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 400);
    const reqExpired = new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST",
      headers: { "stripe-signature": expiredSig.header },
      body: payload
    });
    const resExpired = await harness.executeWebhook(reqExpired);
    assert.equal(resExpired.status, 400);
    assert.match(resExpired.body.error, /Invalid or expired/);

    // 1c: Valid signature accepted
    const validSig = signPayload(payload, WEBHOOK_SECRET);
    const reqValid = new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST",
      headers: { "stripe-signature": validSig.header },
      body: payload
    });
    const resValid = await harness.executeWebhook(reqValid);
    assert.equal(resValid.status, 200);
    assert.equal(resValid.body.ok, true);
  }

  // Test 2: Idempotent Duplicate Delivery
  {
    const payload = JSON.stringify({ id: "evt_duplicate_test", type: "invoice.payment_succeeded", data: { object: { customer: "cus_sim_123" } } });
    const sig = signPayload(payload, WEBHOOK_SECRET);

    // First delivery -> processed: true
    const res1 = await harness.executeWebhook(new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST", headers: { "stripe-signature": sig.header }, body: payload
    }));
    assert.equal(res1.status, 200);
    assert.equal(res1.body.processed, true);

    // Second delivery of same event -> duplicate: true
    const res2 = await harness.executeWebhook(new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST", headers: { "stripe-signature": sig.header }, body: payload
    }));
    assert.equal(res2.status, 200);
    assert.equal(res2.body.ok, true);
    assert.equal(res2.body.duplicate, true);
  }

  // Test 3: Concurrent In-Flight Delivery (HTTP 409 Retry-After)
  {
    const eventId = "evt_concurrent_in_flight";
    harness.tables.pooldocai_stripe_webhook_events.set(eventId, {
      stripe_event_id: eventId,
      event_type: "customer.subscription.updated",
      processed: false,
      claimed_at: new Date().toISOString(),
      attempts: 1
    });
    const payload = JSON.stringify({ id: eventId, type: "customer.subscription.updated", data: { object: { id: "sub_concurrent" } } });
    const sig = signPayload(payload, WEBHOOK_SECRET);

    const resRaced = await harness.executeWebhook(new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST", headers: { "stripe-signature": sig.header }, body: payload
    }));
    assert.equal(resRaced.status, 409);
    assert.equal(resRaced.body.in_progress, true);
    assert.ok(resRaced.headers["retry-after"]);
  }

  // Test 4: Out-of-Order Delivery (Older period start skipped)
  {
    // Company currently has billing_period_start = "2026-03-01T00:00:00.000Z"
    // Event has earlier period start: Feb 1, 2026 (timestamp 1769904000)
    const feb1Timestamp = Math.floor(new Date("2026-02-01T00:00:00.000Z").getTime() / 1000);
    const stalePayload = JSON.stringify({
      id: "evt_stale_out_of_order",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_initial_123",
          status: "active",
          current_period_start: feb1Timestamp,
          current_period_end: feb1Timestamp + 2592000,
          metadata: { pooldocai_company_id: companyId, plan_name: "solo_tech", seat_limit: "1" }
        }
      }
    });
    const sig = signPayload(stalePayload, WEBHOOK_SECRET);
    const resStale = await harness.executeWebhook(new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST", headers: { "stripe-signature": sig.header }, body: stalePayload
    }));
    assert.equal(resStale.status, 200);
    assert.equal(resStale.body.ignored, true);
    assert.equal(resStale.body.reason, "stale_out_of_order_event");

    // Company plan and seat limit MUST NOT have been downgraded
    const compAfterStale = harness.tables.companies.get(companyId);
    assert.equal(compAfterStale.plan_name, "pro_complete");
    assert.equal(compAfterStale.seat_limit, 5);
  }

  // Test 5: Old-Subscription Deletion (Superseded subscription deletion must NOT cancel current active subscription)
  {
    // Company is on sub_initial_123. A delayed deletion arrives for old superseded sub_old_historical.
    const oldDelPayload = JSON.stringify({
      id: "evt_old_sub_deleted",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_old_historical",
          status: "canceled",
          current_period_start: Math.floor(new Date("2026-01-01T00:00:00.000Z").getTime() / 1000),
          metadata: { pooldocai_company_id: companyId }
        }
      }
    });
    const sig = signPayload(oldDelPayload, WEBHOOK_SECRET);
    const resOldDel = await harness.executeWebhook(new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST", headers: { "stripe-signature": sig.header }, body: oldDelPayload
    }));
    assert.equal(resOldDel.status, 200);
    assert.equal(resOldDel.body.ignored, true);
    assert.equal(resOldDel.body.reason, "stale_old_subscription");

    // Verify company remains active with sub_initial_123
    const compAfterOldDel = harness.tables.companies.get(companyId);
    assert.equal(compAfterOldDel.status, "active");
    assert.equal(compAfterOldDel.stripe_subscription_id, "sub_initial_123");
  }

  // Test 6: Resubscription (New subscription with newer period start reactivates cancelled company)
  {
    // First, simulate real cancellation of the current subscription
    const currentDelPayload = JSON.stringify({
      id: "evt_current_sub_cancelled",
      type: "customer.subscription.deleted",
      data: {
        object: {
          id: "sub_initial_123",
          status: "canceled",
          current_period_start: Math.floor(new Date("2026-03-01T00:00:00.000Z").getTime() / 1000),
          metadata: { pooldocai_company_id: companyId }
        }
      }
    });
    const sigDel = signPayload(currentDelPayload, WEBHOOK_SECRET);
    const resDel = await harness.executeWebhook(new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST", headers: { "stripe-signature": sigDel.header }, body: currentDelPayload
    }));
    assert.equal(resDel.status, 200);
    assert.equal(resDel.body.processed, true);

    const compCancelled = harness.tables.companies.get(companyId);
    assert.equal(compCancelled.status, "cancelled");
    assert.equal(compCancelled.billing_status, "cancelled");

    // Now resubscribe with sub_resub_fleet (fleet_complete) starting April 1, 2026
    const apr1Timestamp = Math.floor(new Date("2026-04-01T00:00:00.000Z").getTime() / 1000);
    const resubPayload = JSON.stringify({
      id: "evt_resub_fleet",
      type: "customer.subscription.created",
      data: {
        object: {
          id: "sub_resub_fleet",
          status: "active",
          current_period_start: apr1Timestamp,
          current_period_end: apr1Timestamp + 2592000,
          items: { data: [{ price: "price_fleet_complete_123", quantity: 1 }] },
          metadata: { pooldocai_company_id: companyId, plan_name: "fleet_complete", seat_limit: "15" }
        }
      }
    });
    const sigResub = signPayload(resubPayload, WEBHOOK_SECRET);
    const resResub = await harness.executeWebhook(new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST", headers: { "stripe-signature": sigResub.header }, body: resubPayload
    }));
    assert.equal(resResub.status, 200);
    assert.equal(resResub.body.processed, true);

    // Verify company is reactivated to active status with fleet_complete and 15 seats
    const compReactivated = harness.tables.companies.get(companyId);
    assert.equal(compReactivated.status, "active");
    assert.equal(compReactivated.billing_status, "active");
    assert.equal(compReactivated.stripe_subscription_id, "sub_resub_fleet");
    assert.equal(compReactivated.plan_name, "fleet_complete");
    assert.equal(compReactivated.seat_limit, 15);
  }

  // Test 7: Payment Failure and Recovery
  {
    const epochNow = Math.floor(Date.now() / 1000);
    // Payment failure -> past_due
    const failPayload = JSON.stringify({
      id: "evt_pay_failed",
      type: "invoice.payment_failed",
      created: epochNow,
      data: { object: { customer: "cus_sim_123", subscription: "sub_resub_fleet", period_start: epochNow, period_end: epochNow + 2592000 } }
    });
    const sigFail = signPayload(failPayload, WEBHOOK_SECRET);
    await harness.executeWebhook(new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST", headers: { "stripe-signature": sigFail.header }, body: failPayload
    }));
    assert.equal(harness.tables.companies.get(companyId).billing_status, "past_due");

    // Payment recovery -> active
    const recPayload = JSON.stringify({
      id: "evt_pay_recovered",
      type: "invoice.payment_succeeded",
      created: epochNow + 60,
      data: { object: { customer: "cus_sim_123", subscription: "sub_resub_fleet", period_start: epochNow, period_end: epochNow + 2592000 } }
    });
    const sigRec = signPayload(recPayload, WEBHOOK_SECRET);
    await harness.executeWebhook(new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST", headers: { "stripe-signature": sigRec.header }, body: recPayload
    }));
    assert.equal(harness.tables.companies.get(companyId).billing_status, "active");
  }

  // Test 8: Unrelated Customer Event Acknowledged Without Tenant Mutation
  {
    const unrelatedPayload = JSON.stringify({ id: "evt_unrelated_cus", type: "invoice.paid", data: { object: { customer: "cus_unknown_stranger" } } });
    const sigUnrelated = signPayload(unrelatedPayload, WEBHOOK_SECRET);
    const resUnrelated = await harness.executeWebhook(new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST", headers: { "stripe-signature": sigUnrelated.header }, body: unrelatedPayload
    }));
    assert.equal(resUnrelated.status, 200);
    assert.equal(resUnrelated.body.ignored, true);
    assert.equal(resUnrelated.body.reason, "no_company_match");
  }

  // Test 9: Stale Invoice from Superseded Subscription Cannot Degrade Newer Subscription
  {
    // The company is currently on sub_resub_fleet (active).
    const currentSubId = harness.tables.companies.get(companyId).stripe_subscription_id;
    assert.equal(currentSubId, "sub_resub_fleet");
    assert.equal(harness.tables.companies.get(companyId).billing_status, "active");

    // A delayed failed invoice arrives belonging to the OLD subscription sub_initial_123
    const oldSubInvoicePayload = JSON.stringify({
      id: "evt_inv_fail_old_sub",
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_old_sub_fail",
          customer: "cus_sim_123",
          subscription: "sub_initial_123",
          period_start: Math.floor(new Date("2026-03-01T00:00:00.000Z").getTime() / 1000)
        }
      }
    });
    const sigOldInv = signPayload(oldSubInvoicePayload, WEBHOOK_SECRET);
    const resOldInv = await harness.executeWebhook(new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST", headers: { "stripe-signature": sigOldInv.header }, body: oldSubInvoicePayload
    }));
    assert.equal(resOldInv.status, 200);
    assert.equal(resOldInv.body.ignored, true);
    assert.equal(resOldInv.body.reason, "stale_old_subscription_invoice");

    // Confirm company billing status was NOT degraded to past_due
    assert.equal(harness.tables.companies.get(companyId).billing_status, "active");
  }

  // Test 10: Stale Out-of-Order Invoice for Current Subscription Cannot Overwrite Newer Period
  {
    // A delayed payment failure arrives with period_start in February 2026 (older than April 2026)
    const febTimestamp = Math.floor(new Date("2026-02-01T00:00:00.000Z").getTime() / 1000);
    const stalePeriodPayload = JSON.stringify({
      id: "evt_inv_fail_stale_period",
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_stale_feb_fail",
          customer: "cus_sim_123",
          subscription: "sub_resub_fleet",
          period_start: febTimestamp
        }
      }
    });
    const sigStale = signPayload(stalePeriodPayload, WEBHOOK_SECRET);
    const resStale = await harness.executeWebhook(new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST", headers: { "stripe-signature": sigStale.header }, body: stalePeriodPayload
    }));
    assert.equal(resStale.status, 200);
    assert.equal(resStale.body.ignored, true);
    assert.equal(resStale.body.reason, "stale_out_of_order_invoice");

    // Company remains active
    assert.equal(harness.tables.companies.get(companyId).billing_status, "active");
  }

  // Test 11: Duplicate Invoice Delivery Handled Idempotently
  {
    // Send a valid payment failure for the current period
    const aprTimestamp = Math.floor(new Date("2026-04-01T00:00:00.000Z").getTime() / 1000);
    const validFailPayload = JSON.stringify({
      id: "evt_inv_fail_current",
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_current_fail",
          customer: "cus_sim_123",
          subscription: "sub_resub_fleet",
          period_start: aprTimestamp
        }
      }
    });
    const sigValidFail = signPayload(validFailPayload, WEBHOOK_SECRET);
    const resValidFail = await harness.executeWebhook(new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST", headers: { "stripe-signature": sigValidFail.header }, body: validFailPayload
    }));
    assert.equal(resValidFail.status, 200);
    assert.equal(resValidFail.body.processed, true);
    assert.equal(harness.tables.companies.get(companyId).billing_status, "past_due");

    // Deliver the exact duplicate event
    const resDuplicate = await harness.executeWebhook(new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST", headers: { "stripe-signature": sigValidFail.header }, body: validFailPayload
    }));
    assert.equal(resDuplicate.status, 200);
    assert.equal(resDuplicate.body.ok, true);
    assert.equal(resDuplicate.body.duplicate, true);

    // Send a valid payment recovery for the current period
    const validSuccessPayload = JSON.stringify({
      id: "evt_inv_success_current",
      type: "invoice.payment_succeeded",
      data: {
        object: {
          id: "in_current_success",
          customer: "cus_sim_123",
          subscription: "sub_resub_fleet",
          period_start: aprTimestamp
        }
      }
    });
    const sigValidSuccess = signPayload(validSuccessPayload, WEBHOOK_SECRET);
    const resValidSuccess = await harness.executeWebhook(new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST", headers: { "stripe-signature": sigValidSuccess.header }, body: validSuccessPayload
    }));
    assert.equal(resValidSuccess.status, 200);
    assert.equal(resValidSuccess.body.processed, true);
    assert.equal(harness.tables.companies.get(companyId).billing_status, "active");
  }

  // Test 12: Concurrent Claiming and In-Flight Exclusion
  {
    const eventId = "evt_simultaneous_race";
    const payload = JSON.stringify({
      id: eventId,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_resub_fleet",
          status: "active",
          current_period_start: Math.floor(new Date("2026-04-01T00:00:00.000Z").getTime() / 1000),
          current_period_end: Math.floor(new Date("2026-05-01T00:00:00.000Z").getTime() / 1000),
          items: { data: [{ price: "price_fleet_complete_123", quantity: 1 }] },
          metadata: { pooldocai_company_id: companyId, plan_name: "fleet_complete" }
        }
      }
    });
    const sig = signPayload(payload, WEBHOOK_SECRET);

    // 12a: Worker A claims the event and is actively in flight
    harness.tables.pooldocai_stripe_webhook_events.set(eventId, {
      stripe_event_id: eventId,
      event_type: "customer.subscription.updated",
      processed: false,
      claimed_at: new Date().toISOString(),
      attempts: 1
    });

    // Worker B attempts to process the same event concurrently while A is in flight
    const resB = await harness.executeWebhook(new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST", headers: { "stripe-signature": sig.header }, body: payload
    }));

    // Worker B MUST be rejected with HTTP 409 Retry-After and cannot apply the event
    assert.equal(resB.status, 409);
    assert.equal(resB.body.in_progress, true);
    assert.ok(resB.headers["retry-after"]);

    // 12b: Worker A finishes processing and marks row processed
    harness.tables.pooldocai_stripe_webhook_events.set(eventId, {
      stripe_event_id: eventId,
      event_type: "customer.subscription.updated",
      processed: true,
      claimed_at: null,
      attempts: 1
    });

    // Worker B retries after Worker A finished
    const resBRetry = await harness.executeWebhook(new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST", headers: { "stripe-signature": sig.header }, body: payload
    }));

    // Worker B receives idempotent acknowledgment (HTTP 200 duplicate: true)
    assert.equal(resBRetry.status, 200);
    assert.equal(resBRetry.body.ok, true);
    assert.equal(resBRetry.body.duplicate, true);
  }

  // Test 13: Crash / Failure Recovery (First attempt errors, second attempt resumes and succeeds)
  {
    const eventId = "evt_crash_recovery_test";
    const payload = JSON.stringify({
      id: eventId,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_resub_fleet",
          status: "active",
          current_period_start: Math.floor(new Date("2026-04-01T00:00:00.000Z").getTime() / 1000),
          metadata: { pooldocai_company_id: companyId, plan_name: "fleet_complete" }
        }
      }
    });
    const sig = signPayload(payload, WEBHOOK_SECRET);

    // Simulate initial attempt that started, failed, and recorded error
    harness.tables.pooldocai_stripe_webhook_events.set(eventId, {
      stripe_event_id: eventId,
      event_type: "customer.subscription.updated",
      processed: false,
      claimed_at: null, // released on error
      attempts: 1,
      processing_error: "Transient network timeout to database"
    });

    // Second delivery arrives (e.g. Stripe retry)
    const resRetry = await harness.executeWebhook(new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST", headers: { "stripe-signature": sig.header }, body: payload
    }));

    assert.equal(resRetry.status, 200);
    assert.equal(resRetry.body.processed, true);
    const rowAfter = harness.tables.pooldocai_stripe_webhook_events.get(eventId);
    assert.equal(rowAfter.processed, true);
    assert.equal(rowAfter.attempts, 2, "Attempts counter incremented on retry");
    assert.equal(rowAfter.claimed_at, null);
    assert.equal(rowAfter.processing_error, null);
  }

  // Test 14: Expired Lease Timeout Recovery (Worker died hard without cleanup)
  {
    const eventId = "evt_expired_lease_recovery";
    const payload = JSON.stringify({
      id: eventId,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_resub_fleet",
          status: "active",
          current_period_start: Math.floor(new Date("2026-04-01T00:00:00.000Z").getTime() / 1000),
          metadata: { pooldocai_company_id: companyId, plan_name: "fleet_complete" }
        }
      }
    });
    const sig = signPayload(payload, WEBHOOK_SECRET);

    // Simulate dead worker that claimed 70 seconds ago (lease expired)
    harness.tables.pooldocai_stripe_webhook_events.set(eventId, {
      stripe_event_id: eventId,
      event_type: "customer.subscription.updated",
      processed: false,
      claimed_at: new Date(Date.now() - 70_000).toISOString(),
      attempts: 1
    });

    const resExpiredLease = await harness.executeWebhook(new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST", headers: { "stripe-signature": sig.header }, body: payload
    }));

    assert.equal(resExpiredLease.status, 200);
    assert.equal(resExpiredLease.body.processed, true);
    const rowExpiredAfter = harness.tables.pooldocai_stripe_webhook_events.get(eventId);
    assert.equal(rowExpiredAfter.processed, true);
    assert.equal(rowExpiredAfter.attempts, 2);
  }

  // Test 15: Bounded Retry Protection (Max attempts exceeded)
  {
    const eventId = "evt_max_attempts_test";
    const payload = JSON.stringify({
      id: eventId,
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_resub_fleet",
          status: "active",
          current_period_start: Math.floor(new Date("2026-04-01T00:00:00.000Z").getTime() / 1000),
          metadata: { pooldocai_company_id: companyId }
        }
      }
    });
    const sig = signPayload(payload, WEBHOOK_SECRET);

    // Set row to 5 attempts
    harness.tables.pooldocai_stripe_webhook_events.set(eventId, {
      stripe_event_id: eventId,
      event_type: "customer.subscription.updated",
      processed: false,
      claimed_at: null,
      attempts: 5,
      processing_error: "Repeated unrecoverable error"
    });

    const resMax = await harness.executeWebhook(new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST", headers: { "stripe-signature": sig.header }, body: payload
    }));

    assert.equal(resMax.status, 422);
    assert.equal(resMax.body.max_attempts_exceeded, true);
  }

  // Test 16: Claim Token Generation and Monotonic Lease Sequence
  {
    const eventId = "evt_token_sequence_test";
    const db = harness.createMockDb();

    // First claim
    const claim1 = await db.rpc("pooldocai_claim_stripe_webhook_event", {
      p_event_id: eventId,
      p_event_type: "customer.subscription.updated",
      p_lock_timeout_seconds: 60,
      p_max_attempts: 5
    });

    assert.equal(claim1.data.status, "claimed");
    assert.ok(claim1.data.claim_token && claim1.data.claim_token.startsWith("claim_"), "Must return valid claim token");
    assert.equal(claim1.data.lease_generation, 1, "First lease generation must be 1");

    // Advance time past lease timeout (simulate expiration)
    const row = harness.tables.pooldocai_stripe_webhook_events.get(eventId);
    row.claimed_at = new Date(Date.now() - 70_000).toISOString();

    // Second claim by a new worker
    const claim2 = await db.rpc("pooldocai_claim_stripe_webhook_event", {
      p_event_id: eventId,
      p_event_type: "customer.subscription.updated",
      p_lock_timeout_seconds: 60,
      p_max_attempts: 5
    });

    assert.equal(claim2.data.status, "claimed");
    assert.ok(claim2.data.claim_token && claim2.data.claim_token.startsWith("claim_"));
    assert.notEqual(claim2.data.claim_token, claim1.data.claim_token, "Subsequent lease must have distinct unpredictable token");
    assert.equal(claim2.data.lease_generation, 2, "Lease generation must monotonically increment");
  }

  // Test 17: Fencing Out Stale Worker After Expired Lease Takeover (Prevents Stale DB Mutations)
  {
    const eventId = "evt_stale_worker_fenced_out";
    const db = harness.createMockDb();

    // 1. Worker A claims event
    const claimA = await db.rpc("pooldocai_claim_stripe_webhook_event", {
      p_event_id: eventId,
      p_event_type: "customer.subscription.updated",
      p_lock_timeout_seconds: 60,
      p_max_attempts: 5
    });
    const tokenA = claimA.data.claim_token;

    // 2. Worker A experiences long delay; lease expires
    const row = harness.tables.pooldocai_stripe_webhook_events.get(eventId);
    row.claimed_at = new Date(Date.now() - 70_000).toISOString();

    // 3. Worker B claims event
    const claimB = await db.rpc("pooldocai_claim_stripe_webhook_event", {
      p_event_id: eventId,
      p_event_type: "customer.subscription.updated",
      p_lock_timeout_seconds: 60,
      p_max_attempts: 5
    });
    const tokenB = claimB.data.claim_token;
    assert.notEqual(tokenA, tokenB);

    // 4. Stale Worker A wakes up and attempts to mutate company billing using stale tokenA
    const staleApply = await db.rpc("pooldocai_apply_and_finalize_stripe_webhook", {
      p_event_id: eventId,
      p_claim_token: tokenA,
      p_company_id: companyId,
      p_company_updates: { plan_name: "starter" },
      p_usage_event: null,
      p_processing_note: null,
      p_ignored: false
    });

    assert.equal(staleApply.data.success, false, "Stale worker apply must fail");
    assert.equal(staleApply.data.fenced, true, "Stale worker must be flagged as fenced");
    assert.equal(staleApply.data.status, "fenced_out");

    // Verify company was NOT modified by stale Worker A
    const company = harness.tables.companies.get(companyId);
    assert.notEqual(company.plan_name, "starter", "Company plan must not be corrupted by stale worker");

    // 5. Active Worker B applies legitimate update
    const validApply = await db.rpc("pooldocai_apply_and_finalize_stripe_webhook", {
      p_event_id: eventId,
      p_claim_token: tokenB,
      p_company_id: companyId,
      p_company_updates: { plan_name: "pro_complete" },
      p_usage_event: { company_id: companyId, event_type: "stripe_customer.subscription.updated" },
      p_processing_note: null,
      p_ignored: false
    });

    assert.equal(validApply.data.success, true);
    assert.equal(validApply.data.processed, true);
    assert.equal(harness.tables.companies.get(companyId).plan_name, "pro_complete");
  }

  // Test 18: Fencing Out Stale Worker Error/Release (Protects Active Worker's Lease)
  {
    const eventId = "evt_stale_release_fenced_out";
    const db = harness.createMockDb();

    // 1. Worker A claims
    const claimA = await db.rpc("pooldocai_claim_stripe_webhook_event", {
      p_event_id: eventId,
      p_event_type: "invoice.payment_failed",
      p_lock_timeout_seconds: 60,
      p_max_attempts: 5
    });
    const tokenA = claimA.data.claim_token;

    // 2. Lease expires
    const row = harness.tables.pooldocai_stripe_webhook_events.get(eventId);
    row.claimed_at = new Date(Date.now() - 70_000).toISOString();

    // 3. Worker B claims
    const claimB = await db.rpc("pooldocai_claim_stripe_webhook_event", {
      p_event_id: eventId,
      p_event_type: "invoice.payment_failed",
      p_lock_timeout_seconds: 60,
      p_max_attempts: 5
    });
    const tokenB = claimB.data.claim_token;

    // 4. Stale Worker A errors and tries to release the claim with stale tokenA
    const staleRelease = await db.rpc("pooldocai_release_stripe_webhook_event", {
      p_event_id: eventId,
      p_claim_token: tokenA,
      p_error: "Stale worker crash message"
    });

    assert.equal(staleRelease.data.success, false);
    assert.equal(staleRelease.data.fenced, true);

    // Verify Worker B's active claim was NOT destroyed
    const rowActive = harness.tables.pooldocai_stripe_webhook_events.get(eventId);
    assert.equal(rowActive.claim_token, tokenB, "Worker B's claim token must remain active");
    assert.ok(rowActive.claimed_at !== null, "Worker B's lease must remain held");
  }

  // Test 19: Strict Rejection of Empty/Unknown Claim Tokens
  {
    const db = harness.createMockDb();
    const badApply = await db.rpc("pooldocai_apply_and_finalize_stripe_webhook", {
      p_event_id: "evt_some_event",
      p_claim_token: "",
      p_ignored: true
    });
    assert.equal(badApply.data.success, false);
    assert.equal(badApply.data.status, "invalid_claim_token");

    const badRelease = await db.rpc("pooldocai_release_stripe_webhook_event", {
      p_event_id: "evt_some_event",
      p_claim_token: "   ",
      p_error: "err"
    });
    assert.equal(badRelease.data.success, false);
    assert.equal(badRelease.data.status, "invalid_claim_token");
  }

    // Test 20: Injected RPC Failure Handling During Ignore Finalization
  {
    // 20a: Transport failure when finalizing ignored event throws error and returns 500
    {
      const harness20 = createHarness();
      harness20.setRpcInterceptor((funcName, params) => {
        if (funcName === "pooldocai_apply_and_finalize_stripe_webhook" && params.p_ignored) {
          return { data: null, error: { message: "Simulated RPC transport failure during ignore" } };
        }
        return undefined;
      });

      const payload = JSON.stringify({
        id: "evt_ignore_transport_fail_1",
        type: "customer.subscription.updated",
        data: { object: { id: "sub_unknown", customer: "cus_unknown_co" } }
      });
      const sig = signPayload(payload);
      const req = new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
        method: "POST",
        headers: { "stripe-signature": sig.header },
        body: payload
      });
      const res = await harness20.executeWebhook(req);
      assert.equal(res.status, 500, "Transport error on ignore must return HTTP 500 so Stripe can retry");
      assert.equal(res.body.code, "STRIPE_WEBHOOK_APPLY_FAILED");
    }

    // 20b: Fenced out when finalizing ignored event returns HTTP 409
    {
      const harness20b = createHarness();
      harness20b.setRpcInterceptor((funcName, params) => {
        if (funcName === "pooldocai_apply_and_finalize_stripe_webhook" && params.p_ignored) {
          return { data: { success: false, status: "fenced_out", fenced: true, error: "Stale claim" }, error: null };
        }
        return undefined;
      });

      const payload = JSON.stringify({
        id: "evt_ignore_fenced_fail_1",
        type: "customer.subscription.updated",
        data: { object: { id: "sub_unknown", customer: "cus_unknown_co" } }
      });
      const sig = signPayload(payload);
      const req = new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
        method: "POST",
        headers: { "stripe-signature": sig.header },
        body: payload
      });
      const res = await harness20b.executeWebhook(req);
      assert.equal(res.status, 409, "Fenced out ignore must return HTTP 409");
      assert.equal(res.body.code, "STRIPE_WEBHOOK_FENCED_OUT");
    }

    // 20c: Successful ignore finalization returns HTTP 200 with ok: true, ignored: true
    {
      const harness20c = createHarness();
      const payload = JSON.stringify({
        id: "evt_ignore_success_1",
        type: "customer.subscription.updated",
        data: { object: { id: "sub_unknown", customer: "cus_unknown_co" } }
      });
      const sig = signPayload(payload);
      const req = new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
        method: "POST",
        headers: { "stripe-signature": sig.header },
        body: payload
      });
      const res = await harness20c.executeWebhook(req);
      assert.equal(res.status, 200, "Successful ignore must return HTTP 200");
      assert.equal(res.body.ok, true);
      assert.equal(res.body.ignored, true);
      assert.equal(res.body.reason, "no_company_match");
    }
  }

  // Test 21: Cross-Event Ordering Guard on Same Company (Migration 035 Conditional Check)
  {
    const harness21 = createHarness();
    const testCoId = "comp_ordering_test_21";
    harness21.tables.companies.set(testCoId, {
      id: testCoId,
      name: "Ordering Test Pool Co",
      status: "active",
      billing_status: "active",
      plan_name: "pro_complete",
      seat_limit: 5,
      stripe_customer_id: "cus_order_21",
      billing_customer_ref: "cus_order_21",
      stripe_subscription_id: "sub_order_21",
      billing_period_start: "2026-03-01T00:00:00.000Z"
    });

    // 21a: Stale February event arrives for company already at March -> DB ignores under company row lock
    const febEpoch = Math.floor(new Date("2026-02-01T00:00:00Z").getTime() / 1000);
    const febPayloadExact = JSON.stringify({
      id: "evt_order_feb_21",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_order_21",
          customer: "cus_order_21",
          status: "active",
          current_period_start: febEpoch,
          current_period_end: febEpoch + 2592000,
          items: {
            data: [{ price: "price_solo_tech_123", quantity: 1 }]
          },
          metadata: { pooldocai_company_id: testCoId }
        }
      }
    });

    const sigFeb = signPayload(febPayloadExact);
    const reqFeb = new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST",
      headers: { "stripe-signature": sigFeb.header },
      body: febPayloadExact
    });
    const resFeb = await harness21.executeWebhook(reqFeb);
    assert.equal(resFeb.status, 200);
    assert.equal(resFeb.body.ok, true);
    assert.equal(resFeb.body.ignored, true);
    assert.equal(resFeb.body.reason, "stale_out_of_order_event");

    // Verify company state remains March pro_complete
    const coAfterFeb = harness21.tables.companies.get(testCoId);
    assert.equal(coAfterFeb.plan_name, "pro_complete");
    assert.equal(coAfterFeb.billing_period_start, "2026-03-01T00:00:00.000Z");

    // 21b: Newer April event arrives -> applies cleanly
    const aprEpoch = Math.floor(new Date("2026-04-01T00:00:00Z").getTime() / 1000);
    const aprPayload = JSON.stringify({
      id: "evt_order_apr_21",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_order_21",
          customer: "cus_order_21",
          status: "active",
          current_period_start: aprEpoch,
          current_period_end: aprEpoch + 2592000,
          items: {
            data: [{ price: "price_enterprise_123", quantity: 1 }]
          },
          metadata: { pooldocai_company_id: testCoId }
        }
      }
    });
    const sigApr = signPayload(aprPayload);
    const reqApr = new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST",
      headers: { "stripe-signature": sigApr.header },
      body: aprPayload
    });
    const resApr = await harness21.executeWebhook(reqApr);
    assert.equal(resApr.status, 200);
    assert.equal(resApr.body.ok, true);
    assert.equal(resApr.body.processed, true);

    const coAfterApr = harness21.tables.companies.get(testCoId);
    assert.equal(coAfterApr.plan_name, "enterprise");
    assert.equal(new Date(coAfterApr.billing_period_start).getTime(), new Date("2026-04-01T00:00:00Z").getTime());
  }

  // Test 22: Old Subscription Invoice vs Replacement Subscription (Migration 036 Provenance Guard)
  {
    const harness22 = createHarness();
    const testCoId = "comp_provenance_test_22";
    harness22.tables.companies.set(testCoId, {
      id: testCoId,
      name: "Provenance Test Pool Co",
      status: "active",
      billing_status: "active",
      plan_name: "pro_complete",
      seat_limit: 5,
      stripe_customer_id: "cus_prov_22",
      billing_customer_ref: "cus_prov_22",
      stripe_subscription_id: "sub_initial_a",
      billing_period_start: "2026-03-01T00:00:00.000Z"
    });

    // 22a: Replacement Subscription B arrives and applies
    const subBEpoch = Math.floor(new Date("2026-03-15T00:00:00Z").getTime() / 1000);
    const subBPayload = JSON.stringify({
      id: "evt_sub_b_replacement",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_replacement_b",
          customer: "cus_prov_22",
          status: "active",
          current_period_start: subBEpoch,
          current_period_end: subBEpoch + 2592000,
          items: {
            data: [{ price: "price_enterprise_123", quantity: 1 }]
          },
          metadata: { pooldocai_company_id: testCoId }
        }
      }
    });
    const sigSubB = signPayload(subBPayload);
    const reqSubB = new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST",
      headers: { "stripe-signature": sigSubB.header },
      body: subBPayload
    });
    const resSubB = await harness22.executeWebhook(reqSubB);
    assert.equal(resSubB.status, 200);
    assert.equal(resSubB.body.processed, true);

    const coAfterSubB = harness22.tables.companies.get(testCoId);
    assert.equal(coAfterSubB.stripe_subscription_id, "sub_replacement_b");
    assert.equal(coAfterSubB.plan_name, "enterprise");
    assert.equal(coAfterSubB.billing_status, "active");

    // 22b: Stale invoice.payment_failed for old subscription sub_initial_a arrives
    // It has customer cus_prov_22, subscription sub_initial_a, period 2026-02-15
    const invAEpoch = Math.floor(new Date("2026-02-15T00:00:00Z").getTime() / 1000);
    const invAPayload = JSON.stringify({
      id: "evt_inv_a_failed",
      type: "invoice.payment_failed",
      data: {
        object: {
          id: "in_old_sub_a_fail",
          customer: "cus_prov_22",
          subscription: "sub_initial_a",
          period_start: invAEpoch,
          period_end: invAEpoch + 2592000,
          lines: {
            data: [{ period: { start: invAEpoch, end: invAEpoch + 2592000 } }]
          }
        }
      }
    });
    const sigInvA = signPayload(invAPayload);
    const reqInvA = new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST",
      headers: { "stripe-signature": sigInvA.header },
      body: invAPayload
    });
    const resInvA = await harness22.executeWebhook(reqInvA);
    assert.equal(resInvA.status, 200, "Old invoice must return 200 so Stripe does not retry indefinitely");
    assert.equal(resInvA.body.ok, true);
    assert.equal(resInvA.body.ignored, true);
    assert.equal(resInvA.body.reason, "stale_old_subscription_invoice");

    // CRITICAL: Prove company was NOT flipped to past_due and subscription B was NOT overwritten!
    const coAfterInvA = harness22.tables.companies.get(testCoId);
    assert.equal(coAfterInvA.stripe_subscription_id, "sub_replacement_b", "Must NOT overwrite active subscription ID");
    assert.equal(coAfterInvA.plan_name, "enterprise", "Must remain enterprise");
    assert.equal(coAfterInvA.billing_status, "active", "Must NOT be downgraded to past_due by old subscription invoice");

    // 22c: Legitimate invoice.payment_succeeded on active subscription B applies cleanly
    const invBEpoch = Math.floor(new Date("2026-03-15T00:00:00Z").getTime() / 1000);
    const invBPayload = JSON.stringify({
      id: "evt_inv_b_succeeded",
      type: "invoice.payment_succeeded",
      data: {
        object: {
          id: "in_sub_b_paid",
          customer: "cus_prov_22",
          subscription: "sub_replacement_b",
          period_start: invBEpoch,
          period_end: invBEpoch + 2592000
        }
      }
    });
    const sigInvB = signPayload(invBPayload);
    const reqInvB = new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST",
      headers: { "stripe-signature": sigInvB.header },
      body: invBPayload
    });
    const resInvB = await harness22.executeWebhook(reqInvB);
    assert.equal(resInvB.status, 200);
    assert.equal(resInvB.body.processed, true);
    assert.equal(harness22.tables.companies.get(testCoId).billing_status, "active");

    // 22d: Missing subscription ID with present period fails closed
    harness22.tables.pooldocai_stripe_webhook_events.set("evt_missing_sub_id", {
      stripe_event_id: "evt_missing_sub_id",
      event_type: "invoice.payment_failed",
      processed: false,
      claim_token: "claim_test_sub_1"
    });
    const missingSubRes = await harness22.createMockDb().rpc("pooldocai_apply_and_finalize_stripe_webhook", {
      p_event_id: "evt_missing_sub_id",
      p_claim_token: "claim_test_sub_1",
      p_company_id: testCoId,
      p_company_updates: { billing_status: "past_due" },
      p_event_provenance: { event_type: "invoice.payment_failed", period_start: "2026-03-15T00:00:00Z" } // has period, missing subscription_id
    });
    assert.equal(missingSubRes.data.success, false);
    assert.equal(missingSubRes.data.status, "missing_invoice_provenance");

    // 22e: Missing period with present subscription ID and NO event timestamp fails closed
    harness22.tables.pooldocai_stripe_webhook_events.set("evt_missing_period", {
      stripe_event_id: "evt_missing_period",
      event_type: "invoice.payment_failed",
      processed: false,
      claim_token: "claim_test_period_1"
    });
    const missingPeriodRes = await harness22.createMockDb().rpc("pooldocai_apply_and_finalize_stripe_webhook", {
      p_event_id: "evt_missing_period",
      p_claim_token: "claim_test_period_1",
      p_company_id: testCoId,
      p_company_updates: { billing_status: "past_due" },
      p_event_provenance: { event_type: "invoice.payment_failed", subscription_id: "sub_replacement_b" } // has sub, missing period and event_created
    });
    assert.equal(missingPeriodRes.data.success, false);
    assert.equal(missingPeriodRes.data.status, "missing_invoice_provenance");

    // 22f: Missing both subscription ID and period fails closed
    harness22.tables.pooldocai_stripe_webhook_events.set("evt_missing_both", {
      stripe_event_id: "evt_missing_both",
      event_type: "invoice.payment_failed",
      processed: false,
      claim_token: "claim_test_both_1"
    });
    const missingBothRes = await harness22.createMockDb().rpc("pooldocai_apply_and_finalize_stripe_webhook", {
      p_event_id: "evt_missing_both",
      p_claim_token: "claim_test_both_1",
      p_company_id: testCoId,
      p_company_updates: { billing_status: "past_due" },
      p_event_provenance: { event_type: "invoice.payment_failed" } // missing both
    });
    assert.equal(missingBothRes.data.success, false);
    assert.equal(missingBothRes.data.status, "missing_invoice_provenance");

    // 22g: Wrong subscription with equal/newer period is safely ignored as stale_old_subscription_invoice
    harness22.tables.pooldocai_stripe_webhook_events.set("evt_wrong_sub_newer_period", {
      stripe_event_id: "evt_wrong_sub_newer_period",
      event_type: "invoice.payment_failed",
      processed: false,
      claim_token: "claim_test_wrong_1"
    });
    const wrongSubRes = await harness22.createMockDb().rpc("pooldocai_apply_and_finalize_stripe_webhook", {
      p_event_id: "evt_wrong_sub_newer_period",
      p_claim_token: "claim_test_wrong_1",
      p_company_id: testCoId,
      p_company_updates: { billing_status: "past_due" },
      p_event_provenance: {
        event_type: "invoice.payment_failed",
        subscription_id: "sub_other_different",
        period_start: "2026-03-20T00:00:00Z" // newer than current 2026-03-15
      }
    });
    assert.equal(wrongSubRes.data.success, true);
    assert.equal(wrongSubRes.data.status, "ignored");
    assert.equal(wrongSubRes.data.reason, "stale_old_subscription_invoice");

    // 22h: Same-subscription same-period invoice ordering:
    // First, invoice.payment_succeeded at 12:05:00 sets active
    harness22.tables.pooldocai_stripe_webhook_events.set("evt_same_period_paid", {
      stripe_event_id: "evt_same_period_paid",
      event_type: "invoice.payment_succeeded",
      processed: false,
      claim_token: "claim_test_paid_1"
    });
    const paidRes = await harness22.createMockDb().rpc("pooldocai_apply_and_finalize_stripe_webhook", {
      p_event_id: "evt_same_period_paid",
      p_claim_token: "claim_test_paid_1",
      p_company_id: testCoId,
      p_company_updates: { billing_status: "active" },
      p_event_provenance: {
        event_type: "invoice.payment_succeeded",
        subscription_id: "sub_replacement_b",
        period_start: "2026-03-15T00:00:00Z",
        event_created: "2026-03-15T12:05:00Z"
      }
    });
    assert.equal(paidRes.data.success, true);
    assert.equal(paidRes.data.status, "applied");
    assert.equal(harness22.tables.companies.get(testCoId).billing_status, "active");

    // Delayed invoice.payment_failed with earlier timestamp (12:00:00) arrives for same sub & period
    harness22.tables.pooldocai_stripe_webhook_events.set("evt_same_period_fail_delayed", {
      stripe_event_id: "evt_same_period_fail_delayed",
      event_type: "invoice.payment_failed",
      processed: false,
      claim_token: "claim_test_fail_1"
    });
    const delayedFailRes = await harness22.createMockDb().rpc("pooldocai_apply_and_finalize_stripe_webhook", {
      p_event_id: "evt_same_period_fail_delayed",
      p_claim_token: "claim_test_fail_1",
      p_company_id: testCoId,
      p_company_updates: { billing_status: "past_due" },
      p_event_provenance: {
        event_type: "invoice.payment_failed",
        subscription_id: "sub_replacement_b",
        period_start: "2026-03-15T00:00:00Z",
        event_created: "2026-03-15T12:00:00Z"
      }
    });
    assert.equal(delayedFailRes.data.success, true);
    assert.equal(delayedFailRes.data.status, "ignored");
    assert.equal(delayedFailRes.data.reason, "stale_out_of_order_invoice");
    assert.equal(harness22.tables.companies.get(testCoId).billing_status, "active", "Company must remain active");

    // Reverse order: a genuine subsequent failure at 12:10:00 applies
    harness22.tables.pooldocai_stripe_webhook_events.set("evt_same_period_fail_newer", {
      stripe_event_id: "evt_same_period_fail_newer",
      event_type: "invoice.payment_failed",
      processed: false,
      claim_token: "claim_test_fail_2"
    });
    const newerFailRes = await harness22.createMockDb().rpc("pooldocai_apply_and_finalize_stripe_webhook", {
      p_event_id: "evt_same_period_fail_newer",
      p_claim_token: "claim_test_fail_2",
      p_company_id: testCoId,
      p_company_updates: { billing_status: "past_due" },
      p_event_provenance: {
        event_type: "invoice.payment_failed",
        subscription_id: "sub_replacement_b",
        period_start: "2026-03-15T00:00:00Z",
        event_created: "2026-03-15T12:10:00Z"
      }
    });
    assert.equal(newerFailRes.data.success, true);
    assert.equal(newerFailRes.data.status, "applied");
    assert.equal(harness22.tables.companies.get(testCoId).billing_status, "past_due", "Company updated to past_due");

    // And recovery payment succeeded at 12:15:00 cleanly restores active
    harness22.tables.pooldocai_stripe_webhook_events.set("evt_same_period_recovery", {
      stripe_event_id: "evt_same_period_recovery",
      event_type: "invoice.payment_succeeded",
      processed: false,
      claim_token: "claim_test_rec_1"
    });
    const recoveryRes = await harness22.createMockDb().rpc("pooldocai_apply_and_finalize_stripe_webhook", {
      p_event_id: "evt_same_period_recovery",
      p_claim_token: "claim_test_rec_1",
      p_company_id: testCoId,
      p_company_updates: { billing_status: "active" },
      p_event_provenance: {
        event_type: "invoice.payment_succeeded",
        subscription_id: "sub_replacement_b",
        period_start: "2026-03-15T00:00:00Z",
        event_created: "2026-03-15T12:15:00Z"
      }
    });
    assert.equal(recoveryRes.data.success, true);
    assert.equal(recoveryRes.data.status, "applied");
    assert.equal(harness22.tables.companies.get(testCoId).billing_status, "active", "Company restored to active");

    // 22i: Nested subscription extraction tests in Edge Function webhook execution
    // Nested format 1: expanded object subscription: { id: "sub_replacement_b" }
    const nested1Payload = JSON.stringify({
      id: "evt_nested_sub_expanded",
      type: "invoice.payment_succeeded",
      created: 1773577000,
      data: {
        object: {
          id: "in_nested_1",
          customer: "cus_prov_22",
          subscription: { id: "sub_replacement_b" },
          period_start: invBEpoch,
          period_end: invBEpoch + 2592000
        }
      }
    });
    const sigNested1 = signPayload(nested1Payload);
    const resNested1 = await harness22.executeWebhook(new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST",
      headers: { "stripe-signature": sigNested1.header },
      body: nested1Payload
    }));
    assert.equal(resNested1.status, 200);
    assert.equal(resNested1.body.processed, true);

    // Nested format 2: subscription_details: { subscription: "sub_replacement_b" }
    const nested2Payload = JSON.stringify({
      id: "evt_nested_sub_details",
      type: "invoice.payment_succeeded",
      created: 1773577100,
      data: {
        object: {
          id: "in_nested_2",
          customer: "cus_prov_22",
          subscription_details: { subscription: "sub_replacement_b" },
          lines: { data: [{ period: { start: invBEpoch, end: invBEpoch + 2592000 } }] }
        }
      }
    });
    const sigNested2 = signPayload(nested2Payload);
    const resNested2 = await harness22.executeWebhook(new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST",
      headers: { "stripe-signature": sigNested2.header },
      body: nested2Payload
    }));
    assert.equal(resNested2.status, 200);
    assert.equal(resNested2.body.processed, true);

    // Nested format 3: lines.data[0].subscription: "sub_replacement_b"
    const nested3Payload = JSON.stringify({
      id: "evt_nested_sub_lines",
      type: "invoice.payment_succeeded",
      created: 1773577200,
      data: {
        object: {
          id: "in_nested_3",
          customer: "cus_prov_22",
          lines: {
            data: [{
              subscription: "sub_replacement_b",
              period: { start: invBEpoch, end: invBEpoch + 2592000 }
            }]
          }
        }
      }
    });
    const sigNested3 = signPayload(nested3Payload);
    const resNested3 = await harness22.executeWebhook(new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST",
      headers: { "stripe-signature": sigNested3.header },
      body: nested3Payload
    }));
    assert.equal(resNested3.status, 200);
    assert.equal(resNested3.body.processed, true);
  }

  console.log("PASS: Executable Stripe webhook event ordering, idempotency, signature, and replay test suite passed.");
}

runExecutableWebhookTests().catch((err) => {
  console.error("FAIL in executable Stripe webhook tests:", err);
  process.exit(1);
});
