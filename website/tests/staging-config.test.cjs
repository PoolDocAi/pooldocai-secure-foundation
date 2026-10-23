const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const configPath = path.join(root, "website", "js", "config.js");
const generatorPath = path.join(root, "scripts", "generate-config.cjs");

// Verify files exist
assert.ok(fs.existsSync(configPath), "website/js/config.js must exist");
assert.ok(fs.existsSync(generatorPath), "scripts/generate-config.cjs must exist");

async function runStagingConfigTests() {
  console.log("Starting Staging Configuration and Fail-Closed Preview Tests...");

  // Backup existing config.js
  const originalConfig = fs.readFileSync(configPath, "utf8");

  try {
    // -------------------------------------------------------------------------
    // Test 1: Vercel Preview Build Fails Closed When Staging Credentials Missing
    // -------------------------------------------------------------------------
    {
      let threw = false;
      try {
        execSync(`node "${generatorPath}"`, {
          env: {
            ...process.env,
            VERCEL_ENV: "preview",
            STAGING_SUPABASE_URL: "",
            STAGING_SUPABASE_ANON_KEY: "",
            NEXT_PUBLIC_SUPABASE_URL: "",
            SUPABASE_URL: ""
          },
          stdio: "pipe"
        });
      } catch (err) {
        threw = true;
        const output = String(err.stderr || err.stdout || "");
        assert.ok(
          output.includes("requires STAGING_SUPABASE_URL and STAGING_SUPABASE_ANON_KEY") ||
          output.includes("Build aborted"),
          "Error output must clearly state required staging variables"
        );
      }
      assert.equal(threw, true, "generate-config.cjs must throw when staging credentials are missing in preview");
      console.log("PASS: Test 1 - Preview build fails closed when staging configuration is missing.");
    }

    // -------------------------------------------------------------------------
    // Test 2: Vercel Preview Build Fails Closed When Pointed at Production URL
    // -------------------------------------------------------------------------
    {
      let threw = false;
      try {
        execSync(`node "${generatorPath}"`, {
          env: {
            ...process.env,
            VERCEL_ENV: "preview",
            STAGING_SUPABASE_URL: "https://owfeebydlyacssqpnmkq.supabase.co", // Production URL!
            STAGING_SUPABASE_ANON_KEY: "sb_publishable_some_key"
          },
          stdio: "pipe"
        });
      } catch (err) {
        threw = true;
        const output = String(err.stderr || err.stdout || "");
        assert.ok(
          output.includes("FATAL SECURITY VIOLATION") && output.includes("owfeebydlyacssqpnmkq"),
          "Error output must highlight production database protection"
        );
      }
      assert.equal(threw, true, "generate-config.cjs must reject production URL during preview builds");
      console.log("PASS: Test 2 - Preview build strictly rejects production Supabase URL.");
    }

    // -------------------------------------------------------------------------
    // Test 3: Vercel Preview Build Generates Valid Config with Dedicated Staging Credentials
    // -------------------------------------------------------------------------
    {
      execSync(`node "${generatorPath}"`, {
        env: {
          ...process.env,
          VERCEL_ENV: "preview",
          STAGING_SUPABASE_URL: "https://pooldocai-staging-test.supabase.co",
          STAGING_SUPABASE_ANON_KEY: "sb_publishable_staging_verified_12345"
        },
        stdio: "pipe"
      });

      const generated = fs.readFileSync(configPath, "utf8");
      assert.ok(generated.includes("https://pooldocai-staging-test.supabase.co"));
      assert.ok(generated.includes("sb_publishable_staging_verified_12345"));
      assert.ok(!generated.includes("owfeebydlyacssqpnmkq"));
      console.log("PASS: Test 3 - Preview build successfully emits isolated staging config.");
    }

    // -------------------------------------------------------------------------
    // Test 4: Client-Side Runtime Defense-in-Depth Fails Closed on Preview Host
    // -------------------------------------------------------------------------
    {
      const rawConfigSource = originalConfig;

      // Simulate browser environment on a vercel preview host
      const sandbox = {
        window: {
          location: { hostname: "pooldocai-pr-14.vercel.app" }
        },
        console: {
          error: (msg) => { sandbox.lastError = msg; },
          log: () => {},
          warn: () => {}
        }
      };

      const script = new vm.Script(rawConfigSource);
      const context = vm.createContext(sandbox);
      script.runInContext(context);

      assert.equal(sandbox.window.POOLDOCAI_CONFIG.supabaseUrl, null, "Preview host must halt and set supabaseUrl to null if pointing to production");
      assert.equal(sandbox.window.POOLDOCAI_CONFIG.publicAnonKey, null);
      assert.ok(String(sandbox.lastError).includes("SECURITY HALT"), "Must log SECURITY HALT error");
      console.log("PASS: Test 4 - Client runtime defense-in-depth halts execution when preview host has production config.");
    }

  } finally {
    // Restore original config.js
    fs.writeFileSync(configPath, originalConfig, "utf8");
  }

  console.log("\nALL STAGING CONFIGURATION & PREVIEW FAIL-CLOSED TESTS PASSED.");
}

runStagingConfigTests().catch((err) => {
  console.error("FAIL in staging config tests:", err);
  process.exit(1);
});
