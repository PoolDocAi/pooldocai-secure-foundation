// ============================================================================
// POOLDOCAI TASK-008 PART-1C: FAULT-INJECTION & STRICT GATE TEST SUITE
// Tests storage canary teardown failure modes, absence verification failures,
// probe upload tracking, and strict release gate fail-closed semantics.
// Run: node website/tests/staging-live-tenant-isolation-fault-injection.test.cjs
// ============================================================================

const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const https = require("node:https");
const { runLiveStagingIntegrationTests } = require("./staging-live-tenant-isolation.test.cjs");

console.log("=== RUNNING LIVE STAGING INTEGRATION FAULT-INJECTION & GATE TESTS ===");

// Helper to intercept https.request with custom routing
function mockHttpsRequests(routeHandler) {
  const originalRequest = https.request;
  https.request = function (options, callback) {
    const req = new EventEmitter();
    let bodyChunks = [];
    req.write = function (chunk) {
      if (chunk) bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    };
    req.destroy = function () {};
    req.end = function (chunk) {
      if (chunk) bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const fullBody = Buffer.concat(bodyChunks).toString("utf8");

      process.nextTick(() => {
        try {
          const respSpec = routeHandler(options, fullBody);
          if (respSpec.error) {
            req.emit("error", respSpec.error);
            return;
          }

          const res = new EventEmitter();
          res.statusCode = respSpec.status || 200;
          res.headers = respSpec.headers || { "content-type": "application/json" };
          callback(res);

          const payload = typeof respSpec.body === "string" 
            ? respSpec.body 
            : JSON.stringify(respSpec.body !== undefined ? respSpec.body : {});

          res.emit("data", Buffer.from(payload));
          res.emit("end");
        } catch (err) {
          req.emit("error", err);
        }
      });
    };
    return req;
  };

  return () => {
    https.request = originalRequest;
  };
}

