import test from "node:test";
import assert from "node:assert/strict";
import {
  createPendingMediaProvenance, reviewMediaProvenance,
  isProvenanceComplete, mayUseApprovedMedia, publicMediaMetadata,
} from "../src/production/media-provenance.mjs";

const original = () => ({
  assetId: "550e8400-e29b-41d4-a716-446655440000",
  originalChecksum: "a".repeat(64),
  mediaType: "authentic_photograph",
  sourceType: "pooldocai_original",
  sourceDescription: "Owner photographed an installed residential pump.",
  copyrightHolder: "PoolDocAI",
  licenseEvidenceRef: "private-evidence/owner-upload-2026-10-27",
  scopes: ["website", "social"],
  altText: "Residential pool pump beside a filter on an equipment pad",
  manufacturer: "Pentair",
  model: "IntelliFlo3",
  applicability: "exact_model",
  aiGenerated: false,
  aiEnhanced: false,
  containsPeople: false,
});
const reviewer = { isAuthorizedMediaReviewer: true, reviewerId: "verified-editor-42", now: new Date("2026-10-27T11:00:00Z") };

test("uploader creates only pending records and cannot assign review status", () => {
  const row = createPendingMediaProvenance(original());
  assert.equal(row.status, "pending_review");
  assert.equal(row.approvedBy, null);
  for (const field of ["status","approved","approvedBy","rightsVerified","published"]) {
    assert.throws(() => createPendingMediaProvenance({...original(), [field]: field === "status" ? "approved" : true}), /cannot be supplied/);
  }
});
test("rejects AI-generated and AI-enhanced images", () => {
  assert.throws(() => createPendingMediaProvenance({...original(), aiGenerated: true}), /not permitted/);
  assert.throws(() => createPendingMediaProvenance({...original(), aiEnhanced: true}), /not permitted/);
  assert.throws(() => createPendingMediaProvenance({...original(), aiGenerated: undefined}), /not permitted/);
});
test("does not approve images with unsupported source, scope, model or missing evidence", () => {
  assert.throws(() => createPendingMediaProvenance({...original(), sourceType: "random_internet"}), /Unsupported/);
  assert.throws(() => createPendingMediaProvenance({...original(), scopes: ["website", "unknown"]}), /scopes/);
  assert.throws(() => createPendingMediaProvenance({...original(), model: ""}), /Exact-model/);
  assert.throws(() => createPendingMediaProvenance({...original(), licenseEvidenceRef: ""}), /licenseEvidenceRef/);
  assert.throws(() => createPendingMediaProvenance({...original(), applicability: "representative", model: "", representativeLabel: ""}), /labeled/);
  assert.throws(() => createPendingMediaProvenance({...original(), originalChecksum: "123"}), /checksum/);
});
test("images containing people require a consent evidence reference", () => {
  assert.throws(() => createPendingMediaProvenance({...original(), containsPeople: true}), /consentEvidenceRef/);
  assert.equal(createPendingMediaProvenance({...original(), containsPeople: true, consentEvidenceRef: "private-evidence/consent"}).containsPeople, true);
});
test("untrusted callers cannot approve media or revoke it", () => {
  const pending = createPendingMediaProvenance(original());
  assert.throws(() => reviewMediaProvenance(pending, {action: "approve", note: "Verified"}, {reviewerId: "attacker"}), /permission/);
  assert.throws(() => reviewMediaProvenance(pending, {action: "approve", note: "Verified"}, null), /permission/);
  assert.equal(mayUseApprovedMedia(pending), false);
  assert.equal(publicMediaMetadata(pending), null);
});
test("authorized reviewer approval enables only licensed scopes", () => {
  const pending = createPendingMediaProvenance(original());
  const approved = reviewMediaProvenance(pending, {action: "approve", note: "Original photograph and ownership verified against private evidence"}, reviewer);
  assert.equal(approved.status, "approved");
  assert.equal(mayUseApprovedMedia(approved, "website"), true);
  assert.equal(mayUseApprovedMedia(approved, "social"), true);
  assert.equal(mayUseApprovedMedia(approved, "download"), false);
  const publicValue = publicMediaMetadata(approved);
  assert.equal(publicValue.model, "IntelliFlo3");
  assert.equal(Object.hasOwn(publicValue, "licenseEvidenceRef"), false);
  assert.equal(Object.hasOwn(publicValue, "approvedBy"), false);
  assert.equal(Object.hasOwn(publicValue, "reviewNote"), false);
});
test("expiry and revocation must block public use", () => {
  const row = createPendingMediaProvenance({...original(), expiresOn: "2026-12-31"});
  const approved = reviewMediaProvenance(row, {action: "approve", note: "Evidence checked"}, reviewer);
  assert.equal(isProvenanceComplete(approved, "website", new Date("2026-10-27T11:00:00Z")), true);
  assert.equal(mayUseApprovedMedia(approved, "website", new Date("2027-01-01T00:00:00Z")), false);
  assert.throws(() => reviewMediaProvenance(approved, {action: "approve", note: "Again"}, reviewer), /Only pending/);
  const revoked = reviewMediaProvenance(approved, {action: "revoke", note: "Rights withdrawn"}, reviewer);
  assert.equal(mayUseApprovedMedia(revoked), false);
});
test("representative equipment images require explicit label", () => {
  const row = createPendingMediaProvenance({...original(), applicability: "representative", model: "", representativeLabel: "Representative equipment installation; not the exact model"});
  assert.equal(row.representativeLabel.startsWith("Representative"), true);
  assert.equal(row.status, "pending_review");
});
