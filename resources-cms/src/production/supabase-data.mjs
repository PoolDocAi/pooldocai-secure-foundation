import { randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION = /^[a-z][a-z0-9-]{0,63}$/;

function principal(value) {
  if (!value || !UUID.test(String(value.id || "")) || typeof value.accessToken !== "string" || !value.accessToken) {
    throw Object.assign(new Error("Verified CMS session required"), { status: 401 });
  }
  return value;
}

function uuid(value, label) {
  if (!UUID.test(String(value || ""))) throw new TypeError(`${label} must be a UUID`);
  return String(value);
}

const jsonSize = (value) => Buffer.byteLength(JSON.stringify(value ?? {}), "utf8");

// Uses only a publishable key plus the caller's verified Supabase Auth JWT.
// No service-role key or direct Postgres credential exists in this adapter.
export class SupabaseDataCMS {
  constructor({ url, publishableKey, fetchImpl = fetch }) {
    this.url = new URL(url);
    this.publishableKey = String(publishableKey || "");
    this.fetchImpl = fetchImpl;
    if (!this.publishableKey) throw new TypeError("Supabase publishable key required");
  }

  async rpc(name, payload = {}, accessToken = null) {
    const token = accessToken || this.publishableKey;
    const response = await this.fetchImpl(new URL(`/rest/v1/rpc/${name}`, this.url), {
      method: "POST",
      headers: {
        apikey: this.publishableKey,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Profile": "resources_cms",
        "Accept-Profile": "resources_cms",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const message = typeof data?.message === "string" ? data.message : "CMS database request rejected";
      const error = Object.assign(new Error(message), { status: response.status, code: data?.code });
      throw error;
    }
    return data;
  }

  admin(user, operation, payload = {}) {
    const auth = principal(user);
    return this.rpc("query", { p_operation: operation, p_payload: payload }, auth.accessToken);
  }

  memberRole(user) { return this.admin(user, "member-role"); }

  command(user, articleId, version, action, payload = {}, commandId = randomUUID()) {
    const auth = principal(user);
    uuid(articleId, "Article"); uuid(commandId, "Command");
    if (!Number.isInteger(version) || version < 0) throw new TypeError("Version required");
    if (!ACTION.test(String(action || ""))) throw new TypeError("Invalid action");
    if (jsonSize(payload) > 250_000) throw new RangeError("Command payload too large");
    return this.rpc("dispatch", { p_command_id: commandId, p_id: articleId, p_version: version, p_action: action, p_payload: payload }, auth.accessToken);
  }

  taxonomyCommand(user, version, action, payload = {}, commandId = randomUUID()) {
    const auth = principal(user); uuid(commandId, "Command");
    if (!Number.isInteger(version) || version < 0 || !ACTION.test(String(action || ""))) throw new TypeError("Invalid taxonomy command");
    if (jsonSize(payload) > 32_000) throw new RangeError("Taxonomy payload too large");
    return this.rpc("taxonomy_command", { p_command_id: commandId, p_version: version, p_action: action, p_payload: payload }, auth.accessToken);
  }

  mediaCommand(user, action, payload = {}, commandId = randomUUID()) {
    const auth = principal(user); uuid(commandId, "Command");
    if (!ACTION.test(String(action || ""))) throw new TypeError("Invalid media action");
    if (jsonSize(payload) > 32_000) throw new RangeError("Media payload too large");
    return this.rpc("media_command", { p_command_id: commandId, p_action: action, p_payload: payload }, auth.accessToken);
  }

  settingsCommand(user, payload, commandId = randomUUID()) {
    const auth = principal(user); uuid(commandId, "Command");
    if (jsonSize(payload) > 8_000) throw new RangeError("Settings payload too large");
    return this.rpc("settings_command", { p_command_id: commandId, p_payload: payload }, auth.accessToken);
  }

  bulkArchive(user, items, commandId = randomUUID()) {
    const auth = principal(user); uuid(commandId, "Command");
    if (!Array.isArray(items) || items.length < 1 || items.length > 50 || items.some((item) => !UUID.test(String(item?.id)) || !Number.isInteger(item?.version))) throw new TypeError("Invalid bulk selection");
    return this.rpc("bulk_archive", { p_command_id: commandId, p_items: items }, auth.accessToken);
  }

  read(user, id) { uuid(id, "Article"); return this.admin(user, "article-read", { id }); }
  list(user, options = {}) { return this.admin(user, "article-list", options); }
  revisions(user, articleId) { uuid(articleId, "Article"); return this.admin(user, "revision-list", { articleId }); }
  taxonomy(user) { return this.admin(user, "taxonomy-list"); }
  media(user, id) { uuid(id, "Media"); return this.admin(user, "media-read", { id }); }
  mediaList(user) { return this.admin(user, "media-list"); }
  settings(user) { return this.admin(user, "settings-read"); }
  knowledgeStatuses(user) { return this.admin(user, "knowledge-statuses"); }
  recentAudit(user, limit = 25) { return this.admin(user, "recent-audit", { limit: Math.min(Math.max(Number(limit) || 25, 1), 100) }); }
  exportAll(user) { return this.platformEnabled?this.rpc("platform_backup",{},principal(user).accessToken):this.admin(user,"export-all"); }
  knowledgeExport(user) { return this.admin(user, "knowledge-export"); }

  publicArticle(slug) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(slug || ""))) return null;
    return this.rpc(this.useVerifiedCatalog?"verified_public_article":"public_article", { p_slug: slug });
  }
  publicIndex() { return this.rpc(this.useVerifiedCatalog?"verified_public_index":"public_index"); }
  publicMedia(id) { uuid(id, "Media"); return this.rpc(this.useVerifiedCatalog?"verified_public_media":"public_media", { p_id: id }); }
  redirect(slug) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(slug || ""))) return null;
    return this.rpc(this.useVerifiedCatalog?"verified_public_redirect":"public_redirect", { p_slug: slug });
  }
}
