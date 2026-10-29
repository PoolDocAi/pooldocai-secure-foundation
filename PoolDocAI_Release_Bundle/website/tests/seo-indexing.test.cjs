const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { execSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const vercelJsonPath = path.join(root, "vercel.json");
const configPath = path.join(root, "website", "js", "config.js");
const generatorPath = path.join(root, "scripts", "generate-config.cjs");
const robotsPath = path.join(root, "website", "robots.txt");
const sitemapPath = path.join(root, "website", "sitemap.xml");

async function runSeoIndexingTests() {
  console.log("Starting Environment-Specific Indexing & SEO Regression Tests...\n");

  const originalConfig = fs.readFileSync(configPath, "utf8");

  try {
    // ---------------------------------------------------------------------------
    // Test 1: vercel.json Header Routing Inspection
    // ---------------------------------------------------------------------------
    {
      assert.ok(fs.existsSync(vercelJsonPath), "vercel.json must exist");
      const vercelConfig = JSON.parse(fs.readFileSync(vercelJsonPath, "utf8"));
      const headers = vercelConfig.headers || [];

      // Ensure no blanket noindex rule exists
      const blanketNoindex = headers.find((h) => {
        const isBlanketSource = h.source === "/(.*)" || h.source === "/:path*" || h.source === "/*";
        const hasNoindex = (h.headers || []).some(
          (hdr) => hdr.key.toLowerCase() === "x-robots-tag" && hdr.value.toLowerCase().includes("noindex")
        );
        return isBlanketSource && hasNoindex;
      });
      assert.equal(
        blanketNoindex,
        undefined,
        "vercel.json must NOT contain a blanket X-Robots-Tag: noindex header rule affecting marketing pages"
      );

      // Ensure private routes have X-Robots-Tag: noindex and Cache-Control: no-store
      const requiredPrivateRoutes = ["/admin", "/app", "/technician", "/learning-review", "/accept-invite"];
      for (const route of requiredPrivateRoutes) {
        const match = headers.find((h) => h.source.startsWith(route));
        assert.ok(match, `vercel.json must have headers configured for private route ${route}`);
        const hasNoindex = match.headers.some(
          (hdr) => hdr.key.toLowerCase() === "x-robots-tag" && hdr.value.includes("noindex")
        );
        const hasNoStore = match.headers.some(
          (hdr) => hdr.key.toLowerCase() === "cache-control" && hdr.value.includes("no-store")
        );
        assert.ok(hasNoindex, `Route ${route} in vercel.json must set X-Robots-Tag: noindex`);
        assert.ok(hasNoStore, `Route ${route} in vercel.json must set Cache-Control: no-store`);
      }

      console.log("PASS: Test 1 - vercel.json eliminates blanket noindex while enforcing strict noindex on private routes.");
    }

    // ---------------------------------------------------------------------------
    // Test 2: HTML Page Meta Tag Directives (5 Private vs 8 Marketing)
    // ---------------------------------------------------------------------------
    {
      const privatePages = [
        "admin.html",
        "app.html",
        "technician.html",
        "learning-review.html",
        "accept-invite.html"
      ];

      const marketingPages = [
        "index.html",
        "demo.html",
        "pricing.html",
        "how-it-works.html",
        "faq.html",
        "privacy.html",
        "terms.html",
        "waitlist.html"
      ];

      for (const page of privatePages) {
        const content = fs.readFileSync(path.join(root, "website", page), "utf8");
        const match = content.match(/<meta\s+name=["']robots["']\s+content=["']([^"']+)["']/i);
        assert.ok(match, `Private page ${page} must declare a meta robots tag`);
        assert.ok(
          match[1].includes("noindex") && match[1].includes("nofollow"),
          `Private page ${page} must specify content="noindex,nofollow", got: ${match[1]}`
        );
      }

      for (const page of marketingPages) {
        const content = fs.readFileSync(path.join(root, "website", page), "utf8");
        const match = content.match(/<meta\s+name=["']robots["']\s+content=["']([^"']+)["']/i);
        assert.ok(match, `Marketing page ${page} must declare a meta robots tag`);
        assert.ok(
          match[1].includes("index") && match[1].includes("follow") && !match[1].includes("noindex"),
          `Marketing page ${page} must specify index,follow without noindex, got: ${match[1]}`
        );
      }

      console.log("PASS: Test 2 - HTML meta tags correctly isolate 5 private portal pages (noindex) and 8 public marketing pages (index,follow).");
    }

    // ---------------------------------------------------------------------------
    // Test 3: Environment-Specific robots.txt Generation
    // ---------------------------------------------------------------------------
    {
      // A. Preview Build Generation
      execSync(`node "${generatorPath}"`, {
        env: {
          ...process.env,
          VERCEL_ENV: "preview",
          STAGING_SUPABASE_URL: "https://staging-env.supabase.co",
          STAGING_SUPABASE_ANON_KEY: "sb_publishable_staging_key_12345"
        },
        stdio: "pipe"
      });

      const previewRobots = fs.readFileSync(robotsPath, "utf8");
      assert.ok(previewRobots.includes("User-agent: *"), "Preview robots.txt must specify User-agent: *");
      assert.ok(previewRobots.includes("Disallow: /"), "Preview robots.txt must disallow all crawling");
      assert.ok(!previewRobots.includes("Allow: /"), "Preview robots.txt must NOT allow crawling");

      // B. Production Build Generation
      execSync(`node "${generatorPath}"`, {
        env: {
          ...process.env,
          VERCEL_ENV: "production"
        },
        stdio: "pipe"
      });

      const prodRobots = fs.readFileSync(robotsPath, "utf8");
      assert.ok(prodRobots.includes("Allow: /"), "Production robots.txt must allow root");
      assert.ok(prodRobots.includes("Allow: /demo"), "Production robots.txt must allow /demo");
      assert.ok(prodRobots.includes("Allow: /pricing"), "Production robots.txt must allow /pricing");
      assert.ok(prodRobots.includes("Disallow: /admin"), "Production robots.txt must disallow /admin");
      assert.ok(prodRobots.includes("Disallow: /app"), "Production robots.txt must disallow /app");
      assert.ok(prodRobots.includes("Disallow: /technician"), "Production robots.txt must disallow /technician");
      assert.ok(prodRobots.includes("Disallow: /learning-review"), "Production robots.txt must disallow /learning-review");
      assert.ok(prodRobots.includes("Disallow: /accept-invite"), "Production robots.txt must disallow /accept-invite");
      assert.ok(prodRobots.includes("Sitemap: https://pooldocai-secure-foundation.vercel.app/sitemap.xml"), "Production robots.txt must reference sitemap");

      console.log("PASS: Test 3 - Build generator produces environment-specific robots.txt (full disallow on preview, scoped allow on production).");
    }

    // ---------------------------------------------------------------------------
    // Test 4: Hostname Classification (.vercel.app production vs preview domains)
    // ---------------------------------------------------------------------------
    {
      const configSource = originalConfig;

      function evaluateConfigInContext(hostname) {
        const sandbox = {
          window: {
            location: { hostname }
          },
          document: {
            head: {},
            querySelector: () => null,
            createElement: () => ({ setAttribute: () => {} })
          },
          console: {
            error: (msg) => { sandbox.lastError = msg; },
            log: () => {},
            warn: () => {}
          }
        };

        const script = new vm.Script(configSource);
        const context = vm.createContext(sandbox);
        script.runInContext(context);
        return sandbox;
      }

      // 1. Existing Production Hostname ending in .vercel.app
      const prodVercel = evaluateConfigInContext("pooldocai-secure-foundation.vercel.app");
      assert.equal(prodVercel.window.POOLDOCAI_CONFIG.isProductionDomain, true, "pooldocai-secure-foundation.vercel.app must be classified as production domain");
      assert.equal(prodVercel.window.POOLDOCAI_CONFIG.isPreviewHost, false, "pooldocai-secure-foundation.vercel.app must NOT be classified as preview host");
      assert.equal(prodVercel.window.POOLDOCAI_CONFIG.environment, "production");
      assert.ok(prodVercel.window.POOLDOCAI_CONFIG.supabaseUrl !== null, "Production hostname must not have supabaseUrl cleared");
      assert.equal(prodVercel.lastError, undefined, "Production hostname must not trigger security halt");

      // 2. Custom Production Hostnames
      const prodCustom = evaluateConfigInContext("pooldocai.com");
      assert.equal(prodCustom.window.POOLDOCAI_CONFIG.isProductionDomain, true);
      assert.equal(prodCustom.window.POOLDOCAI_CONFIG.isPreviewHost, false);

      // 3. Vercel Preview Deployments (hash or branch slugs)
      const previewDeployment = evaluateConfigInContext("pooldocai-secure-foundation-7042imhsh-bersonjoshua-8595.vercel.app");
      assert.equal(previewDeployment.window.POOLDOCAI_CONFIG.isProductionDomain, false);
      assert.equal(previewDeployment.window.POOLDOCAI_CONFIG.isPreviewHost, true);
      assert.equal(previewDeployment.window.POOLDOCAI_CONFIG.environment, "preview");
      assert.equal(previewDeployment.window.POOLDOCAI_CONFIG.supabaseUrl, null, "Preview host with prod config must halt");
      assert.ok(String(previewDeployment.lastError).includes("SECURITY HALT"));

      // 4. Staging Subdomain
      const stagingHost = evaluateConfigInContext("staging.pooldocai.com");
      assert.equal(stagingHost.window.POOLDOCAI_CONFIG.isProductionDomain, false);
      assert.equal(stagingHost.window.POOLDOCAI_CONFIG.isPreviewHost, true);

      console.log("PASS: Test 4 - Hostname classification correctly distinguishes production .vercel.app from preview/staging domains.");
    }

    // ---------------------------------------------------------------------------
    // Test 5: Client-Side Runtime Defense-in-Depth Enforces Noindex on Preview Hosts
    // ---------------------------------------------------------------------------
    {
      const configSource = originalConfig;

      let createdMetaTag = null;
      const sandbox = {
        window: {
          location: { hostname: "pooldocai-preview-pr-14.vercel.app" }
        },
        document: {
          head: {
            appendChild: (el) => { createdMetaTag = el; }
          },
          querySelector: () => null, // No existing robots tag
          createElement: (tag) => {
            const el = { tag, attributes: {} };
            el.setAttribute = (k, v) => { el.attributes[k] = v; };
            return el;
          }
        },
        console: { error: () => {}, log: () => {} }
      };

      const script = new vm.Script(configSource);
      const context = vm.createContext(sandbox);
      script.runInContext(context);

      assert.ok(createdMetaTag, "Preview host must inject meta robots tag into document");
      assert.equal(createdMetaTag.attributes.name, "robots");
      assert.equal(createdMetaTag.attributes.content, "noindex,nofollow,noarchive");

      console.log("PASS: Test 5 - Client runtime defense-in-depth dynamically enforces noindex on preview hosts.");
    }

    // ---------------------------------------------------------------------------
    // Test 6: Production Sitemap Structure
    // ---------------------------------------------------------------------------
    {
      assert.ok(fs.existsSync(sitemapPath), "sitemap.xml must exist");
      const sitemapContent = fs.readFileSync(sitemapPath, "utf8");

      const expectedUrls = [
        "https://pooldocai-secure-foundation.vercel.app/",
        "https://pooldocai-secure-foundation.vercel.app/demo",
        "https://pooldocai-secure-foundation.vercel.app/pricing",
        "https://pooldocai-secure-foundation.vercel.app/how-it-works",
        "https://pooldocai-secure-foundation.vercel.app/faq",
        "https://pooldocai-secure-foundation.vercel.app/waitlist",
        "https://pooldocai-secure-foundation.vercel.app/privacy",
        "https://pooldocai-secure-foundation.vercel.app/terms"
      ];

      for (const u of expectedUrls) {
        assert.ok(sitemapContent.includes(`<loc>${u}</loc>`), `Sitemap must contain ${u}`);
      }

      // Verify private routes are NOT in sitemap
      assert.ok(!sitemapContent.includes("/admin"), "Sitemap must not expose /admin");
      assert.ok(!sitemapContent.includes("/app"), "Sitemap must not expose /app");
      assert.ok(!sitemapContent.includes("/technician"), "Sitemap must not expose /technician");
      assert.ok(!sitemapContent.includes("/learning-review"), "Sitemap must not expose /learning-review");

      console.log("PASS: Test 6 - Production sitemap contains all public marketing URLs and excludes private routes.");
    }

  } finally {
    fs.writeFileSync(configPath, originalConfig, "utf8");
  }

  console.log("\nALL ENVIRONMENT-SPECIFIC INDEXING & SEO TESTS PASSED.");
}

runSeoIndexingTests().catch((err) => {
  console.error("FAIL in SEO indexing tests:", err);
  process.exit(1);
});