// Standard mock router representing healthy staging project rzkgmvyyeclrpomrlyft
function createBaseMockRouter(overrides = {}) {
  const TENANT_A_COMPANY = "11111111-1111-4111-8111-111111111111";
  const TENANT_B_COMPANY = "22222222-2222-4222-8222-222222222222";
  const storageFiles = new Map();

  return function router(options, body) {
    const path = options.path;
    const method = options.method || "GET";
    const authHeader = options.headers?.["Authorization"] || "";

    // Allow test to override specific routes
    if (overrides[method + " " + path]) {
      return overrides[method + " " + path](options, body, storageFiles);
    }
    for (const [key, handler] of Object.entries(overrides)) {
      if (key.includes("*")) {
        const [m, p] = key.split(" ");
        if (m === method && new RegExp("^" + p.replace(/\*/g, ".*") + "$").test(path)) {
          return handler(options, body, storageFiles);
        }
      }
    }

    // Health check
    if (path === "/rest/v1/" && method === "GET") {
      return { status: 200, body: {} };
    }

    // Negative controls (Section 6 checked first to prevent accidental match by generic routes)
    if (authHeader.includes("fake_signature") || authHeader.includes("malformed")) {
      return { status: 401, body: { message: "Invalid token" } };
    }

    // 1. Service requests
    if (path.startsWith("/rest/v1/service_requests")) {
      if (method === "GET") {
        if (path.includes("22222222-2000-4222-8222-222222222222")) {
          if (authHeader.includes("tech_b_token")) {
            return { status: 200, body: [{ id: "22222222-2000-4222-8222-222222222222", company_id: TENANT_B_COMPANY }] };
          }
          return { status: 200, body: [] }; // Cross-tenant deny (RLS empty array)
        }
        if (path.includes("11111111-2000-4111-8111-111111111111")) {
          if (authHeader.includes("tech_a_token")) {
            return { status: 200, body: [{ id: "11111111-2000-4111-8111-111111111111", company_id: TENANT_A_COMPANY }] };
          }
          return { status: 200, body: [] }; // Cross-tenant deny (RLS empty array)
        }
        if (authHeader.includes("tech_a_token")) {
          return { status: 200, body: [{ id: "11111111-2000-4111-8111-111111111111", company_id: TENANT_A_COMPANY }] };
        }
        if (authHeader.includes("tech_b_token")) {
          return { status: 200, body: [{ id: "22222222-2000-4222-8222-222222222222", company_id: TENANT_B_COMPANY }] };
        }
        return { status: 200, body: [] };
      }
      if (method === "POST") {
        const parsed = JSON.parse(body || "{}");
        if (parsed.company_id === TENANT_B_COMPANY && authHeader.includes("tech_a_token")) {
          return { status: 403, body: { message: "violates row-level security policy" } }; // 1E
        }
        if (parsed.company_id === TENANT_A_COMPANY && authHeader.includes("tech_b_token")) {
          return { status: 403, body: { message: "violates row-level security policy" } }; // 1F
        }
        return { status: 201, body: [{ id: "sr-new" }] };
      }
    }

    // 2. Company members & service customers
    if (path.startsWith("/rest/v1/company_members") && method === "GET") {
      if (authHeader.includes("admin_a_token")) {
        return { status: 200, body: [{ id: "m-a", company_id: TENANT_A_COMPANY, role: "technician" }] };
      }
      if (authHeader.includes("admin_b_token")) {
        return { status: 200, body: [{ id: "m-b", company_id: TENANT_B_COMPANY, role: "technician" }] };
      }
      return { status: 200, body: [] };
    }

    if (path.startsWith("/rest/v1/service_customers") && method === "GET") {
      if (authHeader.includes("tech_a_token")) {
        return { status: 200, body: [{ id: "c-a", company_id: TENANT_A_COMPANY, customer_name: "Aqua Customer" }] };
      }
      if (authHeader.includes("tech_b_token")) {
        return { status: 200, body: [{ id: "c-b", company_id: TENANT_B_COMPANY, customer_name: "Blue Customer" }] };
      }
      return { status: 200, body: [] };
    }

    // 3. Storage
    if (path.startsWith("/storage/v1/object/company-manuals/")) {
      const isTenantA = path.startsWith(`/storage/v1/object/company-manuals/${TENANT_A_COMPANY}/`);
      const isTenantB = path.startsWith(`/storage/v1/object/company-manuals/${TENANT_B_COMPANY}/`);

      if (method === "POST") {
        if (isTenantA && authHeader.includes("admin_a_token")) {
          storageFiles.set(path, body);
          return { status: 200, body: { Key: path } };
        }
        if (isTenantB && authHeader.includes("admin_a_token")) {
          return { status: 403, body: { error: "AccessDenied" } }; // 3C
        }
        if (isTenantB && authHeader.includes("admin_b_token")) {
          storageFiles.set(path, body);
          return { status: 200, body: { Key: path } };
        }
        return { status: 403, body: { error: "AccessDenied" } };
      }

      if (method === "GET") {
        if (!authHeader || authHeader.includes("sb_publishable_") || authHeader.includes("anon")) {
          return { status: 403, body: { error: "AccessDenied" } }; // 3F
        }
        if (isTenantA) {
          if (authHeader.includes("admin_a_token")) {
            if (storageFiles.has(path)) {
              return { status: 200, body: storageFiles.get(path) };
            }
            return { status: 404, body: { error: "Not Found" } };
          }
          if (authHeader.includes("tech_b_token")) {
            return { status: 403, body: { error: "AccessDenied" } }; // 3B
          }
        }
        if (isTenantB) {
          if (authHeader.includes("admin_b_token")) {
            if (storageFiles.has(path)) {
              return { status: 200, body: storageFiles.get(path) };
            }
            return { status: 404, body: { error: "Not Found" } };
          }
          if (authHeader.includes("tech_a_token")) {
            return { status: 403, body: { error: "AccessDenied" } }; // 3E
          }
        }
        return { status: 403, body: { error: "AccessDenied" } };
      }

      if (method === "DELETE") {
        storageFiles.delete(path);
        return { status: 200, body: { message: "Deleted" } };
      }
    }

    // 4. Schema-level REVOKE ALL on diagnostic_cases and technician_job_records
    if (path.startsWith("/rest/v1/diagnostic_cases")) {
      return { status: 401, body: { message: "permission denied for table diagnostic_cases" } };
    }
    if (path.startsWith("/rest/v1/technician_job_records")) {
      return { status: 401, body: { message: "permission denied for table technician_job_records" } };
    }

    // 5. RPCs
    if (path === "/rest/v1/rpc/pooldocai_get_user_notifications" && method === "POST") {
      if (authHeader.includes("tech_a_token") || authHeader.includes("tech_b_token")) {
        return { status: 200, body: [] };
      }
      return { status: 401, body: { message: "Authentication required" } };
    }
    if (path === "/rest/v1/rpc/pooldocai_touch_updated_at" && method === "POST") {
      return { status: 401, body: { message: "Authentication required" } };
    }
    if (path === "/rest/v1/rpc/search_company_manual_chunks_hybrid" && method === "POST") {
      const parsed = JSON.parse(body || "{}");
      if (parsed.p_company_id === TENANT_A_COMPANY && authHeader.includes("tech_a_token")) {
        return { status: 200, body: [{ chunk_id: "c-1", content: "manual text" }] };
      }
      return { status: 200, body: [] }; // Cross-tenant search returns empty
    }

    return { status: 404, body: { message: "Not found: " + path } };
  };
}

