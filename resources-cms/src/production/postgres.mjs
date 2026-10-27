import { randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION = /^[a-z][a-z0-9-]{0,63}$/;

function uuid(value, label) {
  if (!UUID.test(String(value || ""))) throw new TypeError(`${label} must be a UUID`);
  return String(value);
}

const jsonSize = (value) => Buffer.byteLength(JSON.stringify(value ?? {}), "utf8");

// Local PostgreSQL/PGlite verification adapter. The hosted runtime uses
// SupabaseDataCMS so no CMS database LOGIN or privileged connection string is
// provisioned in the shared Supabase project.
export class PostgresCMS {
  constructor(pool) {
    if (!pool?.connect) throw new TypeError("A pg-compatible Pool is required");
    this.pool = pool;
  }

  async transaction(actorId, fn, { readOnly = false } = {}) {
    const actor = actorId instanceof Object ? uuid(actorId?.id, "Verified actor") : uuid(actorId, "Verified actor");
    const client = await this.pool.connect();
    let began = false;
    try {
      await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
      began = true;
      await client.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: actor, role: "authenticated" })]);
      const result = await fn(client);
      await client.query("COMMIT");
      began = false;
      return result;
    } catch (error) {
      if (began) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original failure. pg discards a broken connection.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async command(actorId, articleId, version, action, payload = {}, commandId = randomUUID()) {
    uuid(articleId, "Article");
    uuid(commandId, "Command");
    if (!Number.isInteger(version) || version < 0) throw new TypeError("Version required");
    if (!ACTION.test(String(action || ""))) throw new TypeError("Invalid action");
    if (jsonSize(payload) > 250_000) throw new RangeError("Command payload too large");
    return this.transaction(actorId, async (client) => {
      const result = await client.query(
        "SELECT resources_cms.dispatch($1::uuid,$2::uuid,$3::integer,$4::text,$5::jsonb) AS result",
        [commandId, articleId, version, action, JSON.stringify(payload ?? {})],
      );
      return result.rows[0]?.result;
    });
  }

  memberRole(actorId) { return this.#query(actorId, "member-role"); }

  async taxonomyCommand(actorId, version, action, payload = {}, commandId = randomUUID()) {
    uuid(commandId, "Command");
    if (!Number.isInteger(version) || version < 0) throw new TypeError("Version required");
    if (!ACTION.test(String(action || ""))) throw new TypeError("Invalid taxonomy action");
    if (jsonSize(payload) > 32_000) throw new RangeError("Taxonomy payload too large");
    return this.transaction(actorId, async (client) => {
      const result = await client.query(
        "SELECT resources_cms.taxonomy_command($1::uuid,$2::integer,$3::text,$4::jsonb) AS result",
        [commandId, version, action, JSON.stringify(payload ?? {})],
      );
      return result.rows[0]?.result;
    });
  }

  async mediaCommand(actorId, action, payload = {}, commandId = randomUUID()) {
    uuid(commandId, "Command");
    if (!ACTION.test(String(action || ""))) throw new TypeError("Invalid media action");
    if (jsonSize(payload) > 32_000) throw new RangeError("Media payload too large");
    return this.transaction(actorId, async (client) => {
      const result = await client.query(
        "SELECT resources_cms.media_command($1::uuid,$2::text,$3::jsonb) AS result",
        [commandId, action, JSON.stringify(payload ?? {})],
      );
      return result.rows[0]?.result;
    });
  }

  async media(actorId, mediaId) {
    uuid(mediaId, "Media");
    return this.#query(actorId, "media-read", { id: mediaId });
  }

  async publicMedia(mediaId) {
    uuid(mediaId, "Media");
    const client = await this.pool.connect();
    try {
      return (await client.query("SELECT resources_cms.public_media($1::uuid) AS result", [mediaId])).rows[0]?.result || null;
    } finally {
      client.release();
    }
  }

  async read(actorId, articleId) {
    uuid(articleId, "Article");
    return this.#query(actorId, "article-read", { id: articleId });
  }

  async list(actorId, { status = null, categoryId = null, tagId = null, query = "", limit = 100, offset = 0 } = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    if (status && !["draft","review","approved","scheduled","published","archived","deleted"].includes(status)) {
      throw new TypeError("Invalid status");
    }
    if (categoryId) uuid(categoryId, "Category");
    if (tagId) uuid(tagId, "Tag");
    const text = String(query || "").trim().slice(0, 200);
    return this.#query(actorId, "article-list", { status, categoryId, tagId, query: text, limit: safeLimit, offset: safeOffset });
  }

  async revisions(actorId, articleId) {
    uuid(articleId, "Article");
    return this.#query(actorId, "revision-list", { articleId });
  }

  async taxonomy(actorId) {
    return this.#query(actorId, "taxonomy-list");
  }

  async mediaList(actorId) {
    return this.#query(actorId, "media-list");
  }

  async settings(actorId) {
    return this.#query(actorId, "settings-read");
  }

  async knowledgeStatuses(actorId) {
    return this.#query(actorId, "knowledge-statuses");
  }

  async recentAudit(actorId, limit = 25) {
    const safeLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
    return this.#query(actorId, "recent-audit", { limit: safeLimit });
  }

  async settingsCommand(actorId, payload, commandId = randomUUID()) {
    uuid(commandId, "Command");
    if (jsonSize(payload) > 8_000) throw new RangeError("Settings payload too large");
    return this.transaction(actorId, async (client) => (await client.query(
      "SELECT resources_cms.settings_command($1::uuid,$2::jsonb) AS result", [commandId, JSON.stringify(payload ?? {})],
    )).rows[0]?.result);
  }

  async bulkArchive(actorId, items, commandId = randomUUID()) {
    uuid(commandId, "Command");
    if (!Array.isArray(items) || items.length < 1 || items.length > 50 || items.some((item) => !UUID.test(String(item?.id)) || !Number.isInteger(item?.version))) throw new TypeError("Invalid bulk selection");
    return this.transaction(actorId, async (client) => (await client.query(
      "SELECT resources_cms.bulk_archive($1::uuid,$2::jsonb) AS result", [commandId, JSON.stringify(items)],
    )).rows[0]?.result);
  }

  async exportAll(actorId) {
    return this.#query(actorId, "export-all");
  }

  async knowledgeExport(actorId) {
    return this.#query(actorId, "knowledge-export");
  }

  async runDue(actorId, limit = 100) {
    const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 100);
    return this.transaction(actorId, async (client) => {
      const result = await client.query("SELECT resources_cms.publish_due($1::integer) AS result", [safeLimit]);
      return result.rows[0]?.result;
    });
  }

  async publicArticle(slug) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(slug || ""))) return null;
    const client = await this.pool.connect();
    try {
      const result = await client.query("SELECT resources_cms.public_article($1::text) AS result", [slug]);
      return result.rows[0]?.result || null;
    } finally {
      client.release();
    }
  }

  async publicIndex() {
    const client = await this.pool.connect();
    try {
      return (await client.query("SELECT * FROM resources_cms.public_index()")).rows;
    } finally {
      client.release();
    }
  }

  async redirect(slug) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(slug || ""))) return null;
    const client = await this.pool.connect();
    try {
      return (await client.query("SELECT resources_cms.public_redirect($1::text) AS result", [slug])).rows[0]?.result || null;
    } finally { client.release(); }
  }

  #query(actorId, operation, payload = {}) {
    return this.transaction(actorId, async (client) => (await client.query(
      "SELECT resources_cms.query($1::text,$2::jsonb) AS result", [operation, JSON.stringify(payload)],
    )).rows[0]?.result, { readOnly: true });
  }
}
