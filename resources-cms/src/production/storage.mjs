import { createHash } from "node:crypto";
import { basename } from "node:path";
import sharp from "sharp";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export function safeMediaName(name) {
  const clean = basename(String(name || "").normalize("NFKC"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[^a-zA-Z0-9._ -]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean || clean.length > 160) throw new Error("Invalid media name");
  return clean;
}

export async function validatedImage(bytes) {
  const input = Buffer.from(bytes || []);
  if (!input.length || input.length > MAX_IMAGE_BYTES) throw new Error("Upload size rejected");
  const image = sharp(input, {
    failOn: "warning",
    limitInputPixels: 40_000_000,
    sequentialRead: true,
  });
  const metadata = await image.metadata();
  if (!["png", "jpeg", "webp"].includes(metadata.format)) {
    throw new Error("Only JPEG, PNG and WebP enabled; SVG and PDF disabled");
  }
  if (!metadata.width || !metadata.height || metadata.width > 10_000 || metadata.height > 10_000) {
    throw new Error("Image dimensions rejected");
  }
  if ((metadata.pages || 1) !== 1) throw new Error("Animated images are not enabled");
  const output = await image.rotate().webp({ quality: 85, effort: 4 }).toBuffer();
  if (output.length > MAX_IMAGE_BYTES) throw new Error("Canonical image size rejected");
  return {
    bytes: output,
    mime: "image/webp",
    width: metadata.autoOrient?.width || metadata.width,
    height: metadata.autoOrient?.height || metadata.height,
    checksum: createHash("sha256").update(output).digest("hex"),
  };
}

export function mediaObjectKey(id) {
  if (!UUID.test(String(id || ""))) throw new Error("Invalid media UUID");
  return `images/${id}.webp`;
}

// Uses the caller's verified user token and publishable key. Storage RLS remains
// authoritative; no service_role or secret key is accepted.
export class PrivateStorage {
  constructor({ url, publishableKey, bucket = "resources-cms-media", fetchImpl = fetch }) {
    if (!url || !publishableKey) throw new Error("Storage configuration missing");
    Object.assign(this, { url, publishableKey, bucket, fetchImpl });
  }

  async request(objectKey, token, { method = "GET", body, contentType, allowAnonymous = false } = {}) {
    const match = String(objectKey || "").match(/^images\/([^/]+)\.webp$/i);
    if (!match || !UUID.test(match[1])) throw new Error("Invalid object key");
    if ((!token && !allowAnonymous) || String(token || "").length > 8192) throw new Error("Authentication required");
    if (!['GET','POST','DELETE'].includes(method) || (allowAnonymous && method !== 'GET')) throw new Error("Storage operation rejected");
    if (/[\r\n]/.test(String(token || ""))) throw new Error("Authentication rejected");
    const response = await this.fetchImpl(new URL(`/storage/v1/object/${this.bucket}/${objectKey}`, this.url), {
      method,
      headers: {
        apikey: this.publishableKey,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { "Content-Type": contentType || "application/octet-stream", "x-upsert": "false" } : {}),
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Private storage request rejected");
    return response;
  }

  async upload(id, token, bytes) {
    const image = await validatedImage(bytes);
    const response = await this.request(mediaObjectKey(id), token, {
      method: "POST",
      body: image.bytes,
      contentType: image.mime,
    });
    return { ...image, response };
  }

  async download(id, token) {
    return this.request(mediaObjectKey(id), token);
  }

  async downloadPublic(id) {
    return this.request(mediaObjectKey(id), null, { allowAnonymous: true });
  }

  async remove(id, token) {
    return this.request(mediaObjectKey(id), token, { method: "DELETE" });
  }
}

export async function mediaGateway(id, { authorize, readPrivate, published = false, etag = null }) {
  const unavailable = () => new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  if (!UUID.test(String(id || ""))) return unavailable();
  const authorization = await authorize(id);
  if (!authorization) return unavailable();
  const value = await readPrivate(id);
  const bytes = value instanceof Response ? await value.arrayBuffer() : value;
  return new Response(bytes, {
    headers: {
      "Content-Type": "image/webp",
      "Content-Length": String(bytes.byteLength),
      // A public reference can be withdrawn on the next request. Never serve an
      // old cached object after the database no longer authorizes its delivery.
      "Cache-Control": published ? "no-store, max-age=0, s-maxage=0" : "private, no-store",
      ...(etag ? { ETag: `"${etag}"` } : {}),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cross-Origin-Resource-Policy": "same-site",
    },
  });
}
