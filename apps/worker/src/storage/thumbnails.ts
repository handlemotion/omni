import { STORAGE_THUMBNAIL_MAX_SOURCE_BYTES, storageThumbnailQuerySchema } from "@omni/contracts";
import type { FileResult } from "@omni/db";
import type { Context } from "hono";
import type { AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";
import { conditionsOf, thumbnailKey, unchangedStatus } from "./core.ts";
import { refused } from "./http.ts";

const DRAWN_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const drawable = (file: { size: number; mimeType: string | null }) =>
  file.size > 0 &&
  file.size <= STORAGE_THUMBNAIL_MAX_SOURCE_BYTES &&
  DRAWN_TYPES.has(file.mimeType?.split(";")[0]!.trim().toLowerCase() ?? "");

const noThumbnail = (c: Context<AppEnv>) =>
  apiError(c, "no_thumbnail", "this file has no thumbnail");

async function draw(env: AppEnv["Bindings"], r2Key: string, size: number) {
  const original = await env.STORAGE_BUCKET.get(r2Key);
  if (!original) return null;
  try {
    const drawn = await env.IMAGES.input(original.body)
      .transform({ width: size, height: size, fit: "scale-down" })
      .output({ format: "image/webp", quality: 80, anim: false });
    const bytes = new Uint8Array(await drawn.response().arrayBuffer());
    return await env.STORAGE_BUCKET.put(thumbnailKey(r2Key, size), bytes, {
      httpMetadata: { contentType: "image/webp" },
    });
  } catch {
    return null;
  }
}

/**
 * `GET /files/:id/thumbnail`: a small WebP of an image file, drawn once per size and version and
 * then read from the bucket, so a grid never downloads originals. It is our own re-encoded
 * raster, so it may render inline.
 */
export async function thumbnail(c: Context<AppEnv>, found: FileResult) {
  if (found.status !== "ok") return refused(c, found.status);
  const query = storageThumbnailQuerySchema.safeParse(c.req.query());
  if (!query.success) return apiError(c, "bad_request", query.error.issues[0]!.message);
  const { size, v } = query.data;
  if (!drawable(found.file)) return noThumbnail(c);

  const key = thumbnailKey(found.r2Key, size);
  const conditions = conditionsOf(c.req.raw.headers);
  let stored: R2Object | R2ObjectBody | null = await c.env.STORAGE_BUCKET.get(key, {
    onlyIf: conditions,
  });
  if (!stored) {
    if (!(await draw(c.env, found.r2Key, size))) return noThumbnail(c);
    stored = await c.env.STORAGE_BUCKET.get(key, { onlyIf: conditions });
    if (!stored) return noThumbnail(c);
  }
  const headers = new Headers({
    "content-type": "image/webp",
    "content-disposition": "inline",
    "x-content-type-options": "nosniff",
    "cache-control":
      v === found.file.contentVersion
        ? "private, max-age=31536000, immutable"
        : "private, no-cache",
    etag: stored.httpEtag,
    "last-modified": stored.uploaded.toUTCString(),
  });
  if (!("body" in stored)) {
    return new Response(null, { status: unchangedStatus(conditions), headers });
  }
  headers.set("content-length", String(stored.size));
  return new Response(stored.body, { headers });
}
