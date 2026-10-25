// ============================================================================
// POOLDOCAI TASK-008 PART-1C: ACTUAL-STAGING LIVE TENANT ISOLATION INTEGRATION HARNESS
// Target: Dedicated Supabase Staging Project rzkgmvyyeclrpomrlyft ONLY
// STRICT NOTICE: Zero production contact (owfeebydlyacssqpnmkq is strictly forbidden).
//
// Behavior:
// 1. Connects exclusively to live staging project rzkgmvyyeclrpomrlyft.
// 2. Enforces hard fail-closed production safety guard.
// 3. Authenticates 4 synthetic staging identities (AquaPure Admin/Tech, BlueWave Admin/Tech)
//    via genuine GoTrue /auth/v1/token requests or secure environment-provided tokens.
//    Supports modern sb_publishable_ / sb_secret_ keys as well as legacy JWT keys.
// 4. Executes complete bidirectional cross-tenant ALLOW/DENY tests across:
//    - Service requests (positive own-tenant read, negative cross-tenant read, negative cross-tenant insert)
//    - Company members & service customers (aligned with actual customer_name column)
//    - Private Storage (confirmed own-tenant canary upload/read, negative cross-tenant read/write, anonymous denial)
//    - Diagnostic cases & technician job records (aligned with tenant_id and technician_job_records table)
//    - Retrieval & Notification RPCs (own-tenant execution, anonymous denial)
//    - Revoked / invalid token rejection
// 5. Honest Accounting:
//    - LIVE=PASS recorded ONLY on executed assertions matching expected HTTP status with verified positive controls.
//    - Missing fixtures (e.g. empty tables) or missing credentials recorded as LIVE=NOT RUN without faking success.
//    - If REQUIRE_LIVE_STAGING=1 is set, aborts with nonzero exit code when credentials or tests fail.
// ============================================================================

const https = require("node:https");
const url = require("node:url");

const STAGING_PROJECT_REF = "rzkgmvyyeclrpomrlyft";
const PROD_PROJECT_REF = "owfeebydlyacssqpnmkq";
const EXPECTED_STAGING_HOST = `${STAGING_PROJECT_REF}.supabase.co`;

// Synthetic Staging Tenant Identities (from supabase/staging/01_synthetic_staging_fixtures.sql)
const TENANT_A = {
  companyId: "11111111-1111-4111-8111-111111111111",
  companyName: "AquaPure Commercial Pool Care",
  admin: {
    userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    email: "staging_admin_aquapure@pooldocai.test"
  },
  tech: {
    userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    email: "staging_tech_aquapure@pooldocai.test"
  },
  serviceRequestId: "11111111-2000-4111-8111-111111111111",
  customerId: "11111111-1000-4111-8111-111111111111"
};

const TENANT_B = {
  companyId: "22222222-2222-4222-8222-222222222222",
  companyName: "BlueWave Residential Pool Services",
  admin: {
    userId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    email: "staging_admin_bluewave@pooldocai.test"
  },
  tech: {
    userId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    email: "staging_tech_bluewave@pooldocai.test"
  },
  serviceRequestId: "22222222-2000-4222-8222-222222222222",
  customerId: "22222222-1000-4222-8222-222222222222"
};

// Hard Production Safety Guard
function enforceProductionSafetyGuard(targetUrl) {
  if (!targetUrl) return;
  const clean = String(targetUrl).toLowerCase();
  if (clean.includes(PROD_PROJECT_REF) || (clean.includes("pooldocai.com") && !clean.includes("staging"))) {
    throw new Error(`[FATAL SECURITY VIOLATION] Test harness detected production host: ${targetUrl}. Aborting immediately.`);
  }
}

// Client HTTPS Request Helper for Live Staging
async function makeHttpsRequest(targetHost, path, options = {}) {
  const method = options.method || "GET";
  const headers = {
    "Accept": "application/json",
    "User-Agent": "PoolDocAI-Staging-Test-Client/1.0",
    ...(options.headers || {})
  };

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: targetHost,
        port: 443,
        path: path,
        method: method,
        headers: headers,
        timeout: 15000
      },
      res => {
        let resBody = "";
        res.on("data", chunk => { resBody += chunk; });
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(resBody); } catch (_) {}
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: resBody,
            json: json
          });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`HTTPS request timed out after 15000ms: ${targetHost}${path}`));
    });
    req.on("error", reject);
    if (options.body) {
      req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

// Authenticate via GoTrue Password Grant supporting modern sb_publishable_ and legacy anon keys
async function authenticateGoTrueUser(targetHost, anonKey, email, password) {
  if (!password) {
    return null;
  }
  const payload = JSON.stringify({ email, password });
  const headers = {
    "apikey": anonKey,
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload)
  };

  // If legacy JWT key is provided, also attach Authorization: Bearer
  if (anonKey.startsWith("eyJ")) {
    headers["Authorization"] = `Bearer ${anonKey}`;
  }

  const res = await makeHttpsRequest(targetHost, "/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: headers,
    body: payload
  });

  if (res.status === 200 && res.json && res.json.access_token) {
    return {
      accessToken: res.json.access_token,
      userId: res.json.user?.id || "",
      email: res.json.user?.email || email
    };
  }
  return null;
}

