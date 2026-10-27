// PoolDocAI Resources — authentic-media provenance policy.
// Pure policy helpers. These do NOT confer permissions or persist records.
// Callers MUST perform authenticated owner/editor checks server-side; media approval
// MUST be restricted to authorized reviewers and written through audited commands.
const SOURCE_TYPES = new Set([
  "pooldocai_original",
  "manufacturer_authorized",
  "licensed_photography",
  "contributor_permission",
  "verified_public_domain",
]);
const MEDIA_TYPES = new Set([
  "authentic_photograph",
  "manufacturer_diagram",
  "human_designed_graphic",
]);
const APPLICABILITY = new Set(["exact_model", "representative", "not_applicable"]);
const SCOPES = new Set(["website", "social", "download"]);
const SHA256 = /^[a-f0-9]{64}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredString(value, field, max = 300) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new Error(field + " must be nonempty and at most " + max + " characters");
  }
  return value.trim();
}
function optionalString(value, field, max = 300) {
  if (value == null || value === "") return "";
  if (typeof value !== "string" || value.trim().length > max) throw new Error("Invalid " + field);
  return value.trim();
}
function validDate(value, field) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value + "T00:00:00Z"))) throw new Error("Invalid " + field);
  return value;
}
function ensureEnum(value, allowed, name) {
  if (!allowed.has(value)) throw new Error("Unsupported " + name);
  return value;
}
function permissionScopes(value) {
  if (!Array.isArray(value) || value.length === 0 ||
      value.length > SCOPES.size || !value.every(s => SCOPES.has(s))) {
    throw new Error("Valid permission scopes required");
  }
  return [...new Set(value)];
}
function noClientApprovalFields(input) {
  const forbidden = ["status", "approved", "approvedBy", "approvedAt",
    "reviewedBy", "reviewedAt", "verified", "published", "public",
    "ownerApproved", "rightsVerified"];
  if (forbidden.some(k => Object.hasOwn(input, k))) {
    throw new Error("Review and publication status cannot be supplied by an uploader");
  }
}

// Accepts a record supplied by an uploader. Always returns a PENDING record.
// Metadata and AI-origin claims are assertions requiring independent verification.
export function createPendingMediaProvenance(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid media submission");
  noClientApprovalFields(input);
  const assetId = requiredString(input.assetId, "assetId", 80);
  if (!UUID.test(assetId)) throw new Error("Invalid media asset UUID");
  const originalChecksum = requiredString(input.originalChecksum, "originalChecksum", 64).toLowerCase();
  if (!SHA256.test(originalChecksum)) throw new Error("Invalid original SHA-256 checksum");
  const mediaType = ensureEnum(input.mediaType, MEDIA_TYPES, "media type");
  const sourceType = ensureEnum(input.sourceType, SOURCE_TYPES, "source type");
  const applicability = ensureEnum(input.applicability, APPLICABILITY, "applicability");
  if (input.aiGenerated !== false || input.aiEnhanced !== false) {
    throw new Error("AI-generated or generatively enhanced imagery is not permitted");
  }
  const manufacturer = optionalString(input.manufacturer, "manufacturer", 120);
  const model = optionalString(input.model, "model", 120);
  const representativeLabel = optionalString(input.representativeLabel, "representativeLabel", 220);
  if (applicability === "exact_model" && (!manufacturer || !model)) {
    throw new Error("Exact-model imagery requires manufacturer and model");
  }
  if (applicability === "representative" && !representativeLabel) {
    throw new Error("Representative imagery must be clearly labeled");
  }
  const sourceUrl = optionalString(input.sourceUrl, "sourceUrl", 2000);
  if (sourceUrl && !/^https:\/\/[^\s/]+(?:\/[^\s]*)?$/i.test(sourceUrl)) {
    throw new Error("Source URL must use HTTPS");
  }
  const containsPeople = input.containsPeople === true;
  return {
    assetId,
    originalChecksum,
    mediaType,
    sourceType,
    sourceDescription: requiredString(input.sourceDescription, "sourceDescription", 1000),
    sourceUrl,
    copyrightHolder: requiredString(input.copyrightHolder, "copyrightHolder", 250),
    creditText: optionalString(input.creditText, "creditText", 500),
    licenseEvidenceRef: requiredString(input.licenseEvidenceRef, "licenseEvidenceRef", 250),
    scopes: permissionScopes(input.scopes),
    expiresOn: validDate(input.expiresOn, "expiresOn"),
    altText: requiredString(input.altText, "altText", 300),
    manufacturer,
    model,
    modelGeneration: optionalString(input.modelGeneration, "modelGeneration", 120),
    applicability,
    representativeLabel,
    containsPeople,
    consentEvidenceRef: containsPeople
      ? requiredString(input.consentEvidenceRef, "consentEvidenceRef", 250)
      : optionalString(input.consentEvidenceRef, "consentEvidenceRef", 250),
    aiGenerated: false,
    aiEnhanced: false,
    status: "pending_review",
    approvedBy: null,
    approvedAt: null,
    reviewNote: null,
  };
}

