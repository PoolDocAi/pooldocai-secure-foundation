import { createHash } from "node:crypto";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Owner-triggered offline export. The caller supplies a short-lived verified
// owner session; no service-role credential is used or serialized.
export async function exportMedia({ db, storage, actorId, token }) {
  const records = await db.mediaList(actorId);
  const objects = [];
  for (const record of records.filter((item) => !item.archived)) {
    const response = await storage.download(record.id, token);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (digest(bytes) !== record.checksum) throw new Error(`Media checksum mismatch: ${record.id}`);
    objects.push({ id: record.id, objectKey: record.object_key, checksum: record.checksum, mime: record.mime, bytes: bytes.toString("base64") });
  }
  return { format: "resources-cms-media-v1", createdAt: new Date().toISOString(), objects };
}

// Restore is intentionally separate from normal web routes and refuses to
// overwrite objects. Metadata must be restored first from the logical backup.
export async function restoreMedia({ backup, storage, token }) {
  if (backup?.format !== "resources-cms-media-v1" || !Array.isArray(backup.objects)) throw new Error("Unsupported media backup");
  let restored = 0;
  for (const object of backup.objects) {
    const bytes = Buffer.from(object.bytes || "", "base64");
    if (!bytes.length || digest(bytes) !== object.checksum || object.mime !== "image/webp") throw new Error(`Invalid media backup object: ${object.id}`);
    await storage.request(object.objectKey, token, { method: "POST", body: bytes, contentType: "image/webp" });
    restored++;
  }
  return { restored };
}
