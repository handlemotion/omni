import {
  meetingChunkQuerySchema,
  MEETINGS_MAX_CHUNK_BYTES,
  MEETINGS_MAX_CHUNKS,
  type MeetingChunksResponse,
} from "@omni/contracts";
import { meetingsPipeline } from "@omni/db";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context.ts";
import { apiError } from "../errors.ts";
import { zValidator } from "../validator.ts";
import { memberMeetings, refused } from "./http.ts";

/** Where one chunk's bytes live. The hash is in the key, so other bytes never overwrite them. */
export const chunkKey = (orgId: string, meetingId: string, seq: number, sha256: string) =>
  `${chunksPrefix(orgId, meetingId)}${String(seq).padStart(6, "0")}-${sha256}`;

export const chunksPrefix = (orgId: string, meetingId: string) =>
  `meetings/${orgId}/${meetingId}/chunks/`;

const SHA256 = /^[0-9a-f]{64}$/;

async function sha256Of(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readChunk(c: Context<AppEnv>) {
  const declared = (c.req.header("x-content-sha256") ?? "").toLowerCase();
  if (!SHA256.test(declared)) return null;
  const length = Number(c.req.header("content-length"));
  if (!Number.isInteger(length) || length <= 0 || length > MEETINGS_MAX_CHUNK_BYTES) return null;
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0 || bytes.byteLength > MEETINGS_MAX_CHUNK_BYTES) return null;
  return { bytes, sha256: declared, matches: (await sha256Of(bytes)) === declared };
}

/**
 * The browser recorder's upload (`docs/spec/meetings.md`, "The browser recorder"): each chunk is
 * stored in R2 and acknowledged on its own, so the recorder drops its local copy only once the
 * server has it, and a chunk sent twice is acknowledged twice and stored once.
 */
export const meetingChunks = new Hono<AppEnv>()
  .put("/:id/chunks/:seq{[0-9]+}", zValidator("query", meetingChunkQuerySchema), async (c) => {
    const meetingId = c.req.param("id");
    const seq = Number(c.req.param("seq"));
    const { endMs } = c.req.valid("query");
    if (seq >= MEETINGS_MAX_CHUNKS) {
      return apiError(c, "bad_request", `a recording has at most ${MEETINGS_MAX_CHUNKS} chunks`);
    }
    const found = await memberMeetings(c).recordedChunks(meetingId, { seq });
    if (found.status !== "ok") return refused(c, found);
    const chunk = await readChunk(c);
    if (!chunk) {
      return apiError(
        c,
        "bad_request",
        `a chunk is 1 to ${MEETINGS_MAX_CHUNK_BYTES} bytes with its SHA-256 in x-content-sha256`,
      );
    }
    if (!chunk.matches) {
      return apiError(c, "checksum_mismatch", "the bytes received do not match the sha256 sent");
    }
    const { orgId } = c.var.member;
    const pipeline = meetingsPipeline(c.var.db);
    const key = chunkKey(orgId, meetingId, seq, chunk.sha256);
    const held = found.chunk;
    if (!held) await c.env.STORAGE_BUCKET.put(key, chunk.bytes);
    const received = held
      ? held.sha256 === chunk.sha256
        ? "ok"
        : "conflict"
      : await pipeline.receiveChunk(meetingId, orgId, {
          seq,
          size: chunk.bytes.byteLength,
          sha256: chunk.sha256,
          endMs,
        });
    if (received === "ok") {
      return c.json({ chunk: { seq, size: chunk.bytes.byteLength, sha256: chunk.sha256, endMs } });
    }
    if (!held) await c.env.STORAGE_BUCKET.delete(key);
    if (received === "gone") return refused(c, { status: "not_found" });
    if (received === "conflict") {
      return apiError(c, "conflict", "a different chunk with that number was already received", {
        details: { reason: "chunk_conflict" },
      });
    }
    return apiError(c, "conflict", "the meeting is no longer recording", {
      details: { reason: "not_recording" },
    });
  })
  .get("/:id/chunks", async (c) => {
    const meetingId = c.req.param("id");
    const found = await memberMeetings(c).recordedChunks(meetingId);
    if (found.status !== "ok") return refused(c, found);
    return c.json({
      status: found.meetingStatus,
      chunks: found.chunks ?? [],
    } satisfies MeetingChunksResponse);
  });
