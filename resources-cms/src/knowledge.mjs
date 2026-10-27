import { createHash } from "node:crypto";
import { uid, now, audit } from "./store.mjs";
export const checksum = (d) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        d.title,
        d.body,
        d.sources,
        d.audience,
        d.categoryId,
        d.tagIds,
        d.manufacturer || "",
        d.model || "",
        d.equipmentCategory || "",
      ]),
    )
    .digest("hex");
export const classifications = [
  "general_education",
  "homeowner_safe_observation",
  "manufacturer_supported_diagnostic",
  "technician_reviewed_diagnostic",
  "verified_repair_procedure",
  "unverified_hypothesis",
];
export function revoke(db, articleId, actor, reason) {
  const k = db
    .prepare("SELECT * FROM knowledge_reviews WHERE article_id=?")
    .get(articleId);
  if (!k || k.status === "revoked") return;
  db.prepare(
    "UPDATE knowledge_reviews SET status='revoked',reason=? WHERE article_id=?",
  ).run(reason, articleId);
  if(k.approval_id) db.prepare(
    "INSERT OR IGNORE INTO knowledge_outbox(id,article_id,revision_id,approval_id,event,created_at) VALUES(?,?,?,?,'revoke',?)",
  ).run(uid(), articleId, k.revision_id, k.approval_id, now());
  audit(db, actor, "knowledge_revoke", articleId, {
    reason,
    revisionId: k.revision_id,
  });
}
export function sections(d) {
  const parts = d.body.split(/(?=<h[234]\b)/i).filter(Boolean);
  return parts.map((html, i) => {
    const title =
      html
        .match(/^<h[234][^>]*>([\s\S]*?)<\/h[234]>/i)?.[1]
        ?.replace(/<[^>]*>/g, "") || "Introduction";
    return {
      id: `section-${i + 1}-${createHash("sha256").update(html).digest("hex").slice(0, 12)}`,
      title,
      html,
      text: html
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim(),
    };
  });
}
export function eligible(db) {
  return db
    .prepare(
      "SELECT a.*,k.approval_id,k.classification,k.verification_status,k.revision_id,k.checksum,k.reviewer_id,k.reviewed_at,k.evidence,k.section_ids FROM articles a JOIN knowledge_reviews k ON k.article_id=a.id JOIN revisions r ON r.id=k.revision_id AND r.article_id=a.id AND r.version=a.version WHERE k.status='approved' AND k.classification<>'unverified_hypothesis' AND a.published IS NOT NULL AND a.status='published'",
    )
    .all()
    .filter((r) => {
      const d = JSON.parse(r.data),
        p = JSON.parse(r.published);
      return checksum(d) === r.checksum && checksum(p) === r.checksum;
    });
}
export function exportKnowledge(db) {
  return {
    format: "pooldocai-editorial-knowledge-v1",
    collection: "platform_public_editorial",
    generatedAt: now(),
    requiresOnlineEligibilityCheck: true,
    records: eligible(db).flatMap((r) => {
      const d = JSON.parse(r.data),
        scope = JSON.parse(r.section_ids);
      return sections(d)
        .filter((s) => !scope.length || scope.includes(s.id))
        .map((s) => ({
          articleId: r.id,
          approvalId: r.approval_id,
          revisionId: r.revision_id,
          sectionId: s.id,
          publicUrl: `https://pooldocai.com/resources/${r.slug}/`,
          articleTitle: d.title,
          manufacturer: d.manufacturer || null,
          model: d.model || null,
          equipmentCategory: d.equipmentCategory || null,
          safetyClassification: r.classification,
          audience: d.audience,
          evidenceType: r.verification_status,
          originalSources: JSON.parse(r.evidence),
          editorialSources: d.sources,
          articleCitation: {
            url: `https://pooldocai.com/resources/${r.slug}/`,
            type: "editorial_secondary_source",
          },
          reviewerId: r.reviewer_id,
          verificationDate: r.reviewed_at,
          contentChecksum: r.checksum,
          sectionChecksum: createHash("sha256").update(s.text).digest("hex"),
          approvalStatus: "approved",
          text: s.text,
          html: s.html,
          ingestionStatus: "not_connected",
        }));
    }),
    events: db
      .prepare("SELECT * FROM knowledge_outbox ORDER BY created_at,id")
      .all(),
    embedding: {
      enabled: false,
      strategy:
        "Use existing application embedding model only after separate authorization",
    },
  };
}
