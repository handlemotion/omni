import type { Context } from "hono";
import type { AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";

const RANGE = /^bytes=(\d*)-(\d*)$/;

/**
 * A meeting's recording, streamed, with byte ranges so the player can seek. The caller has
 * already checked the meeting's grants.
 */
export async function meetingFile(
  c: Context<AppEnv>,
  file: { r2Key: string; size: number; mimeType: string | null },
) {
  const match = RANGE.exec(c.req.header("range") ?? "");
  const first = match?.[1] ? Number(match[1]) : null;
  const last = match?.[2] ? Number(match[2]) : null;
  const offset = first ?? (last !== null ? Math.max(0, file.size - last) : 0);
  const end = first !== null && last !== null ? Math.min(last, file.size - 1) : file.size - 1;
  const ranged = match !== null && (first !== null || last !== null);
  const length = Math.max(0, end - offset + 1);
  const range = ranged ? { offset, length } : undefined;
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
  headers.set("content-length", String(length));
  headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${file.size}`);
  return new Response(object.body, { status: 206, headers });
}
