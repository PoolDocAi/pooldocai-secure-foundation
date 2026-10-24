const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const handlerSource = fs.readFileSync(path.join(root, "supabase", "functions", "clever-handler", "index.ts"), "utf8");

// Extract the create_billing_checkout block from clever-handler
const checkoutMatch = handlerSource.match(/if\s*\(\["create_billing_checkout","create_billing_portal"\]\.includes\(action\)\)\s*\{([\s\S]*?)\n\s*\}\s*\n\s*\/\/\s*Company usage report/);
assert.ok(checkoutMatch, "Found create_billing_checkout block in clever-handler");

// Strip TS type annotations like `: Record<string, string>`
let checkoutCode = checkoutMatch[1].replace(/:\s*Record<[^>]+>/g, "");

function createMockEnv(overrides = {}) {
  const envVars = {
    STRIPE_SECRET_KEY: "sk_test_mock_secret_key",
    STRIPE_PRICE_SOLO_TECH: "price_solo_tech_123",
    STRIPE_PRICE_SOLO_COMPLETE: "price_solo_complete_123",
    STRIPE_PRICE_PRO_TECH: "price_pro_tech_123",
    STRIPE_PRICE_PRO_COMPLETE: "price_pro_complete_123",
    STRIPE_PRICE_FLEET_TECH: "price_fleet_tech_123",
    STRIPE_PRICE_FLEET_COMPLETE: "price_fleet_complete_123",
    STRIPE_PRICE_STARTER: "price_starter_123",
    STRIPE_PRICE_PROFESSIONAL: "price_professional_123",
    STRIPE_PRICE_ENTERPRISE: "price_enterprise_123",
    STRIPE_PRICE_PILOT: "price_pilot_123",
    ...overrides
  };
  return {
    get(name) { return envVars[name] || null; }
  };
}

async function runCheckout({
  body = {},
  action = "create_billing_checkout",
  authenticatedUserId = "usr_company_admin_1",
  authenticatedCompanyId = "comp_test_acme",
  authenticatedRole = "company_admin",
  isPlatformOwner = false,
  companyRecord = {
    id: "comp_test_acme",
    name: "Acme Pool Care",
    billing_email: "billing@acmepoolcare.com",
    billing_customer_ref: "cus_test_acme_123",
    stripe_customer_id: "cus_test_acme_123",
    plan_name: "pro_complete",
    seat_limit: 5
  },
  stripeFetchResponse = {
    ok: true,
    status: 200,
    json: async () => ({ id: "cs_test_session_12345", url: "https://checkout.stripe.com/c/pay/cs_test_session_12345" })
  },
  envOverrides = {}
}) {
  const insertedUsage = [];
  const fetchedCalls = [];

  const mockSupabase = {
    from(table) {
      if (table === "platform_admins") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({ data: isPlatformOwner ? { user_id: authenticatedUserId } : null, error: null })
                };
              }
            };
          }
        };
      }
      if (table === "companies") {
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({ data: companyRecord, error: null })
                };
              }
            };
          }
        };
      }
      if (table === "platform_usage_events") {
        return {
          insert: async (record) => {
            insertedUsage.push(record);
            return { data: null, error: null };
          }
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    }
  };

  const mockFetch = async (url, options) => {
    fetchedCalls.push({ url, options });
    return typeof stripeFetchResponse === "function" ? stripeFetchResponse(url, options) : stripeFetchResponse;
  };

  const sandbox = {
    action,
    body,
    authenticatedUserId,
    authenticatedCompanyId,
    authenticatedRole,
    supabase: mockSupabase,
    fetch: mockFetch,
    Deno: { env: createMockEnv(envOverrides) },
    textValue: (v, max = 80) => String(v || "").trim().slice(0, max),
    appBaseUrl: () => "https://app.pooldocai.com",
    jsonResponse: (data, status = 200) => ({ data, status }),
    URLSearchParams,
    console
  };

  const script = new vm.Script(`(async () => {\n${checkoutCode}\n})()`);
  const context = vm.createContext(sandbox);
  const result = await script.runInContext(context);

  return { result, insertedUsage, fetchedCalls };
}

