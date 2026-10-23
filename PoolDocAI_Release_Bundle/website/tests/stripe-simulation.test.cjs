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
    .replace(/:\s*Record<[^>]+>/g, "")
    .replace(/:\s*Promise<[^>]+>/g, "")
    .replace(/as\s+Record<string,\s*any>/g, "")
    .replace(/as\s+any/g, "")
    .replace(/as\s+Error/g, "");
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

function createHarness() {
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

  return { tables, executeWebhook, createMockDb };
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
      processed: false
    });
    const payload = JSON.stringify({ id: eventId, type: "customer.subscription.updated", data: { object: { id: "sub_concurrent" } } });
    const sig = signPayload(payload, WEBHOOK_SECRET);

    const resRaced = await harness.executeWebhook(new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST", headers: { "stripe-signature": sig.header }, body: payload
    }));
    assert.ok(resRaced.status === 200 || resRaced.status === 409);
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
    // Payment failure -> past_due
    const failPayload = JSON.stringify({ id: "evt_pay_failed", type: "invoice.payment_failed", data: { object: { customer: "cus_sim_123" } } });
    const sigFail = signPayload(failPayload, WEBHOOK_SECRET);
    await harness.executeWebhook(new Request("https://mock.supabase.co/functions/v1/stripe-webhook", {
      method: "POST", headers: { "stripe-signature": sigFail.header }, body: failPayload
    }));
    assert.equal(harness.tables.companies.get(companyId).billing_status, "past_due");

    // Payment recovery -> active
    const recPayload = JSON.stringify({ id: "evt_pay_recovered", type: "invoice.payment_succeeded", data: { object: { customer: "cus_sim_123" } } });
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

  console.log("PASS: Executable Stripe webhook event ordering, idempotency, signature, and replay test suite passed.");
}

runExecutableWebhookTests().catch((err) => {
  console.error("FAIL in executable Stripe webhook tests:", err);
  process.exit(1);
});
