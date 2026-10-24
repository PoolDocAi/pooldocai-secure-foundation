const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { spawn, execSync } = require("node:child_process");

function getValidatedPgConfig() {
  const raw = process.env.PG_URL || process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
  if (raw.includes("owfeebydlyacssqpnmkq")) {
    throw new Error("Safety violation: refusing to run concurrency test against production database owfeebydlyacssqpnmkq.");
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (err) {
    throw new Error("Safety violation: Invalid PostgreSQL connection URL format.");
  }

  const hostname = (parsed.hostname || "").toLowerCase();
  const isLoopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  const allowStaging = process.env.ALLOW_STAGING_TEST_DB === "true";

  if (!isLoopback && !allowStaging) {
    throw new Error(`Safety violation: Integration test fixture mutations are strictly restricted to local disposable test database (loopback 127.0.0.1/localhost). Found host: ${hostname}`);
  }

  const sanitized = raw.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");
  return { raw, sanitized };
}

const { raw: PG_URL, sanitized: SANITIZED_PG_URL } = getValidatedPgConfig();

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
    const cleanErr = String(err.stderr || err.message || "").replace(/:\/\/[^:]+:[^@]+@/g, "://***:***@");
    throw new Error(`psql query error: ${cleanErr}`);
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
    hasOutput: () => stdoutBuffer.trim().length > 0,
    waitForOutput: (timeoutMs = 5000) => {
      return new Promise((resolve, reject) => {
        const start = Date.now();
        const interval = setInterval(() => {
          if (stderrBuffer.trim().includes("ERROR:")) {
            clearInterval(interval);
            const err = stderrBuffer.trim().replace(/:\/\/[^:]+:[^@]+@/g, "://***:***@");
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
  console.log(`[stripe-concurrency] Safe DB Target: ${SANITIZED_PG_URL}`);

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
      console.error(`[stripe-concurrency] FATAL: PostgreSQL is unreachable in CI environment.`);
      console.error(String(err.message || "").replace(/:\/\/[^:]+:[^@]+@/g, "://***:***@"));
      process.exit(1);
    }
    console.log(`[stripe-concurrency] PostgreSQL is not reachable at ${SANITIZED_PG_URL}.`);
    console.log("[stripe-concurrency] Skipping live database concurrency test in environments without running Supabase container.");
    console.log("[stripe-concurrency] (This test executes fully in CI with live Supabase).\n");
    return;
  }

  // Cryptographically unique IDs for isolated test execution
  const testCompanyId = crypto.randomUUID();
  const testEventId = `evt_concurrency_${crypto.randomUUID().replace(/-/g, "")}`;
  const testEventMarch = `evt_concurrency_march_${crypto.randomUUID().replace(/-/g, "")}`;
  const testEventFeb = `evt_concurrency_feb_${crypto.randomUUID().replace(/-/g, "")}`;
  const testSubIdA = `sub_a_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
  const testSubIdB = `sub_b_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
  const testSubIdC = `sub_c_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
  const testEventSubB = `evt_concurrency_sub_b_${crypto.randomUUID().replace(/-/g, "")}`;
  const testEventInvA = `evt_concurrency_inv_a_${crypto.randomUUID().replace(/-/g, "")}`;
  const testEventInvFailFirst = `evt_inv_fail_first_${crypto.randomUUID().replace(/-/g, "")}`;
  const testEventSubRecover = `evt_recover_${crypto.randomUUID().replace(/-/g, "")}`;
  const testEventInvPaid = `evt_concurrency_inv_paid_${crypto.randomUUID().replace(/-/g, "")}`;

  const createdEventIds = [
    testEventId,
    testEventMarch,
    testEventFeb,
    testEventSubB,
    testEventInvA,
    testEventInvFailFirst,
    testEventSubRecover,
    testEventInvPaid
  ];

  console.log(`[stripe-concurrency] Test Company ID: ${testCompanyId}`);
  console.log(`[stripe-concurrency] Test Event IDs: ${createdEventIds.length} generated`);

  // Create temporary test company initialized to pilot
  query(`
    INSERT INTO public.companies (id, name, status, plan_name, seat_limit, billing_status, stripe_subscription_id, billing_period_start)
    VALUES ('${testCompanyId}', 'Concurrency Test Pool Co', 'active', 'pilot', 2, 'active', '${testSubIdA}', '2026-01-01T00:00:00Z')
    ON CONFLICT (id) DO UPDATE SET plan_name = 'pilot', billing_status = 'active', stripe_subscription_id = '${testSubIdA}', billing_period_start = '2026-01-01T00:00:00Z';
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
        false,
        NULL
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
        false,
        '{"subscription_id": "${testSubIdA}", "event_type": "customer.subscription.updated"}'::jsonb
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
    // Step 7a: True In-Transaction Company Row-Lock Contention (March vs February)
    // Connection 1 begins transaction and calls pooldocai_apply_and_finalize_stripe_webhook,
    // which acquires and holds the companies FOR UPDATE row lock.
    // Connection 2 simultaneously calls finalize for February on the SAME company and BLOCKS.
    // Connection 1 commits -> Connection 2 unblocks and is safely ignored due to stale period.
    // ---------------------------------------------------------------------------
    console.log("Step 7a: Testing true in-transaction row-lock blocking on the company (March vs February)...");

    // Claim Event March on Connection 1
    session1.execute(`SELECT public.pooldocai_claim_stripe_webhook_event('${testEventMarch}', 'customer.subscription.updated', 60, 5);`);
    const claimMarch = JSON.parse(await session1.waitForOutput());
    assert.equal(claimMarch.status, "claimed");
    const tokenMarch = claimMarch.claim_token;

    // Claim Event February on Connection 2
    session2.execute(`SELECT public.pooldocai_claim_stripe_webhook_event('${testEventFeb}', 'customer.subscription.updated', 60, 5);`);
    const claimFeb = JSON.parse(await session2.waitForOutput());
    assert.equal(claimFeb.status, "claimed");
    const tokenFeb = claimFeb.claim_token;

    // Connection 1 begins open transaction and acquires the company row lock
    session1.execute(`BEGIN;`);
    session1.execute(`
      SELECT public.pooldocai_apply_and_finalize_stripe_webhook(
        '${testEventMarch}',
        '${tokenMarch}',
        '${testCompanyId}'::uuid,
        '{"plan_name": "pro_complete", "billing_status": "active", "billing_period_start": "2026-03-01T00:00:00Z"}'::jsonb,
        '{"event_type": "stripe_customer.subscription.updated", "units": 1}'::jsonb,
        NULL,
        false,
        '{"subscription_id": "${testSubIdA}", "period_start": "2026-03-01T00:00:00Z", "event_type": "customer.subscription.updated"}'::jsonb
      );
    `);
    const applyMarch = JSON.parse(await session1.waitForOutput());
    assert.equal(applyMarch.success, true);
    // Connection 1 is still in open transaction, holding the exclusive company row lock!

    // Connection 2 now issues competing finalize RPC for February and BLOCKS on the company row lock
    session2.execute(`
      SELECT public.pooldocai_apply_and_finalize_stripe_webhook(
        '${testEventFeb}',
        '${tokenFeb}',
        '${testCompanyId}'::uuid,
        '{"plan_name": "solo_tech", "billing_status": "active", "billing_period_start": "2026-02-01T00:00:00Z"}'::jsonb,
        '{"event_type": "stripe_customer.subscription.updated", "units": 1}'::jsonb,
        NULL,
        false,
        '{"subscription_id": "${testSubIdA}", "period_start": "2026-02-01T00:00:00Z", "event_type": "customer.subscription.updated"}'::jsonb
      );
    `);

    // Prove Connection 2 is blocked waiting on Connection 1
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(session2.hasOutput(), false, "Connection 2 MUST block on the locked company row");

    // Connection 1 commits, releasing the company row lock
    session1.execute(`COMMIT;`);

    // Connection 2 unblocks immediately upon Connection 1's commit
    const applyFebRaw = await session2.waitForOutput();
    const applyFeb = JSON.parse(applyFebRaw);

    assert.equal(applyFeb.success, true);
    assert.equal(applyFeb.status, "ignored", "February must be safely marked ignored");
    assert.equal(applyFeb.reason, "stale_out_of_order_event");

    const planAfter7a = query(`SELECT plan_name, billing_period_start FROM public.companies WHERE id = '${testCompanyId}';`);
    assert.ok(planAfter7a.includes("pro_complete"), "Company plan must remain pro_complete");
    assert.ok(planAfter7a.includes("2026-03-01"), "Billing period must remain March");
    console.log("PASS: Step 7a - Deterministic in-transaction row lock verified; February blocked and was safely ignored.");

    // ---------------------------------------------------------------------------
    // Step 7b: Contention: Old Subscription Invoice vs Replacement Subscription (P1 Bug)
    // Connection 1 applies replacement Subscription B with period 2026-03-15 and holds company lock.
    // Connection 2 simultaneously attempts to apply old Invoice A (payment_failed) for Subscription A.
    // Connection 2 blocks waiting on company lock. Connection 1 commits.
    // Connection 2 unblocks: Migration 036 detects sub_A != sub_B and safely ignores Invoice A.
    // ---------------------------------------------------------------------------
    console.log("Step 7b: Testing contention between replacement subscription B and stale invoice on subscription A...");

    // Claim replacement Subscription B on Connection 1
    session1.execute(`SELECT public.pooldocai_claim_stripe_webhook_event('${testEventSubB}', 'customer.subscription.updated', 60, 5);`);
    const claimSubB = JSON.parse(await session1.waitForOutput());
    assert.equal(claimSubB.status, "claimed");
    const tokenSubB = claimSubB.claim_token;

    // Claim old Invoice A on Connection 2
    session2.execute(`SELECT public.pooldocai_claim_stripe_webhook_event('${testEventInvA}', 'invoice.payment_failed', 60, 5);`);
    const claimInvA = JSON.parse(await session2.waitForOutput());
    assert.equal(claimInvA.status, "claimed");
    const tokenInvA = claimInvA.claim_token;

    // Connection 1 begins transaction and applies Subscription B (enterprise, active, period 2026-03-15)
    session1.execute(`BEGIN;`);
    session1.execute(`
      SELECT public.pooldocai_apply_and_finalize_stripe_webhook(
        '${testEventSubB}',
        '${tokenSubB}',
        '${testCompanyId}'::uuid,
        '{"stripe_subscription_id": "${testSubIdB}", "plan_name": "enterprise", "billing_status": "active", "billing_period_start": "2026-03-15T00:00:00Z"}'::jsonb,
        '{"event_type": "stripe_customer.subscription.updated", "units": 1}'::jsonb,
        NULL,
        false,
        '{"subscription_id": "${testSubIdB}", "period_start": "2026-03-15T00:00:00Z", "event_type": "customer.subscription.updated"}'::jsonb
      );
    `);
    const applySubB = JSON.parse(await session1.waitForOutput());
    assert.equal(applySubB.success, true);

    // Connection 2 attempts to apply Invoice A (payment_failed) which only has billing_status: past_due in company updates,
    // but carries subscription_id: sub_A in its event provenance.
    session2.execute(`
      SELECT public.pooldocai_apply_and_finalize_stripe_webhook(
        '${testEventInvA}',
        '${tokenInvA}',
        '${testCompanyId}'::uuid,
        '{"billing_status": "past_due"}'::jsonb,
        '{"event_type": "stripe_invoice.payment_failed", "units": 1}'::jsonb,
        NULL,
        false,
        '{"subscription_id": "${testSubIdA}", "period_start": "2026-02-15T00:00:00Z", "event_type": "invoice.payment_failed"}'::jsonb
      );
    `);

    // Verify Connection 2 blocks on the locked company row
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(session2.hasOutput(), false, "Connection 2 must block on company row lock during invoice application");

    // Connection 1 commits Subscription B
    session1.execute(`COMMIT;`);

    // Connection 2 unblocks
    const applyInvARaw = await session2.waitForOutput();
    const applyInvA = JSON.parse(applyInvARaw);

    assert.equal(applyInvA.success, true);
    assert.equal(applyInvA.status, "ignored", "Old subscription invoice must be safely ignored");
    assert.equal(applyInvA.reason, "stale_old_subscription_invoice");

    // Verify company remains Enterprise, Active, and on Subscription B!
    const coState7b = query(`SELECT stripe_subscription_id, plan_name, billing_status FROM public.companies WHERE id = '${testCompanyId}';`);
    assert.ok(coState7b.includes(testSubIdB), "Company must remain on subscription B");
    assert.ok(coState7b.includes("enterprise"), "Company must remain enterprise");
    assert.ok(coState7b.includes("active"), "Company MUST NOT be flipped to past_due by old subscription invoice");
    console.log("PASS: Step 7b - Old subscription invoice safely blocked and ignored; new subscription remained active.");

    // ---------------------------------------------------------------------------
    // Step 7c: Reverse Ordering & Legitimate Resubscription
    // Test that legitimate replacement subscription overrides a prior past_due status.
    // ---------------------------------------------------------------------------
    console.log("Step 7c: Testing reverse ordering and legitimate replacement recovery...");

    // 1. First, an invoice payment fails on the active subscription B
    session1.execute(`SELECT public.pooldocai_claim_stripe_webhook_event('${testEventInvFailFirst}', 'invoice.payment_failed', 60, 5);`);
    const claimFailFirst = JSON.parse(await session1.waitForOutput());
    assert.equal(claimFailFirst.status, "claimed");

    session1.execute(`
      SELECT public.pooldocai_apply_and_finalize_stripe_webhook(
        '${testEventInvFailFirst}',
        '${claimFailFirst.claim_token}',
        '${testCompanyId}'::uuid,
        '{"billing_status": "past_due"}'::jsonb,
        '{"event_type": "stripe_invoice.payment_failed", "units": 1}'::jsonb,
        NULL,
        false,
        '{"subscription_id": "${testSubIdB}", "period_start": "2026-03-15T00:00:00Z", "event_type": "invoice.payment_failed"}'::jsonb
      );
    `);
    const applyFailFirst = JSON.parse(await session1.waitForOutput());
    assert.equal(applyFailFirst.success, true);
    assert.equal(applyFailFirst.status, "applied");

    // Company is now past_due
    const coStatePastDue = query(`SELECT billing_status FROM public.companies WHERE id = '${testCompanyId}';`);
    assert.ok(coStatePastDue.includes("past_due"), "Company should be past_due after invoice payment failure");

    // 2. Next, a legitimate replacement/resubscription arrives with a newer billing period
    session1.execute(`SELECT public.pooldocai_claim_stripe_webhook_event('${testEventSubRecover}', 'customer.subscription.updated', 60, 5);`);
    const claimRecover = JSON.parse(await session1.waitForOutput());
    assert.equal(claimRecover.status, "claimed");

    session1.execute(`
      SELECT public.pooldocai_apply_and_finalize_stripe_webhook(
        '${testEventSubRecover}',
        '${claimRecover.claim_token}',
        '${testCompanyId}'::uuid,
        '{"stripe_subscription_id": "${testSubIdC}", "plan_name": "fleet_complete", "billing_status": "active", "billing_period_start": "2026-04-01T00:00:00Z"}'::jsonb,
        NULL,
        NULL,
        false,
        '{"subscription_id": "${testSubIdC}", "period_start": "2026-04-01T00:00:00Z", "event_type": "customer.subscription.updated"}'::jsonb
      );
    `);
    const applyRecover = JSON.parse(await session1.waitForOutput());
    assert.equal(applyRecover.success, true);
    assert.equal(applyRecover.status, "applied");

    const coStateRecover = query(`SELECT stripe_subscription_id, billing_status, plan_name FROM public.companies WHERE id = '${testCompanyId}';`);
    assert.ok(coStateRecover.includes(testSubIdC), "Company must update to new subscription C");
    assert.ok(coStateRecover.includes("active"), "Legitimate replacement subscription restored active status");
    assert.ok(coStateRecover.includes("fleet_complete"), "Company plan updated to fleet_complete");
    console.log("PASS: Step 7c - Replacement subscription cleanly recovered past_due tenant to active.");

    // ---------------------------------------------------------------------------
    // Step 7d: Successful Paid Invoice on Current Active Subscription
    // ---------------------------------------------------------------------------
    console.log("Step 7d: Verifying successful paid invoice on current subscription applies cleanly...");
    session1.execute(`SELECT public.pooldocai_claim_stripe_webhook_event('${testEventInvPaid}', 'invoice.payment_succeeded', 60, 5);`);
    const claimPaid = JSON.parse(await session1.waitForOutput());
    assert.equal(claimPaid.status, "claimed");

    session1.execute(`
      SELECT public.pooldocai_apply_and_finalize_stripe_webhook(
        '${testEventInvPaid}',
        '${claimPaid.claim_token}',
        '${testCompanyId}'::uuid,
        '{"billing_status": "active"}'::jsonb,
        '{"event_type": "stripe_invoice.payment_succeeded", "units": 1}'::jsonb,
        NULL,
        false,
        '{"subscription_id": "${testSubIdC}", "period_start": "2026-04-01T00:00:00Z", "event_type": "invoice.payment_succeeded"}'::jsonb
      );
    `);
    const applyPaid = JSON.parse(await session1.waitForOutput());
    assert.equal(applyPaid.success, true);
    assert.equal(applyPaid.status, "applied");
    console.log("PASS: Step 7d - Paid invoice on current active subscription applied cleanly.");

    console.log("\nALL REAL TWO-CONNECTION POSTGRESQL CONCURRENCY TESTS PASSED SUCCESSFULLY.");
  } finally {
    if (session1) session1.close();
    if (session2) session2.close();

    // Explicit fixture teardown
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
