import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { reconcileApprovedResources } from "../src/approved-content.mjs";
import { audit, now, openStore, passwordHash, revision, seedTaxonomy } from "../src/store.mjs";

const root = new URL("../", import.meta.url);
const load = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "pooldoc-approved-"));
  const db = openStore(join(directory, "cms.sqlite"));
  seedTaxonomy(db);
  const owner = randomUUID();
  db.prepare("INSERT INTO users VALUES(?,?,?,?,1)").run(owner, "owner@example.test", passwordHash("approved-content-test-password"), "owner");
  const snapshots = load("source-archive/approved-resources-2026-10-26/pre-approval-cms-drafts.json");
  for (const entry of snapshots.drafts) {
    const id = randomUUID(), timestamp = now();
    db.prepare("INSERT INTO articles(id,slug,status,data,published,version,created_at,updated_at) VALUES(?,?,'draft',?,NULL,1,?,?)")
      .run(id, entry.article.slug, JSON.stringify(entry.article), timestamp, timestamp);
    revision(db, db.prepare("SELECT * FROM articles WHERE id=?").get(id), owner, "priority_batch_import_draft");
    audit(db, owner, "priority_batch_import_draft", id, entry.editorial);
  }
  const approved = load("examples/approved-content-reconciliation.json");
  reconcileApprovedResources(db, owner, {
    ...approved,
    resources: approved.resources.filter((entry) => ["05", "13", "18"].includes(entry.editorial.resourceId)),
  });
  return { db, owner, directory };
}

