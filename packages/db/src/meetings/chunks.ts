import { and, asc, eq, lt, sql } from "drizzle-orm";
import { meetingsChunks, meetingsJobs, meetingsMeetings } from "../schema/meetings.ts";
import type { Ex } from "./core.ts";

/** One chunk as the recorder sent it. */
export interface Chunk {
  seq: number;
  size: number;
  sha256: string;
  endMs: number;
}

/**
 * A recording that has sent no chunk for this long has stopped being recorded (the tab closed,
 * the computer slept, the network is down): someone else may record the same event as its next
 * part. The first recording keeps its chunks and still finishes when its recorder comes back.
 */
export const RECORDING_STALE_MS = 3 * 60_000;

/**
 * Records a chunk whose bytes are already in R2, while the meeting is still recording. A chunk
 * sent again with the same bytes is acknowledged again, whatever the meeting's status, so a
 * recorder that never saw the first answer can carry on; the same number with other bytes is a
 * `conflict`. The meeting's row is locked so a stop cannot slip in between the check and the write.
 */
export async function receiveChunk(ex: Ex, meetingId: string, orgId: string, chunk: Chunk) {
  const [meeting] = await ex
    .select({ status: meetingsMeetings.status })
    .from(meetingsMeetings)
    .where(and(eq(meetingsMeetings.id, meetingId), eq(meetingsMeetings.orgId, orgId)))
    .for("update");
  const [held] = await ex
    .select({ sha256: meetingsChunks.sha256 })
    .from(meetingsChunks)
    .where(and(eq(meetingsChunks.meetingId, meetingId), eq(meetingsChunks.seq, chunk.seq)));
  if (held) return held.sha256 === chunk.sha256 ? ("ok" as const) : ("conflict" as const);
  if (!meeting) return "gone" as const;
  if (meeting.status !== "recording") return "not_recording" as const;
  await ex.insert(meetingsChunks).values({ meetingId, orgId, ...chunk });
  return "ok" as const;
}

/** The chunks the server holds for a meeting, in order. */
export async function chunksOf(ex: Ex, meetingId: string, below?: number | null) {
  return ex
    .select({
      seq: meetingsChunks.seq,
      size: meetingsChunks.size,
      sha256: meetingsChunks.sha256,
      endMs: meetingsChunks.endMs,
    })
    .from(meetingsChunks)
    .where(
      and(
        eq(meetingsChunks.meetingId, meetingId),
        below === null || below === undefined ? undefined : lt(meetingsChunks.seq, below),
      ),
    )
    .orderBy(asc(meetingsChunks.seq));
}

/** One chunk the server holds, or null. */
export async function chunkAt(ex: Ex, meetingId: string, seq: number) {
  const [row] = await ex
    .select({ seq: meetingsChunks.seq, sha256: meetingsChunks.sha256 })
    .from(meetingsChunks)
    .where(and(eq(meetingsChunks.meetingId, meetingId), eq(meetingsChunks.seq, seq)));
  return row ?? null;
}

/** The numbers below `count` the server has no chunk for, at most `limit` of them. */
export async function missingChunks(ex: Ex, meetingId: string, count: number, limit = 100) {
  const held = await ex
    .select({ seq: meetingsChunks.seq })
    .from(meetingsChunks)
    .where(and(eq(meetingsChunks.meetingId, meetingId), lt(meetingsChunks.seq, count)));
  const have = new Set(held.map((r) => r.seq));
  const missing: number[] = [];
  for (let seq = 0; seq < count && missing.length < limit; seq++) {
    if (!have.has(seq)) missing.push(seq);
  }
  return missing;
}

const lastChunk = sql`(select max(${meetingsChunks.receivedAt}) from ${meetingsChunks}
   where ${meetingsChunks.meetingId} = ${meetingsMeetings.id})`;

/**
 * Whether a recording still counts as recording for Record: one sending chunks (the browser) is
 * while its last chunk arrived within `RECORDING_STALE_MS`; one that sends none while it records
 * (the desktop app, which uploads at stop) always is.
 */
export const recentlyHeard = (now = new Date()) =>
  sql<boolean>`coalesce(${lastChunk} >= ${new Date(now.getTime() - RECORDING_STALE_MS).toISOString()}::timestamptz, true)`;

/**
 * Recordings sent as chunks whose last chunk is older than `olderThanMs`: the recorder never came
 * back to stop them. The sweep stops each with the chunks it has, so what was said is
 * transcribed. A recording with no chunk is the desktop app's, finished from its spool, and is
 * never touched here.
 */
export async function abandoned(ex: Ex, olderThanMs: number, limit = 20) {
  const before = new Date(Date.now() - olderThanMs).toISOString();
  return ex
    .select({
      id: meetingsMeetings.id,
      orgId: meetingsMeetings.orgId,
      recordedByMemberId: meetingsMeetings.recordedByMemberId,
    })
    .from(meetingsMeetings)
    .where(
      and(eq(meetingsMeetings.status, "recording"), sql`${lastChunk} < ${before}::timestamptz`),
    )
    .limit(limit);
}

/**
 * Claims the Drive upload the chunks are filed through. False when another delivery's upload is
 * already set: the caller lets go of its own and uses that one.
 */
export async function claimUpload(ex: Ex, meetingId: string, uploadId: string) {
  const rows = await ex
    .update(meetingsJobs)
    .set({ uploadId })
    .where(and(eq(meetingsJobs.meetingId, meetingId), sql`${meetingsJobs.uploadId} is null`))
    .returning({ id: meetingsJobs.meetingId });
  return rows.length > 0;
}

/** Forgets an upload Drive no longer has (it expired), so filing opens a new one. */
export async function dropUpload(ex: Ex, meetingId: string, uploadId: string) {
  await ex
    .update(meetingsJobs)
    .set({ uploadId: null })
    .where(and(eq(meetingsJobs.meetingId, meetingId), eq(meetingsJobs.uploadId, uploadId)));
}

/**
 * Sets the recording's Drive file once the chunks are filed. `gone` when the meeting was deleted
 * meanwhile (the caller trashes the file); `kept` when another delivery's file is already set.
 */
export async function setAudio(ex: Ex, meetingId: string, audioNodeId: string) {
  const [row] = await ex
    .select({ audioNodeId: meetingsMeetings.audioNodeId })
    .from(meetingsMeetings)
    .where(eq(meetingsMeetings.id, meetingId))
    .for("update");
  if (!row) return "gone" as const;
  if (row.audioNodeId && row.audioNodeId !== audioNodeId) return "kept" as const;
  await ex.update(meetingsMeetings).set({ audioNodeId }).where(eq(meetingsMeetings.id, meetingId));
  return "set" as const;
}
