const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const stagingDir = path.join(root, "supabase", "staging");
const migrationsDir = path.join(root, "supabase", "migrations");
const bundlePath = path.join(stagingDir, "00_apply_staging_migrations.sql");
const fixturesPath = path.join(stagingDir, "01_synthetic_staging_fixtures.sql");
const verifyPath = path.join(stagingDir, "02_staging_verification_tests.sql");
const generatorScript = path.join(root, "scripts", "generate-staging-bundle.cjs");

async function runStagingBundleTests() {
  console.log("Starting Staging Migration Bundle & Synthetic Fixtures Tests...");

  // 1. Verify generator script runs cleanly with --check
  {
    console.log("Checking scripts/generate-staging-bundle.cjs with --check...");
    const checkOutput = execSync(`node "${generatorScript}" --check`, { encoding: "utf8" });
    assert.match(checkOutput, /PASS: Staging bundle is in sync/);
    console.log("PASS: Staging bundle generator --check passed.");
  }

  // 2. Validate 00_apply_staging_migrations.sql
  {
    console.log("Validating 00_apply_staging_migrations.sql...");
    assert.ok(fs.existsSync(bundlePath), "Staging bundle must exist");
    const bundleContent = fs.readFileSync(bundlePath, "utf8");

    // Must NOT contain active psql meta-commands (which break Supabase Web SQL Editor)
    assert.ok(!/^\s*\\set\s+/m.test(bundleContent), "Bundle must NOT contain psql \\set commands (breaks Web SQL Editor)");
    assert.ok(!/^\s*\\copy\s+/m.test(bundleContent), "Bundle must NOT contain psql \\copy commands");

    // Must count all migrations in supabase/migrations/
    const migrationFiles = fs.readdirSync(migrationsDir).filter(f => f.endsWith(".sql")).sort();
    assert.ok(bundleContent.includes(`Total Migrations: ${migrationFiles.length}`), `Header must state Total Migrations: ${migrationFiles.length}`);

    // Must contain markers for each migration
    migrationFiles.forEach((file, idx) => {
      assert.ok(
        bundleContent.includes(`Migration ${idx + 1}/${migrationFiles.length}: ${file}`),
        `Bundle must contain header marker for ${file}`
      );
    });

    // Verify key migration contents are included
    assert.ok(bundleContent.includes("pooldocai_check_manual_duplicate"), "Bundle must include migration 045 duplicate guard RPC");
    assert.ok(bundleContent.includes("search_company_manual_chunks_hybrid"), "Bundle must include hybrid search function");
    assert.ok(bundleContent.includes("diagnostic_cases"), "Bundle must include migration 001 diagnostic_cases");

    console.log(`PASS: Staging migration bundle verified (${migrationFiles.length} migrations, zero psql meta-commands).`);
  }

  // 3. Validate 01_synthetic_staging_fixtures.sql
  {
    console.log("Validating 01_synthetic_staging_fixtures.sql...");
    assert.ok(fs.existsSync(fixturesPath), "Fixtures file must exist");
    const fixturesContent = fs.readFileSync(fixturesPath, "utf8");

    // Zero psql meta-commands
    assert.ok(!fixturesContent.includes("\\set "), "Fixtures must NOT contain psql \\set commands");

    // Valid bcrypt hashing via pgcrypto crypt()
    assert.ok(fixturesContent.includes("crypt('PoolDocStaging2026!', gen_salt('bf', 10))"), "Must generate authentic bcrypt hash via pgcrypto");
    assert.ok(!fixturesContent.includes("$2a$10$wT8K4cQZq7N9.fJ6dC5hkeFz7b4q0A3c6a4f2b1d0e9c8a7b6c5d"), "Must NOT contain old truncated 40-char fake bcrypt hash");

    // Must seed auth.identities
    assert.ok(fixturesContent.includes("auth.identities"), "Must seed auth.identities for GoTrue signInWithPassword");
    assert.ok(fixturesContent.includes("staging_admin_aquapure@pooldocai.test"), "Must seed AquaPure admin user");
    assert.ok(fixturesContent.includes("staging_tech_aquapure@pooldocai.test"), "Must seed AquaPure tech user");
    assert.ok(fixturesContent.includes("staging_admin_bluewave@pooldocai.test"), "Must seed BlueWave admin user");
    assert.ok(fixturesContent.includes("staging_tech_bluewave@pooldocai.test"), "Must seed BlueWave tech user");

    // Must sanitize push subscription endpoints
    assert.ok(fixturesContent.includes("https://push.staging.pooldocai.test"), "Push endpoints must use safe non-routable test domain");
    assert.ok(!fixturesContent.includes("https://fcm.googleapis.com"), "Push endpoints must NOT point to real FCM domain in synthetic fixtures");

    console.log("PASS: Synthetic staging fixtures verified (GoTrue identities, authentic bcrypt, sanitized push).");
  }

  // 4. Validate 02_staging_verification_tests.sql
  {
    console.log("Validating 02_staging_verification_tests.sql...");
    assert.ok(fs.existsSync(verifyPath), "Verification file must exist");
    const verifyContent = fs.readFileSync(verifyPath, "utf8");

    // Zero psql meta-commands
    assert.ok(!verifyContent.includes("\\set "), "Verification tests must NOT contain psql \\set commands");

    // Must check core tables and RLS
    assert.ok(verifyContent.includes("Missing core schema tables in staging"), "Must check 12 core tables");
    assert.ok(verifyContent.includes("relrowsecurity = false"), "Must verify 100% RLS enforcement");

    // Must check all required security RPCs
    assert.ok(verifyContent.includes("pooldocai_register_push_subscription"), "Must verify register_push_subscription RPC");
    assert.ok(verifyContent.includes("pooldocai_claim_push_delivery_batch"), "Must verify claim_push_delivery_batch RPC");
    assert.ok(verifyContent.includes("pooldocai_claim_email_delivery_batch"), "Must verify claim_email_delivery_batch RPC");
    assert.ok(verifyContent.includes("pooldocai_check_manual_duplicate"), "Must verify check_manual_duplicate RPC");
    assert.ok(verifyContent.includes("search_company_manual_chunks_hybrid"), "Must verify search_company_manual_chunks_hybrid RPC");

    // Must verify active RLS enforcement and non-superuser authenticated role
    assert.ok(verifyContent.includes("current_user <> 'authenticated'"), "Must assert current_user is authenticated");
    assert.ok(verifyContent.includes("row_security_active('public.service_requests'::regclass)"), "Must assert row_security_active on service_requests");
    assert.ok(verifyContent.includes("row_security_active('public.user_push_subscriptions'::regclass)"), "Must assert row_security_active on user_push_subscriptions");
    assert.ok(verifyContent.includes("SET LOCAL ROLE anon"), "Must include negative control testing anonymous role denial");

    // Must verify bidirectional tenant isolation
    assert.ok(verifyContent.includes("AquaPure tech can read BlueWave service requests"), "Must verify AquaPure cannot read BlueWave requests");
    assert.ok(verifyContent.includes("BlueWave tech can read AquaPure service requests"), "Must verify BlueWave cannot read AquaPure requests");
    assert.ok(verifyContent.includes("AquaPure tech can read BlueWave push subscriptions"), "Must verify push subscription tenant isolation");

    console.log("PASS: Staging verification test suite verified (schema, RLS, RPCs, active role enforcement, negative control, bidirectional isolation).");
  }

  console.log("\n=== ALL STAGING BUNDLE & FIXTURE TESTS PASSED ===");
}

runStagingBundleTests().catch(err => {
  console.error("FAIL:", err);
  process.exit(1);
});