test("approved content creates immutable draft revisions without publication or knowledge authorization", () => {
  const { db, owner, directory } = fixture();
  try {
    const batch = load("examples/approved-content-reconciliation.json");
    assert.deepEqual(reconcileApprovedResources(db, owner, batch), {
      created: 1,
      updated: 2,
      skipped: 3,
      slugs: batch.resources.map((entry) => entry.article.slug),
    });
    for (const entry of batch.resources) {
      const row = db.prepare("SELECT * FROM articles WHERE slug=?").get(entry.article.slug);
      assert.equal(row.status, "draft");
      assert.equal(row.published, null);
      assert.equal(row.scheduled_at, null);
      const expectedVersion = entry.editorial.resourceId === "12" ? 1 : 2;
      assert.equal(row.version, expectedVersion);
      assert.equal(db.prepare("SELECT count(*) n FROM revisions WHERE article_id=?").get(row.id).n, expectedVersion);
      assert.equal(db.prepare("SELECT count(*) n FROM knowledge_reviews WHERE article_id=?").get(row.id).n, 0);
      const data = JSON.parse(row.data);
      assert.equal(data.seo.noindex, true);
      assert.equal(data.seo.canonical, `https://pooldocai.com/resources/${entry.article.slug}/`);
      assert.doesNotMatch(data.body, /<script|javascript:/i);
    }
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("approved reconciliation is idempotent and rejects authorization claims", () => {
  const { db, owner, directory } = fixture();
  try {
    const batch = load("examples/approved-content-reconciliation.json");
    reconcileApprovedResources(db, owner, batch);
    assert.deepEqual(reconcileApprovedResources(db, owner, batch), {
      created: 0,
      updated: 0,
      skipped: 6,
      slugs: batch.resources.map((entry) => entry.article.slug),
    });
    const tampered = structuredClone(batch);
    tampered.resources[0].editorial.publicationApproval = true;
    assert.throws(() => reconcileApprovedResources(db, owner, tampered), /Unsafe approved-content state/);
    assert.equal(db.prepare("SELECT sum(version) n FROM articles").get().n, 11);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("approved writing and technical distinctions are retained", () => {
  const batch = load("examples/approved-content-reconciliation.json");
  const byId = Object.fromEntries(batch.resources.map((entry) => [entry.editorial.resourceId, entry]));
  assert.match(byId["05"].article.body, /Fortunately, you can identify most pool equipment/);
  assert.match(byId["05"].article.body, /PHOTO SLOT 1/);
  assert.match(byId["05"].article.body, /INTERNAL LINK: Resource 13 once published/);
  assert.doesNotMatch(byId["05"].article.body, /href="\/resources\/pool-equipment-pre-service-checklist/);
  for (const phrase of [
    "The Customer's Reported Problem",
    "Initial Conditions and Observations",
    "Confirmed Findings Versus Suspected Causes",
    "Work Performed and Parts Used",
    "Post-Service Verification",
  ]) assert.match(byId["18"].article.body, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(byId["18"].article.body, /fictional examples illustrating documentation quality/);
  for (const phrase of [
    "Identifies the Correct Equipment",
    "Uses the Correct Manufacturer Documentation",
    "Provides Sources You Can Actually Verify",
    "Matches Safety Guidance to the Person and Procedure",
    "Separates Possible Causes From Confirmed Findings",
  ]) assert.match(byId["11"].article.body, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(byId["11"].article.body, /PoolDocAI is developing[\s\S]*planned platform is being designed/);
  assert.match(byId["12"].article.body, /technician labor[\s\S]*incremental vehicle expense[\s\S]*administrative labor[\s\S]*additional materials and fees/i);
  assert.match(byId["12"].article.body, /figures are illustrative, not industry averages/i);
  assert.match(byId["12"].article.body, /Opportunity Cost/i);
  assert.equal(byId["17"].article.slug, "pool-diagnostic-workflow");
  assert.doesNotMatch(byId["17"].article.body, /<img/i);
  for (let stage = 1; stage <= 10; stage += 1) assert.match(byId["17"].article.body, new RegExp(`Step ${stage}(?:<|:)`, "i"));
});

test("approved source manuscripts and workflow alternatives remain byte-identical", () => {
  const expected = {
    "Resource_11_Trustworthy_Diagnostic_Answers_approved.md": "9dc917bc3fc81158be0d71a77e022921b60f8bca698cd567e0bdba0398197fa9",
    "Resource_12_Repeated_Pool_Service_Visits_approved.md": "1e041dd3ee5864fc29f1d2a2750cfeea7f133b6aadeb1a28d4e8ca4331b0af38",
    "Resource_17_Diagnostic_Workflow_approved.md": "4076ae3e9b6d3089ad18d52a0b6e5893954b5a40b66ae18bba1a3d70da97a2b4",
    "Resource_17_Diagnostic_Workflow.svg": "01c25f970e2921a5602edc10b9b1cdc13ac80cc7d4d4b244f1aa2ecdd6f5d366",
    "Resource_17_Diagnostic_Workflow.png": "2e651ffe122ff20dd151fc29c86dd281c0735c2ac98d9d3af0a7ce1643a55ce0",
    "Resource_17_Diagnostic_Workflow.pdf": "d1572add3c9a3306d4ebefcde3d619cfde70e867a3f6f54b5e52799c193e05da",
  };
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  for (const [name, hash] of Object.entries(expected)) {
    const source = readFileSync(new URL(`source-archive/approved-resources-2026-10-26/${name}`, root));
    assert.equal(sha256(source), hash, name);
    if (/\.(svg|png|pdf)$/.test(name)) {
      const staged = readFileSync(new URL(`attachments/pending/${name}`, root));
      assert.equal(sha256(staged), hash, `${name} staged copy`);
    }
  }
  const svg = readFileSync(new URL("attachments/pending/Resource_17_Diagnostic_Workflow.svg", root), "utf8");
  assert.match(svg, /<title[^>]*>/i);
  assert.match(svg, /<desc[^>]*>/i);
  assert.doesNotMatch(svg, /<script|on(?:load|error|click)\s*=|<foreignObject|(?:href|src)\s*=\s*["']https?:/i);
});

test("approved PDF remains byte-identical and water-test order is correct", () => {
  const source = readFileSync(new URL("source-archive/approved-resources-2026-10-26/Resource_13_Pre_Service_Checklist_approved.pdf", root));
  const staged = readFileSync(new URL("attachments/pending/Resource_13_Pre_Service_Checklist_approved.pdf", root));
  const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
  assert.equal(sha256(source), "b5daca819553adedcd087732d1a6fab42702add1d2cf52875d48f2f0750ab5d7");
  assert.equal(sha256(staged), sha256(source));
  const extracted = execFileSync("pdftotext", ["-layout", new URL("attachments/pending/Resource_13_Pre_Service_Checklist_approved.pdf", root).pathname, "-"], { encoding: "utf8" });
  const labels = ["Free Chlorine", "Total Chlorine", "pH", "Alkalinity", "Calcium Hardness", "Stabilizer (CYA)", "Salt (if applicable)"];
  let cursor = -1;
  for (const label of labels) {
    const index = extracted.indexOf(label, cursor + 1);
    assert.ok(index > cursor, `${label} must follow the prior water-test field`);
    cursor = index;
  }
  const manifest = load("attachments/pending/manifest.json").attachments[0];
  assert.equal(manifest.uploadEnabled, false);
  assert.equal(manifest.publicUrl, null);
  assert.equal(manifest.state, "staged_validation_blocked");
});

test("Resource 13 HTML transcription preserves the approved water-test order", () => {
  const batch = load("examples/approved-content-reconciliation.json");
  const body = batch.resources.find((entry) => entry.editorial.resourceId === "13").article.body;
  const labels = ["Free Chlorine", "Total Chlorine", "pH", "Alkalinity", "Calcium Hardness", "Stabilizer (CYA)", "Salt, if applicable"];
  let cursor = -1;
  for (const label of labels) {
    const index = body.indexOf(label, cursor + 1);
    assert.ok(index > cursor, `${label} must follow the prior water-test field`);
    cursor = index;
  }
});