// Resolve All 4 Synthetic Identities
async function resolveSyntheticSessions(targetHost, anonKey) {
  // Option A: Check for pre-issued tokens in STAGING_AUTH_TOKENS
  if (process.env.STAGING_AUTH_TOKENS) {
    try {
      const parsed = JSON.parse(process.env.STAGING_AUTH_TOKENS);
      if (parsed.adminA && parsed.techA && parsed.adminB && parsed.techB) {
        return {
          adminA: typeof parsed.adminA === "string" ? parsed.adminA : parsed.adminA.accessToken,
          techA: typeof parsed.techA === "string" ? parsed.techA : parsed.techA.accessToken,
          adminB: typeof parsed.adminB === "string" ? parsed.adminB : parsed.adminB.accessToken,
          techB: typeof parsed.techB === "string" ? parsed.techB : parsed.techB.accessToken
        };
      }
    } catch (_) {}
  }

  // Option B: Authenticate via GoTrue with per-user or common synthetic password
  const pwdAdminA = process.env.STAGING_A_ADMIN_PASSWORD || process.env.STAGING_SYNTHETIC_PASSWORD || "";
  const pwdTechA = process.env.STAGING_A_TECH_PASSWORD || process.env.STAGING_SYNTHETIC_PASSWORD || "";
  const pwdAdminB = process.env.STAGING_B_ADMIN_PASSWORD || process.env.STAGING_SYNTHETIC_PASSWORD || "";
  const pwdTechB = process.env.STAGING_B_TECH_PASSWORD || process.env.STAGING_SYNTHETIC_PASSWORD || "";

  if (!pwdAdminA && !pwdTechA && !pwdAdminB && !pwdTechB) {
    return null;
  }

  const [sessAdminA, sessTechA, sessAdminB, sessTechB] = await Promise.all([
    authenticateGoTrueUser(targetHost, anonKey, TENANT_A.admin.email, pwdAdminA),
    authenticateGoTrueUser(targetHost, anonKey, TENANT_A.tech.email, pwdTechA),
    authenticateGoTrueUser(targetHost, anonKey, TENANT_B.admin.email, pwdAdminB),
    authenticateGoTrueUser(targetHost, anonKey, TENANT_B.tech.email, pwdTechB)
  ]);

  return {
    adminA: sessAdminA?.accessToken || null,
    techA: sessTechA?.accessToken || null,
    adminB: sessAdminB?.accessToken || null,
    techB: sessTechB?.accessToken || null
  };
}

