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

    // Unguessable CSPRNG bcrypt hashing via pgcrypto crypt(gen_random_bytes)
    assert.ok(fixturesContent.includes("crypt(encode(gen_random_bytes(24), 'base64'), gen_salt('bf', 10))"), "Must generate unguessable bcrypt hash via pgcrypto gen_random_bytes");
    assert.ok(!fixturesContent.includes("PoolDocStaging2026!"), "Must NOT contain hardcoded static seed password 'PoolDocStaging2026!'");
    assert.ok(!fixturesContent.includes("$2a$10$wT8K4cQZq7N9.fJ6dC5hkeFz7b4q0A3c6a4f2b1d0e9c8a7b6c5d"), "Must NOT contain old truncated 40-char fake bcrypt hash");

    // Must seed auth.identities
    assert.ok(fixturesContent.includes("auth.identities"), "Must seed auth.identities for GoTrue signInWithPassword");
    assert.ok(fixturesContent.includes("staging_admin_aquapure@pooldocai.test"), "Must seed AquaPure admin user");
    assert.ok(fixturesContent.includes("staging_tech_aquapure@pooldocai.test"), "Must seed AquaPure tech user");
    assert.ok(fixturesContent.includes("staging_admin_bluewave@pooldocai.test"), "Must seed BlueWave admin user");
    assert.ok(fixturesContent.includes("staging_tech_bluewave@pooldocai.test"), "Must seed BlueWave tech user");

    // Must normalize token columns to empty strings for GoTrue compatibility (prevent HTTP 500 scanner error)
    assert.ok(fixturesContent.includes("email_change,"), "Must initialize email_change");
    assert.ok(fixturesContent.includes("email_change_token_new,"), "Must initialize email_change_token_new");
    assert.ok(fixturesContent.includes("recovery_token"), "Must initialize recovery_token");

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

  // 5. Validate scripts/rotate_staging_synthetic_passwords.ps1
  {
    console.log("Validating scripts/rotate_staging_synthetic_passwords.ps1...");
    const rotationScriptPath = path.join(root, "scripts", "rotate_staging_synthetic_passwords.ps1");
    assert.ok(fs.existsSync(rotationScriptPath), "Rotation script must exist");
    const scriptContent = fs.readFileSync(rotationScriptPath, "utf8");

    // Non-browser User-Agent to prevent Supabase 401 browser-block on sb_secret_ keys
    assert.match(
      scriptContent,
      /\$cliUserAgent\s*=\s*"PoolDocAI-Staging-Admin-CLI\/1\.0"/,
      "Must define explicit non-browser User-Agent PoolDocAI-Staging-Admin-CLI/1.0"
    );

    // All Invoke-RestMethod calls must include -UserAgent $cliUserAgent
    const irmCalls = scriptContent.match(/Invoke-RestMethod[^\r\n]+/g) || [];
    assert.ok(irmCalls.length >= 5, "Must contain at least 5 Invoke-RestMethod calls");
    for (const call of irmCalls) {
      assert.ok(
        call.includes("-UserAgent $cliUserAgent"),
        `Invoke-RestMethod call missing -UserAgent: ${call}`
      );
      assert.ok(
        call.includes("-MaximumRedirection 0"),
        `Invoke-RestMethod call missing -MaximumRedirection 0: ${call}`
      );
    }

    // JWT role claim parser for pre-network validation
    assert.ok(
      scriptContent.includes("function Get-JwtPayloadRole"),
      "Must include Get-JwtPayloadRole for nonsecret pre-network credential validation"
    );

    // Sanitized API error reporter
    assert.ok(
      scriptContent.includes("function Write-SanitizedApiError"),
      "Must include Write-SanitizedApiError for safe diagnostic reporting without secret leaks"
    );

    // Fail-closed checks for invalid credential types
    assert.ok(
      scriptContent.includes("sb_publishable_"),
      "Must inspect and reject sb_publishable_ keys in admin prompt"
    );
    assert.ok(
      scriptContent.includes("Received an anon JWT"),
      "Must inspect and reject anon JWTs in admin prompt"
    );
    assert.ok(
      scriptContent.includes("Never use administrative secret keys for client operations"),
      "Must inspect and reject sb_secret_ keys in publishable prompt"
    );

    // Host & safety boundaries
    assert.ok(
      scriptContent.includes("rzkgmvyyeclrpomrlyft.supabase.co"),
      "Must strictly target staging project rzkgmvyyeclrpomrlyft.supabase.co"
    );
    assert.ok(
      scriptContent.includes("owfeebydlyacssqpnmkq"),
      "Must strictly reject production project owfeebydlyacssqpnmkq"
    );
    assert.ok(
      scriptContent.includes("-DryRun"),
      "Must support explicit -DryRun switch for zero-mutation preflight"
    );

    console.log("PASS: Rotation utility verified (non-browser UA, fail-closed credential checks, sanitized 401 diagnostics, safety guards).");
  }

  // 6. Validate 03_synthetic_diagnostic_and_job_fixtures.sql and 04_teardown_diagnostic_and_job_fixtures.sql
  {
    console.log("Validating synthetic diagnostic & job fixture scripts (03 & 04)...");
    const fixtures03Path = path.join(stagingDir, "03_synthetic_diagnostic_and_job_fixtures.sql");
    const fixtures04Path = path.join(stagingDir, "04_teardown_diagnostic_and_job_fixtures.sql");
    assert.ok(fs.existsSync(fixtures03Path), "03 fixture script must exist");
    assert.ok(fs.existsSync(fixtures04Path), "04 teardown script must exist");

    const content03 = fs.readFileSync(fixtures03Path, "utf8");
    const content04 = fs.readFileSync(fixtures04Path, "utf8");

    assert.ok(content03.includes("diagnostic_cases"), "03 must insert diagnostic_cases");
    assert.ok(content03.includes("technician_job_records"), "03 must insert technician_job_records");
    assert.ok(content03.includes("tenant_id"), "03 must align with tenant_id schema column");

    assert.ok(content04.includes("DELETE FROM public.diagnostic_cases"), "04 must delete diagnostic_cases fixtures");
    assert.ok(content04.includes("DELETE FROM public.technician_job_records"), "04 must delete technician_job_records fixtures");

    console.log("PASS: Synthetic diagnostic and job fixtures & teardown scripts verified.");
  }

  // 7. Validate 05_precheck_auth_users_repair.sql, 06_repair_auth_users_null_tokens.sql, and 07_postcheck_auth_users_repair.sql
  {
    console.log("Validating transactional Auth data repair scripts (05, 06 & 07)...");
    const precheckPath = path.join(stagingDir, "05_precheck_auth_users_repair.sql");
    const repairPath = path.join(stagingDir, "06_repair_auth_users_null_tokens.sql");
    const postcheckPath = path.join(stagingDir, "07_postcheck_auth_users_repair.sql");

    assert.ok(fs.existsSync(precheckPath), "05 precheck script must exist");
    assert.ok(fs.existsSync(repairPath), "06 repair script must exist");
    assert.ok(fs.existsSync(postcheckPath), "07 postcheck script must exist");

    const precheckContent = fs.readFileSync(precheckPath, "utf8");
    const repairContent = fs.readFileSync(repairPath, "utf8");
    const postcheckContent = fs.readFileSync(postcheckPath, "utf8");

    // Precheck: read-only
    assert.ok(!repairPath.includes("UPDATE public.") && !precheckContent.includes("UPDATE auth.users"), "05 precheck must be strictly read-only");
    assert.ok(precheckContent.includes("email_change IS NULL"), "05 must audit NULL email_change");

    // Repair: bounded allowlist, transaction with rollback
    assert.ok(repairContent.includes("COALESCE(email_change, '')"), "06 must coalesce email_change");
    assert.ok(repairContent.includes("COALESCE(email_change_token_new, '')"), "06 must coalesce email_change_token_new");
    assert.ok(repairContent.includes("COALESCE(recovery_token, '')"), "06 must coalesce recovery_token");
    assert.ok(repairContent.includes("v_updated_rows <> 4"), "06 must abort and rollback if row count is not exactly 4");
    assert.ok(repairContent.includes("id = ANY(v_target_ids)"), "06 must restrict updates strictly to target allowlist");

    // Postcheck: read-only verification
    assert.ok(!postcheckContent.includes("UPDATE auth.users"), "07 postcheck must be strictly read-only");
    assert.ok(postcheckContent.includes("Zero synthetic users have NULL token columns"), "07 must assert zero NULLs");

    console.log("PASS: Transactional Auth data repair scripts (05 precheck, 06 repair, 07 postcheck) verified.");
  }

  console.log("\n=== ALL STAGING BUNDLE & FIXTURE TESTS PASSED ===");
}

runStagingBundleTests().catch(err => {
  console.error("FAIL:", err);
  process.exit(1);
});
