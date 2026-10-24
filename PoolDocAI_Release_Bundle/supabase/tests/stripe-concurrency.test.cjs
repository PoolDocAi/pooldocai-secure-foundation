const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawn, execSync } = require("node:child_process");

const PG_URL = process.env.PG_URL || process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

// Fail-closed guard against running concurrency tests against production
if (PG_URL.includes("owfeebydlyacssqpnmkq")) {
  throw new Error("Safety violation: refusing to run concurrency test against production database owfeebydlyacssqpnmkq.");
}

// Helper to execute a single SQL command via psql
function query(sql, pgUrl = PG_URL) {
  try {
    const stdout = execSync(`psql "${pgUrl}" -X -A -t -c "${sql.replace(/"/g, '\\"')}"`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });
    return stdout.trim();
  } catch (err) {
    throw new Error(`psql query error: ${err.stderr || err.message}`);
  }
}

// Helper to spawn an interactive psql session
function createPsqlSession(pgUrl = PG_URL) {
  const proc = spawn("psql", [pgUrl, "-X", "-A", "-t", "-q"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env
  });

  let stdoutBuffer = "";
  let stderrBuffer = "";
  proc.stdout.on("data", (data) => {
    stdoutBuffer += data.toString("utf8");
  });
  proc.stderr.on("data", (data) => {
    stderrBuffer += data.toString("utf8");
  });

  return {
    proc,
    execute: (command) => {
      stdoutBuffer = "";
      stderrBuffer = "";
      proc.stdin.write(command + "\n");
    },
    waitForOutput: (timeoutMs = 5000) => {
      return new Promise((resolve, reject) => {
        const start = Date.now();
        const interval = setInterval(() => {
          if (stderrBuffer.trim().includes("ERROR:")) {
            clearInterval(interval);
            const err = stderrBuffer.trim();
            stderrBuffer = "";
            reject(new Error(`psql error: ${err}`));
          } else if (stdoutBuffer.trim().length > 0) {
            clearInterval(interval);
            const res = stdoutBuffer.trim();
            stdoutBuffer = "";
            resolve(res);
          } else if (Date.now() - start > timeoutMs) {
            clearInterval(interval);
            reject(new Error(`psql timeout waiting for output (${timeoutMs}ms) - stderr: ${stderrBuffer.trim()}`));
          }
        }, 50);
      });
    },
    close: () => {
      try {
        proc.stdin.end();
        proc.kill();
      } catch (e) {}
    }
  };
}

