import { audit, now, revision, transaction, uid } from "./store.mjs";
import { validateContent } from "./content.mjs";

export const APPROVED_RESOURCE_SLUGS = new Set([
  "how-to-identify-your-pool-equipment",
  "pool-equipment-pre-service-checklist",
  "what-pool-service-technicians-should-document-on-every-job",
  "what-makes-a-pool-equipment-diagnostic-answer-trustworthy",
  "the-true-cost-of-repeated-pool-service-visits",
  "pool-diagnostic-workflow",
]);

export function reconcileApprovedResources(db, actorId, batch) {
  if (batch?.format !== "pooldocai-approved-content-reconciliation-v1") {
    throw new Error("Unsupported approved-content reconciliation batch");
  }
  if (!actorId || !db.prepare("SELECT 1 FROM users WHERE id=? AND role='owner' AND active=1").get(actorId)) {
    throw new Error("An active owner is required for approved-content reconciliation");
  }

  const result = { created: 0, updated: 0, skipped: 0, slugs: [] };
  for (const entry of batch.resources || []) {
    const slug = entry?.article?.slug;
    if (!APPROVED_RESOURCE_SLUGS.has(slug)) throw new Error(`Unexpected approved resource: ${slug || "missing slug"}`);
    if (
      entry.editorial?.state !== "draft" ||
      entry.editorial?.publicationApproval !== false ||
      entry.editorial?.knowledgeApproval !== false ||
      entry.article?.seo?.noindex !== true
    ) throw new Error(`Unsafe approved-content state for ${slug}`);

    const previousSlug = entry.editorial?.previousSlug || null;
    let row = db.prepare("SELECT * FROM articles WHERE slug=?").get(slug);
    if (!row && previousSlug) row = db.prepare("SELECT * FROM articles WHERE slug=?").get(previousSlug);
    if (!row && !entry.editorial?.createIfMissing) throw new Error(`Existing editorial history is required for ${slug}`);
    if (!row) {
      transaction(db, () => {
        const id = uid(), timestamp = now();
        const content = validateContent(db, entry.article);
        db.prepare("INSERT INTO articles(id,slug,status,data,published,version,created_at,updated_at) VALUES(?,?,'draft',?,NULL,1,?,?)")
          .run(id, slug, JSON.stringify({ ...content, updatedAt: timestamp }), timestamp, timestamp);
        const created = db.prepare("SELECT * FROM articles WHERE id=?").get(id);
        revision(db, created, actorId, "owner_approved_content_import_2026_10_26");
        audit(db, actorId, "owner_approved_content_import", id, {
          resourceId: entry.editorial.resourceId,
          approvalDate: entry.editorial.approvalDate,
          sourceFiles: entry.editorial.sourceFiles,
          sourceChecksums: entry.editorial.sourceChecksums,
          publicationApproval: false,
          knowledgeApproval: false,
        });
      });
      result.created += 1;
      result.slugs.push(slug);
      continue;
    }
    if (row.status !== "draft" || row.published !== null || row.scheduled_at !== null) {
      throw new Error(`Refusing to reconcile non-draft or published resource: ${slug}`);
    }
    const knowledge = db.prepare("SELECT status FROM knowledge_reviews WHERE article_id=? AND status='approved'").get(row.id);
    if (knowledge) throw new Error(`Refusing to reconcile knowledge-approved resource: ${slug}`);

    if (row.slug !== slug && db.prepare("SELECT id FROM articles WHERE slug=? AND id<>?").get(slug, row.id)) {
      throw new Error(`Duplicate or reserved slug: ${slug}`);
    }
    const current = JSON.parse(row.data);
    const content = validateContent(db, entry.article, current);
    const comparableCurrent = { ...current };
    delete comparableCurrent.updatedAt;
    if (row.slug === slug && JSON.stringify(comparableCurrent) === JSON.stringify(content)) {
      result.skipped += 1;
      result.slugs.push(slug);
      continue;
    }

    transaction(db, () => {
      const timestamp = now();
      db.prepare("UPDATE articles SET slug=?,data=?,version=version+1,updated_at=? WHERE id=? AND status='draft' AND published IS NULL")
        .run(slug, JSON.stringify({ ...content, updatedAt: timestamp }), timestamp, row.id);
      const updated = db.prepare("SELECT * FROM articles WHERE id=?").get(row.id);
      revision(db, updated, actorId, "owner_approved_content_reconciliation_2026_10_26");
      audit(db, actorId, "owner_approved_content_reconciliation", row.id, {
        resourceId: entry.editorial.resourceId,
        approvalDate: entry.editorial.approvalDate,
        sourceFiles: entry.editorial.sourceFiles,
        sourceChecksums: entry.editorial.sourceChecksums,
        attachment: entry.editorial.attachment || null,
        previousSlug: row.slug === slug ? null : row.slug,
        publicationApproval: false,
        knowledgeApproval: false,
      });
    });
    result.updated += 1;
    result.slugs.push(slug);
  }
  return result;
}