const mockTokens = JSON.stringify({
  adminA: "admin_a_token",
  techA: "tech_a_token",
  adminB: "admin_b_token",
  techB: "tech_b_token"
});

// Environment setup helper
async function withMockEnv(envVars, testFn) {
  const origEnv = { ...process.env };
  try {
    Object.assign(process.env, envVars);
    return await testFn();
  } finally {
    for (const key of Object.keys(envVars)) {
      if (origEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = origEnv[key];
      }
    }
  }
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    process.stdout.write(`  TEST: ${name} ... `);
    try {
      await fn();
      console.log("PASS");
      passed++;
    } catch (err) {
      console.log(`FAIL\n    ${err.message}`);
      failed++;
    }
  }

  console.log("\n--- Suite 1: Storage Canary Teardown Fault Injection ---");

  await test("Storage canary teardown DELETE HTTP 500 increments failed and throws in strict mode", async () => {
    const restoreHttps = mockHttpsRequests(createBaseMockRouter({
      "DELETE */storage/v1/object/company-manuals/*": () => ({
        status: 500,
        body: { error: "Internal Server Error during delete" }
      })
    }));

    try {
      await withMockEnv({
        STAGING_SUPABASE_URL: "https://rzkgmvyyeclrpomrlyft.supabase.co",
        STAGING_SUPABASE_ANON_KEY: "sb_publishable_dummy_key",
        STAGING_AUTH_TOKENS: mockTokens,
        REQUIRE_LIVE_STAGING: "1"
      }, async () => {
        let threw = false;
        try {
          await runLiveStagingIntegrationTests();
        } catch (err) {
          threw = true;
          assert.match(err.message, /\[FATAL RELEASE GATE ERROR\] \d+ live staging tests failed/);
        }
        assert.equal(threw, true, "Must throw fatal gate error when storage canary DELETE returns 500");
      });
    } finally {
      restoreHttps();
    }
  });

  await test("Storage canary teardown absence verification failure (file still returns 200) increments failed and throws", async () => {
    const restoreHttps = mockHttpsRequests(createBaseMockRouter({
      "DELETE */storage/v1/object/company-manuals/*": () => ({
        status: 200,
        body: { message: "Deleted" }
      }),
      // Absence check GET still returns 200!
      "GET */storage/v1/object/company-manuals/*": (options) => {
        const auth = options.headers?.["Authorization"] || "";
        if (auth.includes("admin_a_token") || auth.includes("admin_b_token")) {
          return { status: 200, body: "LEAKED_CANARY_NOT_DELETED" };
        }
        return { status: 403, body: {} };
      }
    }));

    try {
      await withMockEnv({
        STAGING_SUPABASE_URL: "https://rzkgmvyyeclrpomrlyft.supabase.co",
        STAGING_SUPABASE_ANON_KEY: "sb_publishable_dummy_key",
        STAGING_AUTH_TOKENS: mockTokens,
        REQUIRE_LIVE_STAGING: "1"
      }, async () => {
        let threw = false;
        try {
          await runLiveStagingIntegrationTests();
        } catch (err) {
          threw = true;
          assert.match(err.message, /\[FATAL RELEASE GATE ERROR\] \d+ live staging tests failed/);
        }
        assert.equal(threw, true, "Must throw fatal gate error when storage canary absence verification fails");
      });
    } finally {
      restoreHttps();
    }
  });

  await test("Storage canary teardown succeeds when DELETE returns 200 and absence GET returns 404", async () => {
    const restoreHttps = mockHttpsRequests(createBaseMockRouter());

    try {
      await withMockEnv({
        STAGING_SUPABASE_URL: "https://rzkgmvyyeclrpomrlyft.supabase.co",
        STAGING_SUPABASE_ANON_KEY: "sb_publishable_dummy_key",
        STAGING_AUTH_TOKENS: mockTokens,
        REQUIRE_LIVE_STAGING: "0" // non-strict so pending controls don't throw
      }, async () => {
        const res = await runLiveStagingIntegrationTests();
        assert.equal(res.failed, 0, "No tests should fail during clean teardown");
        assert.ok(res.passed >= 18, "All baseline checks should pass");
      });
    } finally {
      restoreHttps();
    }
  });

  console.log("\n--- Suite 2: Strict Live-Gate Failure Semantics ---");

  await test("REQUIRE_LIVE_STAGING=1 fails closed with fatal error when pending positive controls remain (notRun > 0)", async () => {
    const restoreHttps = mockHttpsRequests(createBaseMockRouter());

    try {
      await withMockEnv({
        STAGING_SUPABASE_URL: "https://rzkgmvyyeclrpomrlyft.supabase.co",
        STAGING_SUPABASE_ANON_KEY: "sb_publishable_dummy_key",
        STAGING_AUTH_TOKENS: mockTokens,
        REQUIRE_LIVE_STAGING: "1" // Strict release gate
      }, async () => {
        let threw = false;
        try {
          await runLiveStagingIntegrationTests();
        } catch (err) {
          threw = true;
          assert.match(err.message, /\[FATAL RELEASE GATE ERROR\] Strict staging gate REQUIRE_LIVE_STAGING=1 requires complete test suite execution, but \d+ controls were NOT RUN/);
        }
        assert.equal(threw, true, "Must throw when notRun > 0 under REQUIRE_LIVE_STAGING=1");
      });
    } finally {
      restoreHttps();
    }
  });

  await test("REQUIRE_LIVE_STAGING unset (informational mode) returns PARTIAL without throwing when notRun > 0", async () => {
    const restoreHttps = mockHttpsRequests(createBaseMockRouter());

    try {
      await withMockEnv({
        STAGING_SUPABASE_URL: "https://rzkgmvyyeclrpomrlyft.supabase.co",
        STAGING_SUPABASE_ANON_KEY: "sb_publishable_dummy_key",
        STAGING_AUTH_TOKENS: mockTokens
        // REQUIRE_LIVE_STAGING not set
      }, async () => {
        const res = await runLiveStagingIntegrationTests();
        assert.equal(res.status, "PARTIAL");
        assert.equal(res.failed, 0);
        assert.ok(res.notRun > 0, "Pending controls accounted in notRun");
        assert.ok(res.passed >= 18, "Live executed tests passed");
      });
    } finally {
      restoreHttps();
    }
  });

  console.log("\n--- Suite 3: Missing Credentials Gate Semantics ---");

  await test("REQUIRE_LIVE_STAGING=1 throws when credentials are missing", async () => {
    await withMockEnv({
      STAGING_SUPABASE_URL: "",
      STAGING_SUPABASE_ANON_KEY: "",
      REQUIRE_LIVE_STAGING: "1"
    }, async () => {
      let threw = false;
      try {
        await runLiveStagingIntegrationTests();
      } catch (err) {
        threw = true;
        assert.match(err.message, /\[FATAL RELEASE GATE ERROR\] REQUIRE_LIVE_STAGING=1 is set, but live credentials are missing/);
      }
      assert.equal(threw, true, "Must throw fatal gate error when credentials missing in strict mode");
    });
  });

  await test("REQUIRE_LIVE_STAGING unset returns NOT_RUN when credentials are missing without throwing", async () => {
    await withMockEnv({
      STAGING_SUPABASE_URL: "",
      STAGING_SUPABASE_ANON_KEY: ""
    }, async () => {
      const res = await runLiveStagingIntegrationTests();
      assert.equal(res.status, "NOT_RUN");
      assert.equal(res.failed, 0);
      assert.ok(res.notRun > 0);
    });
  });

  console.log("\n================================================================");
  console.log(`FAULT-INJECTION & GATE TEST SUMMARY: ${passed} passed, ${failed} failed`);
  console.log("================================================================\n");

  if (failed > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runTests().catch(err => {
    console.error("Test execution failed:", err);
    process.exit(1);
  });
}
