const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const configPath = path.join(root, "website", "js", "config.js");
const generatorPath = path.join(root, "scripts", "generate-config.cjs");
const robotsPath = path.join(root, "website", "robots.txt");

// Verify files exist
assert.ok(fs.existsSync(configPath), "website/js/config.js must exist");
assert.ok(fs.existsSync(generatorPath), "scripts/generate-config.cjs must exist");

async function runStagingConfigTests() {
  console.log("Starting UI-Only Preview and Strict Staging Isolation Tests...");

  // Backup existing config.js
  const originalConfig = fs.readFileSync(configPath, "utf8");
  const originalRobots = fs.readFileSync(robotsPath, "utf8");

  try {
    // -------------------------------------------------------------------------
    // Test 1: No staging credentials => static UI-only preview, never live backend
    // -------------------------------------------------------------------------
    {
      const env = {
        ...process.env,
        VERCEL_ENV: "preview",
        STAGING_SUPABASE_URL: "",
        STAGING_SUPABASE_ANON_KEY: "",
        NEXT_PUBLIC_SUPABASE_URL: "https://owfeebydlyacssqpnmkq.supabase.co",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "production-public-key-must-be-ignored",
        SUPABASE_URL: ""
      };
      execSync(`node "${generatorPath}"`, { env, stdio: "pipe" });
      const generated = fs.readFileSync(configPath, "utf8");
      assert.ok(generated.includes("previewUiOnly: isUiOnlyPreview"), "Preview config must expose a clear UI-only flag");
      assert.ok(generated.includes("const isUiOnlyPreview = true"), "No staging backend must produce disconnected UI-only mode");
      assert.ok(generated.includes("pooldocai-preview-backend-disabled.invalid"), "UI-only previews must use an inert endpoint");
      assert.ok(!generated.includes("owfeebydlyacssqpnmkq.supabase.co"), "Preview config must not embed live project endpoint");
      assert.ok(!generated.includes("production-public-key-must-be-ignored"), "Generic keys must never be copied into disconnected preview");
      assert.ok(generated.includes("connect-src 'none'; form-action 'none'"), "CSP must forbid all API requests and native form submissions");

      const metas = [];
      const doc = {
        readyState: "loading",
        head: { appendChild: element => { metas.push(element); } },
        querySelector: () => null,
        createElement: tag => ({
          tag, attrs: {}, setAttribute(key, value) { this.attrs[key] = value; }
        }),
        addEventListener() {}
      };
      const win = { location: { hostname: "pooldocai-pr-preview.vercel.app" } };
      const context = vm.createContext({ window: win, document: doc, console, Promise });
      new vm.Script(generated).runInContext(context);
      assert.equal(win.POOLDOCAI_CONFIG.previewUiOnly, true);
      assert.equal(win.POOLDOCAI_CONFIG.isPreviewHost, true);
      assert.ok(metas.some(m => m.attrs["http-equiv"] === "Content-Security-Policy" && m.attrs.content.includes("form-action 'none'")));
      await assert.rejects(() => win.fetch("https://example.com/"), /UI-only preview/, "UI-only preview must block fetch");
      console.log("PASS: Test 1 - Missing staging config creates a viewable but strictly backend-disconnected preview.");
    }

    // -------------------------------------------------------------------------
    // Test 1b: Partial staging credentials still FAIL CLOSED
    // -------------------------------------------------------------------------
    {
      for (const pair of [
        { STAGING_SUPABASE_URL: "https://staging-example.supabase.co", STAGING_SUPABASE_ANON_KEY: "" },
        { STAGING_SUPABASE_URL: "", STAGING_SUPABASE_ANON_KEY: "sb_publishable_staging_only" }
      ]) {
        let threw = false;
        try {
          execSync(`node "${generatorPath}"`, {
            env: { ...process.env, VERCEL_ENV: "preview", ...pair },
            stdio: "pipe"
          });
        } catch (err) {
          threw = true;
          assert.match(String(err.stderr || err.stdout), /Both STAGING_SUPABASE_URL and STAGING_SUPABASE_ANON_KEY/);
        }
        assert.equal(threw, true, "Partially configured staging must fail the build");
      }
      console.log("PASS: Test 1b - Partial staging credentials remain a hard error.");
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

      // 4A: Production Hostname ending in .vercel.app must NOT halt
      {
        const sandboxProd = {
          window: {
            location: { hostname: "pooldocai-secure-foundation.vercel.app" }
          },
          console: {
            error: (msg) => { sandboxProd.lastError = msg; },
            log: () => {},
            warn: () => {}
          }
        };

        const scriptProd = new vm.Script(rawConfigSource);
        const contextProd = vm.createContext(sandboxProd);
        scriptProd.runInContext(contextProd);

        assert.equal(sandboxProd.window.POOLDOCAI_CONFIG.isProductionDomain, true);
        assert.equal(sandboxProd.window.POOLDOCAI_CONFIG.isPreviewHost, false);
        assert.ok(sandboxProd.window.POOLDOCAI_CONFIG.supabaseUrl !== null, "Production hostname must not have supabaseUrl cleared");
        assert.equal(sandboxProd.lastError, undefined, "Production hostname must not trigger security halt");
      }

      // 4B: Preview Hostname ending in .vercel.app MUST halt on production credentials
      {
        const sandboxPreview = {
          window: {
            location: { hostname: "pooldocai-pr-14.vercel.app" }
          },
          console: {
            error: (msg) => { sandboxPreview.lastError = msg; },
            log: () => {},
            warn: () => {}
          }
        };

        const scriptPreview = new vm.Script(rawConfigSource);
        const contextPreview = vm.createContext(sandboxPreview);
        scriptPreview.runInContext(contextPreview);

        assert.equal(sandboxPreview.window.POOLDOCAI_CONFIG.supabaseUrl, null, "Preview host must halt and set supabaseUrl to null if pointing to production");
        assert.equal(sandboxPreview.window.POOLDOCAI_CONFIG.publicAnonKey, null);
        assert.ok(String(sandboxPreview.lastError).includes("SECURITY HALT"), "Must log SECURITY HALT error");
      }

      console.log("PASS: Test 4 - Client runtime defense-in-depth halts execution when preview host has production config, while allowing production .vercel.app.");
    }

  } finally {
    // Restore original config.js
    fs.writeFileSync(configPath, originalConfig, "utf8");
    fs.writeFileSync(robotsPath, originalRobots, "utf8");
  }

  console.log("\nALL SAFE UI-ONLY PREVIEW & STAGING ISOLATION TESTS PASSED.");
}

runStagingConfigTests().catch((err) => {
  console.error("FAIL in staging config tests:", err);
  process.exit(1);
});
