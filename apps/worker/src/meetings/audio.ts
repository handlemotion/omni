import type { Context } from "hono";
import type { AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";

const RANGE = /^bytes=(\d*)-(\d*)$/;

function byteRange(header: string | undefined, size: number) {
  const match = RANGE.exec(header ?? "");
  const first = match?.[1] ? Number(match[1]) : null;
  const last = match?.[2] ? Number(match[2]) : null;
  if (first === null && last === null) return null;
  if (first === null) {
    if (last === 0 || size === 0) return "unsatisfiable" as const;
    const length = Math.min(last ?? 0, size);
    return { offset: size - length, length };
  }
  if (first >= size || (last !== null && last < first)) return "unsatisfiable" as const;
  const end = last === null ? size - 1 : Math.min(last, size - 1);
  return { offset: first, length: end - first + 1 };
}

/**
 * A meeting's recording, streamed, with byte ranges so the player can seek. The caller has
 * already checked the meeting's grants.
 */
export async function meetingFile(
  c: Context<AppEnv>,
  file: { r2Key: string; size: number; mimeType: string | null },
) {
  const range = byteRange(c.req.header("range"), file.size) ?? undefined;
  if (range === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${file.size}`, "cache-control": "private, no-store" },
    });
  }
  const object = await c.env.STORAGE_BUCKET.get(file.r2Key, range ? { range } : undefined);
  if (!object) return apiError(c, "not_found", "not found");
  const headers = new Headers({
    "content-type": file.mimeType ?? "audio/ogg",
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
  });
  if (!range) {
    headers.set("content-length", String(file.size));
    return new Response(object.body, { status: 200, headers });
  }
  headers.set("content-length", String(range.length));
  headers.set(
    "content-range",
    `bytes ${range.offset}-${range.offset + range.length - 1}/${file.size}`,
  );
  return new Response(object.body, { status: 206, headers });
}