// Reviewer/role evidence comes from the trusted server session, never from the body.
export function reviewMediaProvenance(pending, decision, trustedContext) {
  if (trustedContext?.isAuthorizedMediaReviewer !== true) throw new Error("Reviewer permission required");
  const reviewerId = requiredString(trustedContext.reviewerId, "reviewerId", 100);
  if (!pending || !["pending_review", "approved", "rejected", "revoked"].includes(pending.status)) {
    throw new Error("Invalid existing media record");
  }
  if (!["approve", "reject", "revoke"].includes(decision?.action)) throw new Error("Invalid review action");
  if (decision.action === "approve" && pending.status !== "pending_review") {
    throw new Error("Only pending media can be approved");
  }
  if (decision.action === "revoke" && pending.status !== "approved") {
    throw new Error("Only approved media can be revoked");
  }
  const now = trustedContext.now instanceof Date ? trustedContext.now : new Date();
  if (decision.action === "approve" && !isProvenanceComplete(pending, "website", now)) {
    throw new Error("Media rights or applicability are not publication-ready");
  }
  const status = {approve: "approved", reject: "rejected", revoke: "revoked"}[decision.action];
  return {
    ...pending,
    status,
    approvedBy: status === "approved" ? reviewerId : null,
    approvedAt: status === "approved" ? now.toISOString() : null,
    reviewNote: requiredString(decision.note, "review note", 2000),
    reviewedBy: reviewerId,
    reviewedAt: now.toISOString(),
  };
}
export function isProvenanceComplete(item, scope = "website", at = new Date()) {
  if (!item || !SCOPES.has(scope) || item.aiGenerated !== false || item.aiEnhanced !== false) return false;
  if (!SOURCE_TYPES.has(item.sourceType) || !MEDIA_TYPES.has(item.mediaType)) return false;
  if (!SHA256.test(item.originalChecksum || "") || !item.licenseEvidenceRef || !item.copyrightHolder) return false;
  if (!item.altText || !Array.isArray(item.scopes) || !item.scopes.includes(scope)) return false;
  if (item.expiresOn && (typeof item.expiresOn !== "string" ||
      Date.parse(item.expiresOn + "T23:59:59Z") < at.getTime())) return false;
  if (item.applicability === "exact_model" && (!item.manufacturer || !item.model)) return false;
  if (item.applicability === "representative" && !item.representativeLabel) return false;
  if (item.containsPeople && !item.consentEvidenceRef) return false;
  return true;
}
export function mayUseApprovedMedia(item, scope = "website", at = new Date()) {
  return item?.status === "approved" && Boolean(item.approvedBy && item.approvedAt) &&
    Number.isFinite(Date.parse(item.approvedAt)) && isProvenanceComplete(item, scope, at);
}
// Public image metadata must never include confidential license evidence, reviewer identity or audit notes.
export function publicMediaMetadata(item) {
  if (!mayUseApprovedMedia(item)) return null;
  return Object.freeze({
    assetId: item.assetId,
    mediaType: item.mediaType,
    altText: item.altText,
    creditText: item.creditText,
    manufacturer: item.manufacturer,
    model: item.model,
    applicability: item.applicability,
    representativeLabel: item.representativeLabel,
  });
}