async function runConcurrencyTest() {
  console.log("Starting Real Two-Connection PostgreSQL Stripe Webhook Concurrency Test...\n");

  // Check if psql is available and database is reachable
  try {
    const version = execSync(`psql "${PG_URL}" -X -A -t -c "SELECT 1"`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3000
    });
    if (version.trim() !== "1") {
      throw new Error("Unexpected response from DB ping");
    }
  } catch (err) {
    if (process.env.CI || process.env.GITHUB_ACTIONS) {
      console.error(`[stripe-concurrency] FATAL: PostgreSQL is unreachable at ${PG_URL} in CI environment.`);
      console.error(err);
      process.exit(1);
    }
    console.log(`[stripe-concurrency] PostgreSQL is not reachable at ${PG_URL} (${err.message.trim()}).`);
    console.log("[stripe-concurrency] Skipping live database concurrency test in environments without running Supabase container.");
    console.log("[stripe-concurrency] (This test executes fully in CI with live Supabase).\n");
    return;
  }

  // Cryptographically unique IDs for isolated test execution
  const testCompanyId = crypto.randomUUID();
  const testEventId = `evt_concurrency_${crypto.randomUUID().replace(/-/g, "")}`;
  const testEventMarch = `evt_concurrency_march_${crypto.randomUUID().replace(/-/g, "")}`;
  const testEventFeb = `evt_concurrency_feb_${crypto.randomUUID().replace(/-/g, "")}`;
  const createdEventIds = [testEventId, testEventMarch, testEventFeb];

  console.log(`[stripe-concurrency] Test Company ID: ${testCompanyId}`);
  console.log(`[stripe-concurrency] Test Event IDs: ${createdEventIds.join(", ")}`);

  // Create temporary test company
  query(`
    INSERT INTO public.companies (id, name, status, plan_name, seat_limit, billing_status)
    VALUES ('${testCompanyId}', 'Concurrency Test Pool Co', 'active', 'pilot', 2, 'active')
    ON CONFLICT (id) DO UPDATE SET plan_name = 'pilot', billing_status = 'active';
  `);

  let session1 = null;
  let session2 = null;

  try {
    session1 = createPsqlSession();
    session2 = createPsqlSession();

    // ---------------------------------------------------------------------------
    // Step 1: Deterministic Simultaneous Claim Race
    // Connection 1 begins transaction and claims the row (holding exclusive row lock).
    // Connection 2 immediately attempts claim and blocks waiting on Connection 1.
    // ---------------------------------------------------------------------------
    console.log("Step 1: Testing simultaneous claim race with row lock contention...");

    session1.execute(`BEGIN;`);
    session1.execute(`SELECT public.pooldocai_claim_stripe_webhook_event('${testEventId}', 'customer.subscription.updated', 60, 5);`);
    const claim1Raw = await session1.waitForOutput();
    const claim1 = JSON.parse(claim1Raw);

    assert.equal(claim1.status, "claimed", "Connection 1 must acquire claim");
    assert.ok(claim1.claim_token && claim1.claim_token.startsWith("claim_"), "Connection 1 must receive claim token");
    assert.equal(claim1.lease_generation, 1, "First lease generation must be 1");
    const token1 = claim1.claim_token;

    // Connection 2 attempts claim while Connection 1 still holds the lock in-transaction
    session2.execute(`SELECT public.pooldocai_claim_stripe_webhook_event('${testEventId}', 'customer.subscription.updated', 60, 5);`);

    // Let Connection 2 block on row lock for 200ms, then Connection 1 commits
    await new Promise((r) => setTimeout(r, 200));
    session1.execute(`COMMIT;`);

    // Connection 2 unblocks immediately upon Connection 1's commit
    const claim2Raw = await session2.waitForOutput();
    const claim2 = JSON.parse(claim2Raw);

    assert.equal(claim2.status, "in_progress", "Connection 2 must be rejected with in_progress while Connection 1's lease is active");
    assert.ok(claim2.retry_after > 0, "Connection 2 must receive positive retry_after");
    assert.equal(claim2.lease_generation, 1);
    console.log("PASS: Step 1 - Connection 1 acquired claim; Connection 2 blocked on lock and safely received in_progress.");

    // ---------------------------------------------------------------------------
    // Step 2: Expired Lease Takeover by Connection 2
    // Simulate Connection 1 hanging/crashing past lease timeout (60s).
    // ---------------------------------------------------------------------------
    console.log("Step 2: Simulating lease expiry and Connection 2 claim takeover...");
    query(`
      UPDATE public.pooldocai_stripe_webhook_events
      SET claimed_at = clock_timestamp() - interval '70 seconds'
      WHERE stripe_event_id = '${testEventId}';
    `);

    session2.execute(`SELECT public.pooldocai_claim_stripe_webhook_event('${testEventId}', 'customer.subscription.updated', 60, 5);`);
    const takeoverRaw = await session2.waitForOutput();
    const takeover = JSON.parse(takeoverRaw);

    assert.equal(takeover.status, "claimed", "Connection 2 must acquire claim after lease expiry");
    assert.ok(takeover.claim_token && takeover.claim_token.startsWith("claim_"));
    assert.notEqual(takeover.claim_token, token1, "Connection 2 must receive a new unpredictable token");
    assert.equal(takeover.lease_generation, 2, "Lease generation must increment to 2");
    const token2 = takeover.claim_token;
    console.log("PASS: Step 2 - Connection 2 took over expired lease with new token and incremented lease generation.");

    // ---------------------------------------------------------------------------
    // Step 3: Fencing Out Stale Worker's Billing Mutations
    // Connection 1 (stale worker) wakes up and attempts to mutate company with stale token1.
    // ---------------------------------------------------------------------------
    console.log("Step 3: Verifying stale Connection 1 is fenced out from modifying company billing...");
    session1.execute(`
      SELECT public.pooldocai_apply_and_finalize_stripe_webhook(
        '${testEventId}',
        '${token1}',
        '${testCompanyId}'::uuid,
        '{"plan_name": "starter"}'::jsonb,
        NULL,
        NULL,
        false
      );
    `);
    const staleApplyRaw = await session1.waitForOutput();
    const staleApply = JSON.parse(staleApplyRaw);

    assert.equal(staleApply.success, false, "Stale worker apply must fail");
    assert.equal(staleApply.fenced, true, "Stale worker must be flagged as fenced");
    assert.equal(staleApply.status, "fenced_out", "Status must be fenced_out");

    // Verify company billing was NOT mutated by stale worker
    const currentPlan = query(`SELECT plan_name FROM public.companies WHERE id = '${testCompanyId}';`);
    assert.equal(currentPlan, "pilot", "Company plan must remain untouched by stale worker");
    console.log("PASS: Step 3 - Stale worker was fenced out; company plan remained uncorrupted.");

    // ---------------------------------------------------------------------------
    // Step 4: Fencing Out Stale Worker Error Release
    // Connection 1 catches error and attempts to release the event with stale token1.
    // ---------------------------------------------------------------------------
    console.log("Step 4: Verifying stale Connection 1 cannot clear Connection 2's active claim...");
    session1.execute(`
      SELECT public.pooldocai_release_stripe_webhook_event(
        '${testEventId}',
        '${token1}',
        'Stale worker failure'
      );
    `);
    const staleReleaseRaw = await session1.waitForOutput();
    const staleRelease = JSON.parse(staleReleaseRaw);

    assert.equal(staleRelease.success, false);
    assert.equal(staleRelease.fenced, true);

    // Verify Connection 2's claim remains active
    const activeTokenInDb = query(`SELECT claim_token FROM public.pooldocai_stripe_webhook_events WHERE stripe_event_id = '${testEventId}';`);
    assert.equal(activeTokenInDb, token2, "Connection 2's claim token must remain active in DB");
    console.log("PASS: Step 4 - Stale worker cannot release active lease of Connection 2.");

    // ---------------------------------------------------------------------------
    // Step 5: Active Worker (Connection 2) Successfully Applies Mutations
    // ---------------------------------------------------------------------------
    console.log("Step 5: Verifying active Connection 2 successfully applies billing changes...");
    session2.execute(`
      SELECT public.pooldocai_apply_and_finalize_stripe_webhook(
        '${testEventId}',
        '${token2}',
        '${testCompanyId}'::uuid,
        '{"plan_name": "fleet_complete", "billing_status": "active"}'::jsonb,
        '{"event_type": "stripe_customer.subscription.updated", "units": 1}'::jsonb,
        NULL,
        false
      );
    `);
    const validApplyRaw = await session2.waitForOutput();
    const validApply = JSON.parse(validApplyRaw);

    assert.equal(validApply.success, true);
    assert.equal(validApply.processed, true);
    assert.equal(validApply.status, "applied");

    const updatedPlan = query(`SELECT plan_name FROM public.companies WHERE id = '${testCompanyId}';`);
    assert.equal(updatedPlan, "fleet_complete", "Company plan must be updated to fleet_complete");
    console.log("PASS: Step 5 - Active Connection 2 applied company billing updates and finalized event.");

    // ---------------------------------------------------------------------------
    // Step 6: Idempotent Duplicate Replay
    // Subsequent deliveries return already_processed
    // ---------------------------------------------------------------------------
    console.log("Step 6: Verifying subsequent deliveries are recognized as duplicate...");
    session1.execute(`SELECT public.pooldocai_claim_stripe_webhook_event('${testEventId}', 'customer.subscription.updated', 60, 5);`);
    const dupRaw = await session1.waitForOutput();
    const dup = JSON.parse(dupRaw);

    assert.equal(dup.status, "already_processed");
    assert.equal(dup.duplicate, true);
    console.log("PASS: Step 6 - Replay of processed event idempotently acknowledges duplicate.");

    // ---------------------------------------------------------------------------
    // Step 7: Cross-Event Ordering Concurrency for Same Company (Migration 035)
    // Two distinct event IDs (March and February) target the same company.
    // When March is applied first, February must be safely ignored under the company row lock
    // and must not overwrite the newer plan or billing period.
    // ---------------------------------------------------------------------------
    console.log("Step 7: Testing cross-event ordering concurrency on the same company...");

    // Claim Event March on Connection 1
    session1.execute(`SELECT public.pooldocai_claim_stripe_webhook_event('${testEventMarch}', 'customer.subscription.updated', 60, 5);`);
    const claimMarchRaw = await session1.waitForOutput();
    const claimMarch = JSON.parse(claimMarchRaw);
    assert.equal(claimMarch.status, "claimed");
    const tokenMarch = claimMarch.claim_token;

    // Claim Event February on Connection 2
    session2.execute(`SELECT public.pooldocai_claim_stripe_webhook_event('${testEventFeb}', 'customer.subscription.updated', 60, 5);`);
    const claimFebRaw = await session2.waitForOutput();
    const claimFeb = JSON.parse(claimFebRaw);
    assert.equal(claimFeb.status, "claimed");
    const tokenFeb = claimFeb.claim_token;

    // Connection 1 applies March update: plan pro_complete, billing_period_start: 2026-03-01T00:00:00Z
    session1.execute(`
      SELECT public.pooldocai_apply_and_finalize_stripe_webhook(
        '${testEventMarch}',
        '${tokenMarch}',
        '${testCompanyId}'::uuid,
        '{"plan_name": "pro_complete", "billing_status": "active", "billing_period_start": "2026-03-01T00:00:00Z"}'::jsonb,
        '{"event_type": "stripe_customer.subscription.updated", "units": 1}'::jsonb,
        NULL,
        false
      );
    `);
    const applyMarchRaw = await session1.waitForOutput();
    const applyMarch = JSON.parse(applyMarchRaw);
    assert.equal(applyMarch.success, true);
    assert.equal(applyMarch.status, "applied");

    // Verify company is now pro_complete with March period start
    const marchPlan = query(`SELECT plan_name FROM public.companies WHERE id = '${testCompanyId}';`);
    assert.equal(marchPlan, "pro_complete");

    // Connection 2 now attempts to apply February update: plan solo_tech, billing_period_start: 2026-02-01T00:00:00Z
    // Under company row lock, pooldocai_apply_and_finalize_stripe_webhook compares 2026-02-01 against current 2026-03-01.
    // It must detect stale period, finalize the event as ignored without mutating the company, and return status 'ignored'.
    session2.execute(`
      SELECT public.pooldocai_apply_and_finalize_stripe_webhook(
        '${testEventFeb}',
        '${tokenFeb}',
        '${testCompanyId}'::uuid,
        '{"plan_name": "solo_tech", "billing_status": "active", "billing_period_start": "2026-02-01T00:00:00Z"}'::jsonb,
        '{"event_type": "stripe_customer.subscription.updated", "units": 1}'::jsonb,
        NULL,
        false
      );
    `);
    const applyFebRaw = await session2.waitForOutput();
    const applyFeb = JSON.parse(applyFebRaw);

    assert.equal(applyFeb.success, true, "February finalization must succeed so Stripe does not loop");
    assert.equal(applyFeb.status, "ignored", "February must be ignored due to stale period start");
    assert.equal(applyFeb.reason, "stale_out_of_order_event", "Reason must be stale_out_of_order_event");

    // Verify company row remains untouched by February event
    const companyAfterFeb = query(`SELECT plan_name, billing_period_start FROM public.companies WHERE id = '${testCompanyId}';`);
    assert.ok(companyAfterFeb.includes("pro_complete"), "Company plan must remain pro_complete");
    assert.ok(companyAfterFeb.includes("2026-03-01"), "Company billing period must remain March");

    // Verify February event is marked processed in webhook ledger
    const febProcessed = query(`SELECT processed FROM public.pooldocai_stripe_webhook_events WHERE stripe_event_id = '${testEventFeb}';`);
    assert.equal(febProcessed, "t", "February event must be marked processed in ledger");

    console.log("PASS: Step 7 - Cross-event ordering guard correctly ignored stale February event and preserved March billing state.");

    console.log("\nALL REAL TWO-CONNECTION POSTGRESQL CONCURRENCY TESTS PASSED SUCCESSFULLY.");
  } finally {
    if (session1) session1.close();
    if (session2) session2.close();

    // Tear down test fixtures explicitly without wildcards
    try {
      const eventList = createdEventIds.map(id => `'${id}'`).join(",");
      query(`DELETE FROM public.pooldocai_stripe_webhook_events WHERE stripe_event_id IN (${eventList});`);
      query(`DELETE FROM public.platform_usage_events WHERE source_event_key IN (${eventList});`);
      query(`DELETE FROM public.companies WHERE id = '${testCompanyId}';`);
    } catch (cleanupErr) {
      console.warn("Cleanup warning:", cleanupErr.message);
    }
  }
}

runConcurrencyTest().catch((err) => {
  console.error("FAIL in real PostgreSQL concurrency tests:", err);
  process.exit(1);
});