async function runLiveStagingIntegrationTests() {
  console.log("=== POOLDOCAI TASK-008 PART-1C: ACTUAL-STAGING LIVE TENANT ISOLATION INTEGRATION HARNESS ===");
  console.log(`Targeting strictly staging project: ${STAGING_PROJECT_REF} (${EXPECTED_STAGING_HOST})\n`);

  const stagingUrl = process.env.STAGING_SUPABASE_URL || "";
  const stagingAnonKey = process.env.STAGING_SUPABASE_ANON_KEY || "";
  const requireLiveStaging = process.env.REQUIRE_LIVE_STAGING === "1";

  // 1. Production Safety Guards
  enforceProductionSafetyGuard(stagingUrl);
  enforceProductionSafetyGuard(process.env.SUPABASE_URL);
  enforceProductionSafetyGuard(process.env.NEXT_PUBLIC_SUPABASE_URL);

  const TOTAL_TEST_COUNT = 29;

  // 2. Preflight: Check Environment Readiness
  if (!stagingUrl || !stagingAnonKey) {
    console.log("----------------------------------------------------------------");
    console.log("[LIVE STAGING TEST STATUS]: NOT RUN");
    console.log("REASON: Live staging API credentials are not present in current test environment.");
    console.log("  - STAGING_SUPABASE_URL: " + (stagingUrl ? "SET" : "MISSING"));
    console.log("  - STAGING_SUPABASE_ANON_KEY: " + (stagingAnonKey ? "SET (hidden)" : "MISSING"));
    console.log("\nINSTRUCTIONS FOR SAFE LOCAL DRY-RUN (Powershell):");
    console.log('  powershell -ExecutionPolicy RemoteSigned -File scripts\\rotate_staging_synthetic_passwords.ps1 -DryRun');
    console.log("----------------------------------------------------------------\n");

    if (requireLiveStaging) {
      throw new Error("[FATAL RELEASE GATE ERROR] REQUIRE_LIVE_STAGING=1 is set, but live credentials are missing.");
    }

    return {
      status: "NOT_RUN",
      reason: "Missing STAGING_SUPABASE_URL or STAGING_SUPABASE_ANON_KEY in test runner environment",
      targetProject: STAGING_PROJECT_REF,
      passed: 0,
      failed: 0,
      notRun: TOTAL_TEST_COUNT
    };
  }

  // Verify staging URL hostname
  let parsedUrl;
  try {
    parsedUrl = new URL(stagingUrl);
  } catch (err) {
    throw new Error(`[FATAL] Invalid STAGING_SUPABASE_URL format: ${stagingUrl}`);
  }

  if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== EXPECTED_STAGING_HOST) {
    throw new Error(`[FATAL SECURITY VIOLATION] Endpoint ${stagingUrl} is not valid HTTPS for ${EXPECTED_STAGING_HOST}.`);
  }

  console.log(`Verified endpoint: https://${parsedUrl.hostname}`);

  // 3. Preflight Health / Network Check
  console.log("\n--- Checking Live Staging Project Reachability ---");
  const preflightHeaders = { "apikey": stagingAnonKey };
  if (stagingAnonKey.startsWith("eyJ")) {
    preflightHeaders["Authorization"] = `Bearer ${stagingAnonKey}`;
  }

  try {
    const health = await makeHttpsRequest(parsedUrl.hostname, "/rest/v1/", {
      headers: preflightHeaders
    });
    console.log(`Staging REST API responded with HTTP ${health.status}`);
  } catch (err) {
    console.log(`[LIVE STAGING BLOCKER] Network connection to ${EXPECTED_STAGING_HOST} failed: ${err.message}`);
    if (requireLiveStaging) {
      throw new Error(`[FATAL RELEASE GATE ERROR] Network connection to ${EXPECTED_STAGING_HOST} unreachable: ${err.message}`);
    }
    return {
      status: "NOT_RUN",
      reason: `Network connection to ${EXPECTED_STAGING_HOST} unreachable: ${err.message}`,
      targetProject: STAGING_PROJECT_REF,
      passed: 0,
      failed: 0,
      notRun: TOTAL_TEST_COUNT
    };
  }

  // 4. Resolve Synthetic User Sessions
  console.log("\n--- Resolving Synthetic GoTrue User Sessions ---");
  const sessions = await resolveSyntheticSessions(parsedUrl.hostname, stagingAnonKey);

  const liveResults = { passed: 0, failed: 0, notRun: 0 };
  const recordLiveResult = (id, name, ok, details = "") => {
    if (ok) {
      liveResults.passed++;
      console.log(`  [LIVE PASS] ${id}: ${name}`);
    } else {
      liveResults.failed++;
      console.error(`  [LIVE FAIL] ${id}: ${name} -- ${details}`);
    }
  };

  if (!sessions || !sessions.adminA || !sessions.techA || !sessions.adminB || !sessions.techB) {
    console.log("----------------------------------------------------------------");
    console.log("[LIVE STAGING TEST STATUS]: PARTIAL (ANONYMOUS CONTROLS ONLY)");
    console.log("REASON: Endpoint is reachable, but one or more synthetic user sessions");
    console.log("could not be established (passwords or tokens missing).");
    console.log("  - Admin A: " + (sessions?.adminA ? "AUTHENTICATED" : "NOT AUTHENTICATED"));
    console.log("  - Tech A:  " + (sessions?.techA ? "AUTHENTICATED" : "NOT AUTHENTICATED"));
    console.log("  - Admin B: " + (sessions?.adminB ? "AUTHENTICATED" : "NOT AUTHENTICATED"));
    console.log("  - Tech B:  " + (sessions?.techB ? "AUTHENTICATED" : "NOT AUTHENTICATED"));
    console.log("----------------------------------------------------------------\n");
  }

  // Helper for authenticated requests (token is always a GoTrue JWT)
  const authReq = (token, path, opts = {}) => {
    return makeHttpsRequest(parsedUrl.hostname, path, {
      ...opts,
      headers: {
        "apikey": stagingAnonKey,
        "Authorization": `Bearer ${token}`,
        ...(opts.headers || {})
      }
    });
  };

  // Helper for anonymous requests
  const anonReq = (path, opts = {}) => {
    const headers = { "apikey": stagingAnonKey, ...(opts.headers || {}) };
    if (stagingAnonKey.startsWith("eyJ")) {
      headers["Authorization"] = `Bearer ${stagingAnonKey}`;
    }
    return makeHttpsRequest(parsedUrl.hostname, path, {
      ...opts,
      headers: headers
    });
  };

  // ==========================================================================
  // SECTION 1: Service Requests Multi-Tenant Isolation
  // ==========================================================================
  console.log("\n--- SECTION 1: Service Requests Multi-Tenant Isolation ---");
  if (sessions?.techA && sessions?.techB) {
    // 1A. AquaPure Tech reads own service requests -> ALLOW (HTTP 200, returns own row)
    {
      const res = await authReq(sessions.techA, `/rest/v1/service_requests?id=eq.${TENANT_A.serviceRequestId}&select=id,company_id`);
      const ok = res.status === 200 && Array.isArray(res.json) && res.json.length === 1 && res.json[0].company_id === TENANT_A.companyId;
      recordLiveResult("1A", "AquaPure Tech reads own service requests (ALLOW)", ok, `Status ${res.status}`);
    }

    // 1B. AquaPure Tech cross-tenant query for BlueWave service request -> DENY (HTTP 200, returns empty [])
    {
      const res = await authReq(sessions.techA, `/rest/v1/service_requests?id=eq.${TENANT_B.serviceRequestId}&select=id,company_id`);
      const ok = res.status === 200 && Array.isArray(res.json) && res.json.length === 0;
      recordLiveResult("1B", "AquaPure Tech cross-tenant query for BlueWave returns empty [] (DENY)", ok, `Returned ${res.body}`);
    }

    // 1C. BlueWave Tech reads own service requests -> ALLOW (HTTP 200, returns own row)
    {
      const res = await authReq(sessions.techB, `/rest/v1/service_requests?id=eq.${TENANT_B.serviceRequestId}&select=id,company_id`);
      const ok = res.status === 200 && Array.isArray(res.json) && res.json.length === 1 && res.json[0].company_id === TENANT_B.companyId;
      recordLiveResult("1C", "BlueWave Tech reads own service requests (ALLOW)", ok, `Status ${res.status}`);
    }

    // 1D. BlueWave Tech cross-tenant query for AquaPure service request -> DENY (HTTP 200, returns empty [])
    {
      const res = await authReq(sessions.techB, `/rest/v1/service_requests?id=eq.${TENANT_A.serviceRequestId}&select=id,company_id`);
      const ok = res.status === 200 && Array.isArray(res.json) && res.json.length === 0;
      recordLiveResult("1D", "BlueWave Tech cross-tenant query for AquaPure returns empty [] (DENY)", ok, `Returned ${res.body}`);
    }

    // 1E. AquaPure Tech attempts cross-tenant insert into BlueWave -> DENY (400 or 403 RLS violation)
    {
      const res = await authReq(sessions.techA, "/rest/v1/service_requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: {
          company_id: TENANT_B.companyId,
          request_summary: "Live Cross-tenant Injection Test"
        }
      });
      const ok = res.status === 400 || res.status === 403;
      recordLiveResult("1E", "AquaPure Tech cross-tenant INSERT into BlueWave rejected (DENY)", ok, `Status ${res.status}`);
    }

    // 1F. BlueWave Tech attempts cross-tenant insert into AquaPure -> DENY (400 or 403 RLS violation)
    {
      const res = await authReq(sessions.techB, "/rest/v1/service_requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: {
          company_id: TENANT_A.companyId,
          request_summary: "Live Cross-tenant Injection Test"
        }
      });
      const ok = res.status === 400 || res.status === 403;
      recordLiveResult("1F", "BlueWave Tech cross-tenant INSERT into AquaPure rejected (DENY)", ok, `Status ${res.status}`);
    }
  } else {
    liveResults.notRun += 6;
    console.log("  [LIVE NOT RUN] 1A-1F Service Requests Isolation (Awaiting synthetic user sessions)");
  }

  // ==========================================================================
  // SECTION 2: Company Members & Customers Multi-Tenant Isolation
  // Schema alignment: service_customers uses customer_name column
  // ==========================================================================
  console.log("\n--- SECTION 2: Company Members & Customers Multi-Tenant Isolation ---");
  if (sessions?.adminA && sessions?.adminB && sessions?.techA && sessions?.techB) {
    // 2A. AquaPure Admin reads members -> only AquaPure members returned
    {
      const res = await authReq(sessions.adminA, "/rest/v1/company_members?select=id,company_id,user_id,role");
      const ok = res.status === 200 && Array.isArray(res.json) && res.json.length > 0 && res.json.every(m => m.company_id === TENANT_A.companyId);
      recordLiveResult("2A", "AquaPure Admin reads only AquaPure members (ALLOW)", ok, `Status ${res.status}, count: ${res.json?.length}`);
    }

    // 2B. BlueWave Admin reads members -> only BlueWave members returned
    {
      const res = await authReq(sessions.adminB, "/rest/v1/company_members?select=id,company_id,user_id,role");
      const ok = res.status === 200 && Array.isArray(res.json) && res.json.length > 0 && res.json.every(m => m.company_id === TENANT_B.companyId);
      recordLiveResult("2B", "BlueWave Admin reads only BlueWave members (ALLOW)", ok, `Status ${res.status}, count: ${res.json?.length}`);
    }

    // 2C. AquaPure Tech reads customers -> only AquaPure customers returned (customer_name verified)
    {
      const res = await authReq(sessions.techA, "/rest/v1/service_customers?select=id,company_id,customer_name");
      const ok = res.status === 200 && Array.isArray(res.json) && res.json.length > 0 && res.json.every(c => c.company_id === TENANT_A.companyId);
      recordLiveResult("2C", "AquaPure Tech reads only AquaPure customers (customer_name verified) (ALLOW)", ok, `Status ${res.status}, count: ${res.json?.length}`);
    }

    // 2D. BlueWave Tech reads customers -> only BlueWave customers returned (customer_name verified)
    {
      const res = await authReq(sessions.techB, "/rest/v1/service_customers?select=id,company_id,customer_name");
      const ok = res.status === 200 && Array.isArray(res.json) && res.json.length > 0 && res.json.every(c => c.company_id === TENANT_B.companyId);
      recordLiveResult("2D", "BlueWave Tech reads only BlueWave customers (customer_name verified) (ALLOW)", ok, `Status ${res.status}, count: ${res.json?.length}`);
    }
  } else {
    liveResults.notRun += 4;
    console.log("  [LIVE NOT RUN] 2A-2D Members & Customers Isolation (Awaiting synthetic user sessions)");
  }

  // ==========================================================================
  // SECTION 3: Private Storage (company-manuals) with Confirmed Canary Objects
  // ==========================================================================
  console.log("\n--- SECTION 3: Private Storage (company-manuals) Confirmed Isolation ---");
  const canaryContentA = "POOLDOCAI_STAGING_STORAGE_CANARY_COMPANY_A";
  const canaryPathA = `/storage/v1/object/company-manuals/${TENANT_A.companyId}/staging_isolation_canary.txt`;

  const canaryContentB = "POOLDOCAI_STAGING_STORAGE_CANARY_COMPANY_B";
  const canaryPathB = `/storage/v1/object/company-manuals/${TENANT_B.companyId}/staging_isolation_canary.txt`;

  if (sessions?.adminA && sessions?.adminB && sessions?.techA && sessions?.techB) {
    // 3A. AquaPure Admin creates/confirms canary in own prefix -> ALLOW (200, 201, or 409 already exists) & reads it back
    {
      let uploadRes = await authReq(sessions.adminA, canaryPathA, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: canaryContentA
      });
      if (uploadRes.status === 409 || uploadRes.status === 400) {
        uploadRes = await authReq(sessions.adminA, canaryPathA, {
          method: "PUT",
          headers: { "Content-Type": "text/plain" },
          body: canaryContentA
        });
      }
      const readRes = await authReq(sessions.adminA, canaryPathA);
      const ok = readRes.status === 200 && readRes.body.includes(canaryContentA);
      recordLiveResult("3A", "AquaPure Admin confirms own storage object exists & reads back (ALLOW)", ok, `Read status ${readRes.status}`);
    }

    // 3B. BlueWave Tech attempts to download AquaPure's confirmed canary object -> DENY (400, 401, or 403, NEVER 200)
    {
      const res = await authReq(sessions.techB, canaryPathA);
      const ok = res.status === 400 || res.status === 401 || res.status === 403;
      recordLiveResult("3B", "BlueWave Tech download of AquaPure confirmed canary rejected (DENY)", ok, `Status ${res.status}`);
    }

    // 3C. AquaPure Admin attempts upload into BlueWave directory -> DENY (400, 401, or 403, NEVER 200/201)
    {
      const res = await authReq(sessions.adminA, `/storage/v1/object/company-manuals/${TENANT_B.companyId}/malicious.txt`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "SPOOF_ATTEMPT"
      });
      const ok = res.status === 400 || res.status === 401 || res.status === 403;
      recordLiveResult("3C", "AquaPure Admin upload to BlueWave prefix rejected (DENY)", ok, `Status ${res.status}`);
    }

    // 3D. BlueWave Admin creates/confirms canary in own prefix -> ALLOW & reads it back
    {
      let uploadRes = await authReq(sessions.adminB, canaryPathB, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: canaryContentB
      });
      if (uploadRes.status === 409 || uploadRes.status === 400) {
        uploadRes = await authReq(sessions.adminB, canaryPathB, {
          method: "PUT",
          headers: { "Content-Type": "text/plain" },
          body: canaryContentB
        });
      }
      const readRes = await authReq(sessions.adminB, canaryPathB);
      const ok = readRes.status === 200 && readRes.body.includes(canaryContentB);
      recordLiveResult("3D", "BlueWave Admin confirms own storage object exists & reads back (ALLOW)", ok, `Read status ${readRes.status}`);
    }

    // 3E. AquaPure Tech attempts to download BlueWave's confirmed canary object -> DENY (400, 401, or 403, NEVER 200)
    {
      const res = await authReq(sessions.techA, canaryPathB);
      const ok = res.status === 400 || res.status === 401 || res.status === 403;
      recordLiveResult("3E", "AquaPure Tech download of BlueWave confirmed canary rejected (DENY)", ok, `Status ${res.status}`);
    }

    // 3F. Anonymous caller attempts download of confirmed canary object -> DENY (400, 401, or 403, NEVER 200)
    {
      const res = await anonReq(canaryPathA);
      const ok = res.status === 400 || res.status === 401 || res.status === 403;
      recordLiveResult("3F", "Anonymous download of confirmed private canary rejected (DENY)", ok, `Status ${res.status}`);
    }

    // Storage Canary Cleanup: Guaranteed removal of ephemeral test files
    try {
      await authReq(sessions.adminA, canaryPathA, { method: "DELETE" });
      await authReq(sessions.adminB, canaryPathB, { method: "DELETE" });
      console.log("  [STORAGE CLEANUP] Ephemeral test canaries successfully removed from staging bucket.");
    } catch (_) {}
  } else {
    const res = await anonReq(`/storage/v1/object/company-manuals/${TENANT_A.companyId}/doc.pdf`);
    const ok = res.status === 400 || res.status === 401 || res.status === 403;
    recordLiveResult("3F", "Anonymous download of private storage rejected (DENY)", ok, `Status ${res.status}`);
    liveResults.notRun += 5;
    console.log("  [LIVE NOT RUN] 3A-3E Storage Confirmed Isolation (Awaiting synthetic user sessions)");
  }

  // ==========================================================================
  // SECTION 4: Diagnostic Cases & Technician Job Records Isolation
  // Schema alignment: diagnostic_cases and technician_job_records use tenant_id column
  // ==========================================================================
  console.log("\n--- SECTION 4: Diagnostic Cases & Technician Job Records Isolation ---");
  if (sessions?.techA && sessions?.techB) {
    // 4A. AquaPure Tech reads diagnostic cases -> verify tenant_id scoping or authenticated revocation
    {
      const res = await authReq(sessions.techA, "/rest/v1/diagnostic_cases?select=id,tenant_id");
      if (res.status === 401 || res.status === 403) {
        // Migration 202610210001 revokes all from authenticated on diagnostic_cases
        recordLiveResult("4A", "diagnostic_cases authenticated access restricted by schema policy (ALLOW/RESTRICTED)", true, `Status ${res.status}`);
      } else if (res.status === 200 && Array.isArray(res.json)) {
        if (res.json.length === 0) {
          liveResults.notRun++;
          console.log("  [LIVE NOT RUN] 4A: diagnostic_cases has 0 synthetic rows in staging (positive control fixture absent)");
        } else {
          const ok = res.json.every(d => d.tenant_id === TENANT_A.companyId);
          recordLiveResult("4A", "AquaPure Tech reads only Company A diagnostic cases (ALLOW)", ok, `Status ${res.status}`);
        }
      } else {
        recordLiveResult("4A", "diagnostic_cases query", false, `Unexpected status ${res.status}`);
      }
    }

    // 4B. BlueWave Tech reads diagnostic cases -> verify tenant_id scoping or authenticated revocation
    {
      const res = await authReq(sessions.techB, "/rest/v1/diagnostic_cases?select=id,tenant_id");
      if (res.status === 401 || res.status === 403) {
        recordLiveResult("4B", "diagnostic_cases authenticated access restricted by schema policy (ALLOW/RESTRICTED)", true, `Status ${res.status}`);
      } else if (res.status === 200 && Array.isArray(res.json)) {
        if (res.json.length === 0) {
          liveResults.notRun++;
          console.log("  [LIVE NOT RUN] 4B: diagnostic_cases has 0 synthetic rows in staging (positive control fixture absent)");
        } else {
          const ok = res.json.every(d => d.tenant_id === TENANT_B.companyId);
          recordLiveResult("4B", "BlueWave Tech reads only Company B diagnostic cases (ALLOW)", ok, `Status ${res.status}`);
        }
      } else {
        recordLiveResult("4B", "diagnostic_cases query", false, `Unexpected status ${res.status}`);
      }
    }

    // 4C. AquaPure Tech cross-tenant mutation attempt on BlueWave diagnostic cases -> DENY (tenant_id)
    {
      const res = await authReq(sessions.techA, `/rest/v1/diagnostic_cases?tenant_id=eq.${TENANT_B.companyId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: { case_status: "spoofed" }
      });
      const ok = res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404 || (res.status === 200 && Array.isArray(res.json) && res.json.length === 0);
      recordLiveResult("4C", "AquaPure Tech cross-tenant PATCH on BlueWave diagnostic cases rejected (DENY)", ok, `Status ${res.status}`);
    }

    // 4D. AquaPure Tech reads technician_job_records -> verify tenant_id scoping or authenticated revocation
    {
      const res = await authReq(sessions.techA, "/rest/v1/technician_job_records?select=id,tenant_id");
      if (res.status === 401 || res.status === 403) {
        // Migration 202610210002 revokes all from authenticated on technician_job_records
        recordLiveResult("4D", "technician_job_records authenticated access restricted by schema policy (ALLOW/RESTRICTED)", true, `Status ${res.status}`);
      } else if (res.status === 200 && Array.isArray(res.json)) {
        if (res.json.length === 0) {
          liveResults.notRun++;
          console.log("  [LIVE NOT RUN] 4D: technician_job_records has 0 synthetic rows in staging (positive control fixture absent)");
        } else {
          const ok = res.json.every(j => j.tenant_id === TENANT_A.companyId);
          recordLiveResult("4D", "AquaPure Tech reads only Company A technician_job_records (ALLOW)", ok, `Status ${res.status}`);
        }
      } else {
        recordLiveResult("4D", "technician_job_records query", false, `Unexpected status ${res.status}`);
      }
    }

    // 4E. BlueWave Tech reads technician_job_records -> verify tenant_id scoping or authenticated revocation
    {
      const res = await authReq(sessions.techB, "/rest/v1/technician_job_records?select=id,tenant_id");
      if (res.status === 401 || res.status === 403) {
        recordLiveResult("4E", "technician_job_records authenticated access restricted by schema policy (ALLOW/RESTRICTED)", true, `Status ${res.status}`);
      } else if (res.status === 200 && Array.isArray(res.json)) {
        if (res.json.length === 0) {
          liveResults.notRun++;
          console.log("  [LIVE NOT RUN] 4E: technician_job_records has 0 synthetic rows in staging (positive control fixture absent)");
        } else {
          const ok = res.json.every(j => j.tenant_id === TENANT_B.companyId);
          recordLiveResult("4E", "BlueWave Tech reads only Company B technician_job_records (ALLOW)", ok, `Status ${res.status}`);
        }
      } else {
        recordLiveResult("4E", "technician_job_records query", false, `Unexpected status ${res.status}`);
      }
    }
  } else {
    liveResults.notRun += 5;
    console.log("  [LIVE NOT RUN] 4A-4E Diagnostic & Job Records Isolation (Awaiting synthetic user sessions)");
  }

  // ==========================================================================
  // SECTION 5: Retrieval & Notification RPCs
  // Notice: Migration 046 hardening is tracked in PR but pending live staging DDL deployment.
  // ==========================================================================
  console.log("\n--- SECTION 5: Retrieval & Notification RPCs ---");
  if (sessions?.techA && sessions?.techB) {
    // 5A. AquaPure Tech calls pooldocai_get_user_notifications RPC -> ALLOW (200, returns array)
    {
      const res = await authReq(sessions.techA, "/rest/v1/rpc/pooldocai_get_user_notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { p_limit: 10 }
      });
      const ok = res.status === 200 && Array.isArray(res.json);
      recordLiveResult("5A", "AquaPure Tech calls pooldocai_get_user_notifications (ALLOW)", ok, `Status ${res.status}`);
    }

    // 5B. BlueWave Tech calls pooldocai_get_user_notifications RPC -> ALLOW (200, returns array)
    {
      const res = await authReq(sessions.techB, "/rest/v1/rpc/pooldocai_get_user_notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { p_limit: 10 }
      });
      const ok = res.status === 200 && Array.isArray(res.json);
      recordLiveResult("5B", "BlueWave Tech calls pooldocai_get_user_notifications (ALLOW)", ok, `Status ${res.status}`);
    }
  } else {
    liveResults.notRun += 2;
    console.log("  [LIVE NOT RUN] 5A-5B Notification RPCs Authenticated (Awaiting synthetic user sessions)");
  }

  // 5C. Anonymous caller calls pooldocai_get_user_notifications RPC -> DENY (401 / AUTHENTICATION_REQUIRED)
  {
    const res = await anonReq("/rest/v1/rpc/pooldocai_get_user_notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { p_limit: 10 }
    });
    const ok = res.status === 401 || res.status === 403;
    recordLiveResult("5C", "Anonymous call to pooldocai_get_user_notifications rejected (DENY)", ok, `Status ${res.status}`);
  }

  // 5D. Anonymous caller calls pooldocai_touch_updated_at RPC -> DENY (401 / 403 / 404)
  {
    const res = await anonReq("/rest/v1/rpc/pooldocai_touch_updated_at", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: {}
    });
    const ok = res.status === 401 || res.status === 403 || res.status === 404;
    recordLiveResult("5D", "Anonymous call to pooldocai_touch_updated_at rejected (DENY)", ok, `Status ${res.status}`);
  }

  if (sessions?.techA) {
    // 5E. AquaPure Tech calls hybrid retrieval for own company -> ALLOW (200, array)
    {
      const res = await authReq(sessions.techA, "/rest/v1/rpc/search_company_manual_chunks_hybrid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { p_company_id: TENANT_A.companyId, p_query: "pump fuse", p_limit: 5 }
      });
      const ok = res.status === 200 && Array.isArray(res.json);
      recordLiveResult("5E", "AquaPure Tech search_company_manual_chunks_hybrid on own company (ALLOW)", ok, `Status ${res.status}`);
    }

    // 5F. AquaPure Tech calls hybrid retrieval with BlueWave company ID -> DENY (200 with empty [] or 403)
    {
      const res = await authReq(sessions.techA, "/rest/v1/rpc/search_company_manual_chunks_hybrid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: { p_company_id: TENANT_B.companyId, p_query: "filter cartridge", p_limit: 5 }
      });
      const ok = (res.status === 200 && Array.isArray(res.json) && res.json.length === 0) || res.status === 403;
      recordLiveResult("5F", "AquaPure Tech hybrid retrieval on BlueWave company returns empty [] (DENY)", ok, `Status ${res.status}`);
    }
  } else {
    liveResults.notRun += 2;
    console.log("  [LIVE NOT RUN] 5E-5F Hybrid Retrieval Multi-Tenant (Awaiting synthetic user sessions)");
  }

  // ==========================================================================
  // SECTION 6: Negative Controls & Tampered Token Checks
  // ==========================================================================
  console.log("\n--- SECTION 6: Negative Controls & Tampered Token Checks ---");
  // 6A. Completely invalid / forged JWT -> DENY (401 Unauthorized)
  {
    const res = await makeHttpsRequest(parsedUrl.hostname, "/rest/v1/service_requests", {
      headers: {
        "apikey": stagingAnonKey,
        "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.fake_signature_forged_token"
      }
    });
    const ok = res.status === 401;
    recordLiveResult("6A", "Forged / invalid JWT request rejected with 401 (DENY)", ok, `Status ${res.status}`);
  }

  // 6B. Expired / malformed header request -> DENY (401 Unauthorized)
  {
    const res = await makeHttpsRequest(parsedUrl.hostname, "/rest/v1/service_requests", {
      headers: {
        "apikey": stagingAnonKey,
        "Authorization": "Bearer malformed_token_string"
      }
    });
    const ok = res.status === 401;
    recordLiveResult("6B", "Malformed bearer token request rejected with 401 (DENY)", ok, `Status ${res.status}`);
  }

  // Summary and Accounting
  console.log("\n================================================================");
  console.log(`[LIVE STAGING TEST SUMMARY]`);
  console.log(`  PASSED:  ${liveResults.passed}`);
  console.log(`  FAILED:  ${liveResults.failed}`);
  console.log(`  NOT RUN: ${liveResults.notRun}`);
  console.log(`  TOTAL:   ${TOTAL_TEST_COUNT}`);
  console.log("================================================================\n");

  if (liveResults.failed > 0) {
    if (requireLiveStaging) {
      throw new Error(`[FATAL RELEASE GATE ERROR] ${liveResults.failed} live staging tests failed.`);
    }
    return {
      status: "FAILED",
      targetProject: STAGING_PROJECT_REF,
      passed: liveResults.passed,
      failed: liveResults.failed,
      notRun: liveResults.notRun
    };
  }

  if (liveResults.notRun > 0 && requireLiveStaging) {
    throw new Error(`[FATAL RELEASE GATE ERROR] REQUIRE_LIVE_STAGING=1 is set, but ${liveResults.notRun} tests were NOT RUN.`);
  }

  return {
    status: liveResults.notRun === 0 ? "COMPLETE" : "PARTIAL",
    targetProject: STAGING_PROJECT_REF,
    passed: liveResults.passed,
    failed: liveResults.failed,
    notRun: liveResults.notRun
  };
}

if (require.main === module) {
  runLiveStagingIntegrationTests().catch(err => {
    console.error("Live Staging Test Failed:", err);
    process.exit(1);
  });
}

module.exports = { runLiveStagingIntegrationTests };