async function runAllTests() {
  // Test 1: Successful checkout for all canonical tiers with package quantity = 1 and correct seat allowance
  const canonicalTiers = [
    { plan: "solo_tech", defaultSeats: 1, expectedPriceId: "price_solo_tech_123" },
    { plan: "solo_complete", defaultSeats: 1, expectedPriceId: "price_solo_complete_123" },
    { plan: "pro_tech", defaultSeats: 5, expectedPriceId: "price_pro_tech_123" },
    { plan: "pro_complete", defaultSeats: 5, expectedPriceId: "price_pro_complete_123" },
    { plan: "fleet_tech", defaultSeats: 15, expectedPriceId: "price_fleet_tech_123" },
    { plan: "fleet_complete", defaultSeats: 15, expectedPriceId: "price_fleet_complete_123" }
  ];

  for (const tier of canonicalTiers) {
    const { result, insertedUsage, fetchedCalls } = await runCheckout({
      body: { authenticatedApp: true, planName: tier.plan },
      companyRecord: {
        id: "comp_test_acme",
        name: "Acme Pool Care",
        billing_email: "billing@acme.com",
        plan_name: tier.plan,
        seat_limit: tier.defaultSeats
      }
    });

    assert.equal(result.status, 200, `Checkout for ${tier.plan} must return status 200`);
    assert.equal(result.data.ok, true);
    assert.equal(result.data.url, "https://checkout.stripe.com/c/pay/cs_test_session_12345");

    // Verify Stripe POST parameters
    assert.equal(fetchedCalls.length, 1);
    const postBody = fetchedCalls[0].options.body.toString();
    const params = new URLSearchParams(postBody);

    assert.equal(params.get("mode"), "subscription");
    assert.equal(params.get("line_items[0][price]"), tier.expectedPriceId);
    assert.equal(params.get("line_items[0][quantity]"), "1", "Package pricing must set quantity to 1");
    assert.equal(params.get("metadata[pooldocai_company_id]"), "comp_test_acme");
    assert.equal(params.get("metadata[plan_name]"), tier.plan);
    assert.equal(params.get("metadata[seat_limit]"), String(tier.defaultSeats));
    assert.equal(params.get("subscription_data[metadata][pooldocai_company_id]"), "comp_test_acme");
    assert.equal(params.get("subscription_data[metadata][plan_name]"), tier.plan);
    assert.equal(params.get("subscription_data[metadata][seat_limit]"), String(tier.defaultSeats));

    // Verify platform_usage_events insertion without runtime reference error
    assert.equal(insertedUsage.length, 1);
    assert.equal(insertedUsage[0].company_id, "comp_test_acme");
    assert.equal(insertedUsage[0].event_type, "billing_checkout_created");
    assert.equal(insertedUsage[0].metadata.plan_name, tier.plan);
    assert.equal(insertedUsage[0].metadata.seat_quantity, tier.defaultSeats);
    assert.equal(insertedUsage[0].metadata.stripe_session_id, "cs_test_session_12345");
  }

  // Test 2: Custom seat request above package default expands seat_limit metadata
  {
    const { result, insertedUsage, fetchedCalls } = await runCheckout({
      body: { authenticatedApp: true, planName: "pro_complete", seatQuantity: 8 },
      companyRecord: { id: "comp_test_acme", plan_name: "pro_complete", seat_limit: 5 }
    });
    assert.equal(result.status, 200);
    const params = new URLSearchParams(fetchedCalls[0].options.body.toString());
    assert.equal(params.get("line_items[0][quantity]"), "1", "Quantity remains 1 fixed package unit");
    assert.equal(params.get("metadata[seat_limit]"), "8", "Metadata reflects requested seat count");
    assert.equal(insertedUsage[0].metadata.seat_quantity, 8);
  }

  // Test 3: Stripe API failure (502) returns STRIPE_CHECKOUT_FAILED without inserting usage event
  {
    const { result, insertedUsage } = await runCheckout({
      body: { authenticatedApp: true, planName: "pro_complete" },
      stripeFetchResponse: {
        ok: false,
        status: 502,
        json: async () => ({ error: { message: "Stripe service unavailable" } })
      }
    });
    assert.equal(result.status, 502);
    assert.equal(result.data.code, "STRIPE_CHECKOUT_FAILED");
    assert.equal(insertedUsage.length, 0, "No usage event inserted on failed checkout attempt");
  }

  // Test 4: Missing STRIPE_SECRET_KEY fails closed with 503 BILLING_NOT_CONFIGURED
  {
    const { result } = await runCheckout({
      body: { authenticatedApp: true, planName: "pro_complete" },
      envOverrides: { STRIPE_SECRET_KEY: "" }
    });
    assert.equal(result.status, 503);
    assert.equal(result.data.code, "BILLING_NOT_CONFIGURED");
  }

  // Test 5: Missing price ID for selected plan fails closed with 503 STRIPE_PRICE_NOT_CONFIGURED
  {
    const { result } = await runCheckout({
      body: { authenticatedApp: true, planName: "enterprise" },
      envOverrides: { STRIPE_PRICE_ENTERPRISE: "" }
    });
    assert.equal(result.status, 503);
    assert.equal(result.data.code, "STRIPE_PRICE_NOT_CONFIGURED");
  }

  // Test 6: Authorization guard blocks non-company_admin and unauthenticated requests
  {
    const unauth = await runCheckout({
      body: { authenticatedApp: false, planName: "pro_complete" },
      authenticatedUserId: null
    });
    assert.equal(unauth.result.status, 401);
    assert.equal(unauth.result.data.code, "AUTH_REQUIRED");

    const nonAdmin = await runCheckout({
      body: { authenticatedApp: true, planName: "pro_complete" },
      authenticatedRole: "technician"
    });
    assert.equal(nonAdmin.result.status, 403);
    assert.equal(nonAdmin.result.data.code, "BILLING_PERMISSION_REQUIRED");
  }

  // Test 7: Billing portal session creation for customer with existing stripe_customer_id
  {
    const { result, fetchedCalls } = await runCheckout({
      action: "create_billing_portal",
      body: { authenticatedApp: true },
      stripeFetchResponse: {
        ok: true,
        status: 200,
        json: async () => ({ url: "https://billing.stripe.com/p/session/portal_test_123" })
      }
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.url, "https://billing.stripe.com/p/session/portal_test_123");
    assert.equal(fetchedCalls[0].url, "https://api.stripe.com/v1/billing_portal/sessions");
    const portalParams = new URLSearchParams(fetchedCalls[0].options.body.toString());
    assert.equal(portalParams.get("customer"), "cus_test_acme_123");
  }

  // Test 8: Billing portal creation fails closed if company has no Stripe customer yet
  {
    const { result } = await runCheckout({
      action: "create_billing_portal",
      body: { authenticatedApp: true },
      companyRecord: {
        id: "comp_test_acme",
        name: "Acme",
        stripe_customer_id: null,
        billing_customer_ref: null
      }
    });
    assert.equal(result.status, 409);
    assert.equal(result.data.code, "STRIPE_CUSTOMER_NOT_FOUND");
  }

  console.log("PASS: All Stripe checkout and billing portal executable tests passed.");
}

runAllTests().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
