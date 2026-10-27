import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { createCMS } from "../server.mjs";
import { passwordHash, uid, now, revision } from "../src/store.mjs";
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import sharp from "sharp";
const dir = mkdtempSync(join(tmpdir(), "pooldoc-ui-")),
  origin = "http://127.0.0.1:4198";
const cms = createCMS({
  dbPath: join(dir, "cms.sqlite"),
  mediaPath: join(dir, "media"),
  origin,
});
const owner = uid();
cms.db
  .prepare("INSERT INTO users VALUES(?,?,?,?,1)")
  .run(
    owner,
    "owner@example.test",
    passwordHash("browser-local-test-password-2026"),
    "owner",
  );
for (const d of JSON.parse(
  readFileSync(
    new URL("../examples/existing-resources.json", import.meta.url),
    "utf8",
  ),
)) {
  const id = uid(),
    time = now();
  cms.db
    .prepare(
      "INSERT INTO articles(id,slug,status,data,published,version,created_at,updated_at) VALUES(?,?,'published',?,?,1,?,?)",
    )
    .run(id, d.slug, JSON.stringify(d), JSON.stringify(d), time, time);
  revision(
    cms.db,
    cms.db.prepare("SELECT * FROM articles WHERE id=?").get(id),
    owner,
    "Initial isolated import",
  );
}
await new Promise((r) => cms.server.listen(4198, "127.0.0.1", r));
mkdirSync("evidence/screenshots", { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CMS_CHROMIUM
    ? { executablePath: process.env.CMS_CHROMIUM }
    : {}),
  args: ["--no-sandbox", "--disable-gpu", "--disable-software-rasterizer"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const errors = [],
  results = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => {
  if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text());
});
async function selectPage(name) {
  if (await page.locator("#mobile-menu").isVisible() && !(await page.locator("#cms-sidebar").evaluate(el => el.classList.contains("nav-open")))) await page.locator("#mobile-menu").click();
  await page.locator(`[data-page="${name}"]`).click();
}
const check = (name, details = {}) => {
  results.push({ name, passed: true, ...details });
  console.log("PASS", name);
};
try {
  await page.goto(origin + "/admin/");
  assert.equal(new URL(page.url()).pathname, "/admin/login");
  await page.getByLabel("Email address").fill("owner@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("browser-local-test-password-2026");
  await page.getByRole("button", { name: "Sign in securely" }).click();
  await page
    .getByRole("heading", { name: "A little knowledge. A lot of clarity." })
    .waitFor();
  check("Real browser login and private dashboard");
  await page.screenshot({
    path: "evidence/screenshots/dashboard-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "New article" }).click();
  await page
    .getByLabel("Article title", { exact: true })
    .fill("Browser verified safe pool guide");
  await page.getByRole("button", { name: "Create private draft" }).click();
  await page.getByRole("heading", { name: "Make knowledge useful." }).waitFor();
  await page
    .getByLabel("Summary", { exact: true })
    .fill("A useful guide created through real browser controls.");
  await page
    .getByRole("textbox", { name: "Article content" })
    .fill("Observe the controller safely without opening any covers.");
  await page
    .getByLabel("SEO title", { exact: true })
    .fill("Safe pool checks from your controller");
  await page
    .getByLabel("Meta description", { exact: true })
    .fill(
      "Learn to observe your pool controller safely before asking a qualified professional for help.",
    );
  await page.getByText("Sources & citations", { exact: true }).click();
  await page
    .getByLabel("Source references")
    .fill("Pentair original manual | https://www.pentair.com/manual.pdf");
  await page.getByText(/All changes saved ·/).waitFor({ timeout: 15000 });
  check("Create article, rich editor input and real autosave");
  await page.reload();
  await selectPage("library");
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await page.getByLabel("Article title", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Article title", { exact: true }).inputValue(),
    "Browser verified safe pool guide",
  );
  check("Autosaved draft survives browser reload");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page
    .frameLocator("#preview-frame")
    .getByRole("heading", {
      name: "Browser verified safe pool guide",
      exact: true,
    })
    .waitFor();
  await page.getByRole("button", { name: "Mobile · 320px" }).click();
  assert.equal(
    await page
      .locator("#preview-frame")
      .evaluate((e) => Math.round(e.getBoundingClientRect().width)),
    320,
  );
  check("Authenticated desktop/mobile article preview");
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page
    .getByRole("button", { name: "Submit for Editorial Review", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Approve for Publication", exact: true })
    .click();
  await page.getByText("approve completed", { exact: true }).waitFor();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByText("publish completed", { exact: true }).waitFor();
  check("Real browser editorial submission, approval and publication");
  let current = cms.db
    .prepare(
      "SELECT * FROM articles WHERE slug='browser-verified-safe-pool-guide'",
    )
    .get();
  assert.equal(current.status, "published");
  assert.equal(
    cms.db
      .prepare("SELECT * FROM knowledge_reviews WHERE article_id=?")
      .get(current.id),
    undefined,
  );
  await page
    .getByRole("button", { name: "Submit for Knowledge Review", exact: true })
    .click();
  await page.getByText("knowledge submit completed", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Approve for Knowledge Base", exact: true })
    .click();
  await page
    .getByLabel("Evidence excerpt")
    .fill("The source describes non-invasive controller observations.");
  await page
    .getByRole("button", {
      name: "Approve this revision for Knowledge Base",
      exact: true,
    })
    .click();
  await page
    .getByText("Knowledge eligibility approved. Indexing remains disconnected.")
    .waitFor();
  assert.equal(
    cms.db
      .prepare("SELECT status FROM knowledge_reviews WHERE article_id=?")
      .get(current.id).status,
    "approved",
  );
  check("Separate knowledge review and functional approval form");
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Revoke Knowledge Approval", exact: true })
    .click();
  await page.getByText("knowledge revoke completed", { exact: true }).waitFor();
  assert.equal(
    cms.db
      .prepare("SELECT status FROM knowledge_reviews WHERE article_id=?")
      .get(current.id).status,
    "revoked",
  );
  check("Knowledge revocation through real UI");
  await page.screenshot({
    path: "evidence/screenshots/editor-desktop.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "View Revision History", exact: true })
    .click();
  await page.getByRole("heading", { name: "Revision history" }).waitFor();
  page.once("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Restore Version", exact: true })
    .last()
    .click();
  await page
    .getByText("Revision restored as draft; knowledge approval remains revoked")
    .waitFor();
  check("Revision restore through UI creates draft");
  await page.getByRole("button", { name: "Media library" }).click();
  const uploadImage = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#31a6a6" } }).png().toBuffer();
  await page
    .locator("#upload-file")
    .setInputFiles({
      name: "equipment-pad.png",
      mimeType: "image/png",
      buffer: uploadImage,
    });
  await page
    .getByRole("button", { name: "Upload securely", exact: true })
    .click();
  await page.getByText("File validated and saved").waitFor();
  await page
    .getByRole("heading", { name: "equipment-pad.png", exact: true })
    .waitFor();
  check("Browser file upload and media library rendering");
  await page.getByRole("button", { name: "Categories & tags" }).click();
  await page
    .getByRole("heading", { name: "Primary categories", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Add", exact: false }).first().click();
  await page.getByLabel("Name", { exact: true }).fill("Browser test category");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByText("Browser test category", { exact: true }).waitFor();
  check("Create category through real UI");
  await selectPage("library");
  await page.getByRole("button", { name: "Import draft", exact: true }).click();
  await page
    .getByLabel("Or paste compatible JSON")
    .fill(
      JSON.stringify({
        format: "pooldocai-resource-v1",
        article: {
          title: "Imported browser draft",
          slug: "browser-import-draft",
          categoryId: "category-1",
          body: "<p>Draft content</p>",
        },
      }),
    );
  await page
    .getByRole("button", { name: "Validate and create draft", exact: true })
    .click();
  await page.getByLabel("Article title", { exact: true }).waitFor();
  assert.equal(
    await page.getByLabel("Article title", { exact: true }).inputValue(),
    "Imported browser draft",
  );
  check("Functional LLM draft import through UI");
  for (const width of [320, 360, 390, 430, 768, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const view of [
      "dashboard",
      "library",
      "editor",
      "taxonomy",
      "media",
      "seo",
      "knowledge",
      "settings",
      "hub",
      "article",
    ]) {
      if (view === "editor") {
        await page.goto(origin + "/admin/");
        await selectPage("library");
        await page
          .getByRole("button", { name: "Edit", exact: true })
          .first()
          .click();
        await page.getByLabel("Article title", { exact: true }).waitFor();
      } else if (view === "hub") {
        await page.goto(origin + "/resources/");
        await page.getByRole("heading", { name: /Clearer water/ }).waitFor();
      } else if (view === "article") {
        await page.goto(origin + "/resources/pool-pump-wont-start/");
      } else {
        if (!page.url().includes("/admin")) await page.goto(origin + "/admin/");
        await selectPage(view);
        await page.waitForTimeout(120);
      }
      if (width === 390 || width === 1440) {
        const a11y = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze();
        results.push({
          name: "Automated accessibility",
          width,
          view,
          violations: a11y.violations,
          passed: a11y.violations.length === 0,
        });
        assert.equal(
          a11y.violations.length,
          0,
          `${width}px ${view} accessibility: ` +
            a11y.violations
              .map((v) => v.id + ": " + v.nodes.map((n) => n.target).join(","))
              .join("; "),
        );
      }
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      );
      assert.equal(
        overflow,
        false,
        `Horizontal page overflow at ${width}px in ${view}`,
      );
      if (
        (width === 1440 && ["library", "hub"].includes(view)) ||
        (width === 390 &&
          ["dashboard", "library", "editor", "hub"].includes(view))
      )
        await page.screenshot({
          path: `evidence/screenshots/${view}-${width}.png`,
          fullPage: true,
        });
      results.push({
        name: "Responsive horizontal overflow",
        width,
        view,
        passed: true,
      });
    }
  }
  check("Responsive checks at all eight widths across ten surfaces");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + "/admin/");
  await page.getByRole("heading", { name: /A little knowledge/ }).waitFor();
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => ({
    tag: document.activeElement.tagName,
    outline: getComputedStyle(document.activeElement).outlineStyle,
  }));
  assert.notEqual(focused.tag, "BODY");
  assert.notEqual(focused.outline, "none");
  check("Keyboard focus is visible");
  // Mock external services: no real leads, emails or analytics events are sent.
  let formSubmission = null;
  await context.route("https://formspree.io/**", (route) => {
    formSubmission = route.request().postData();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: '{"ok":true}',
    });
  });
  await context.route(
    /https:\/\/(www\.googletagmanager\.com|connect\.facebook\.net|www\.google-analytics\.com|www\.facebook\.com).*/,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: "",
      }),
  );
  await page.goto(origin + "/");
  assert.equal(
    await page.locator("form").getAttribute("action"),
    "https://formspree.io/f/mrpppgkw",
  );
  await page
    .getByRole("button", { name: /Decline|Reject|Essential only/i })
    .first()
    .click()
    .catch(() => {});
  const consent = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("pooldocai_consent_v1") || "null"),
  );
  assert.equal(consent?.analytics, false);
  assert.equal(consent?.advertising, false);
  await page.locator("#name").fill("Isolated CMS Test");
  await page.locator("#email").fill("local-test@example.invalid");
  await page.locator("#role").selectOption({ index: 1 });
  await page.locator("button.submit").click();
  await page
    .locator("#status")
    .filter({ hasText: "You’re on the waitlist." })
    .waitFor();
  assert.ok(formSubmission.includes("analytics_consent_at_submit"));
  assert.ok(formSubmission.includes("advertising_consent_at_submit"));
  check(
    "Existing waitlist endpoint, real form interaction and consent opt-out; external delivery mocked",
  );
  assert.deepEqual(errors, []);
  check("No unexpected browser-console or runtime errors");
  writeFileSync(
    "evidence/browser-results.json",
    JSON.stringify(
      {
        results,
        errors,
        mocked: ["Formspree delivery", "GA4/Meta external scripts"],
        environment:
          "Real Chromium against real local Node/SQLite server; not Supabase",
      },
      null,
      2,
    ),
  );
} catch (e) {
  await page.screenshot({
    path: "evidence/screenshots/browser-failure.png",
    fullPage: true,
  });
  writeFileSync(
    "evidence/browser-results.json",
    JSON.stringify({ results, errors, failure: e.stack }, null, 2),
  );
  throw e;
} finally {
  await browser.close();
  await new Promise((r) => cms.server.close(r));
  rmSync(dir, { recursive: true, force: true });
}
