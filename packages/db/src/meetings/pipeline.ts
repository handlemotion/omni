import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { members, users } from "../schema/auth.ts";
import { userEmails } from "../schema/identity.ts";
import {
  meetingsActions,
  meetingsAttendees,
  meetingsGrants,
  meetingsJobs,
  meetingsMeetings,
  meetingsNotes,
  meetingsSegments,
  meetingsSpeakers,
  meetingsStatus,
} from "../schema/meetings.ts";
import type { Ex } from "./core.ts";

export type MeetingStatus = (typeof meetingsStatus.enumValues)[number];

export interface StoppedRecording {
  endedAt: Date;
  durationMs: number;
  /** The recording as one Drive file, or null when it came as chunks (`chunkCount`). */
  audioNodeId: string | null;
  chunkCount: number | null;
  micSpans: Array<{ startMs: number; endMs: number }> | null;
  cuts: Array<{ atMs: number; droppedMs: number }>;
}

/** Moves a meeting from one status to the next; false when it was not in `from` (a retry, or a race). */
export async function advance(ex: Ex, meetingId: string, from: MeetingStatus[], to: MeetingStatus) {
  const rows = await ex
    .update(meetingsMeetings)
    .set({ status: to, failure: null })
    .where(and(eq(meetingsMeetings.id, meetingId), inArray(meetingsMeetings.status, from)))
    .returning({ id: meetingsMeetings.id });
  return rows.length > 0;
}

/** Records the stop. Only a meeting still recording stops; a second stop changes nothing. */
export async function stopRecording(ex: Ex, meetingId: string, stop: StoppedRecording) {
  const rows = await ex
    .update(meetingsMeetings)
    .set({
      status: "uploaded",
      endedAt: stop.endedAt,
      durationMs: stop.durationMs,
      audioNodeId: stop.audioNodeId,
    })
    .where(and(eq(meetingsMeetings.id, meetingId), eq(meetingsMeetings.status, "recording")))
    .returning({ id: meetingsMeetings.id });
  if (!rows.length) return false;
  await ex
    .update(meetingsJobs)
    .set({ micSpans: stop.micSpans, cuts: stop.cuts, chunkCount: stop.chunkCount })
    .where(eq(meetingsJobs.meetingId, meetingId));
  return true;
}

/**
 * The engine's job, once submitted. A retry that finds it set polls instead of paying again.
 * False when it was not kept: the meeting was deleted meanwhile, or another delivery's job is
 * already set. The caller then asks the engine to forget this one, so no audio stays there.
 */
export async function setEngineJob(
  ex: Ex,
  meetingId: string,
  provider: string,
  providerJobId: string,
) {
  const rows = await ex
    .update(meetingsJobs)
    .set({ provider, providerJobId })
    .where(and(eq(meetingsJobs.meetingId, meetingId), sql`${meetingsJobs.providerJobId} is null`))
    .returning({ id: meetingsJobs.meetingId });
  return rows.length > 0;
}

export async function countPoll(ex: Ex, meetingId: string) {
  const [row] = await ex
    .update(meetingsJobs)
    .set({ polls: sql`${meetingsJobs.polls} + 1` })
    .where(eq(meetingsJobs.meetingId, meetingId))
    .returning({ polls: meetingsJobs.polls });
  return row?.polls ?? 0;
}

/**
 * Marks the meeting failed, only while it is still at the status the failing step started from:
 * a stale delivery's failure never undoes another delivery's progress.
 */
export async function fail(ex: Ex, meetingId: string, failure: string, from: MeetingStatus[]) {
  const rows = await ex
    .update(meetingsMeetings)
    .set({ status: "failed", failure: failure.slice(0, 500) })
    .where(and(eq(meetingsMeetings.id, meetingId), inArray(meetingsMeetings.status, from)))
    .returning({ id: meetingsMeetings.id });
  return rows.length > 0;
}

/** Everything a job needs about one meeting: the row, its job, its people and its recorder. */
export async function meetingForJob(ex: Ex, meetingId: string) {
  const [row] = await ex
    .select({
      meeting: meetingsMeetings,
      job: meetingsJobs,
      recorderName: users.name,
      recorderAddress: users.email,
    })
    .from(meetingsMeetings)
    .innerJoin(meetingsJobs, eq(meetingsJobs.meetingId, meetingsMeetings.id))
    .leftJoin(members, eq(members.id, meetingsMeetings.recordedByMemberId))
    .leftJoin(users, eq(users.id, members.userId))
    .where(eq(meetingsMeetings.id, meetingId));
  if (!row) return null;
  const [attendees, speakers, segments] = await Promise.all([
    ex
      .select({ address: meetingsAttendees.address, name: meetingsAttendees.name })
      .from(meetingsAttendees)
      .where(eq(meetingsAttendees.meetingId, meetingId)),
    ex.select().from(meetingsSpeakers).where(eq(meetingsSpeakers.meetingId, meetingId)),
    ex
      .select()
      .from(meetingsSegments)
      .where(eq(meetingsSegments.meetingId, meetingId))
      .orderBy(asc(meetingsSegments.seq)),
  ]);
  return {
    ...row,
    recorder: row.recorderAddress
      ? { address: row.recorderAddress.toLowerCase(), name: row.recorderName }
      : null,
    attendees,
    speakers,
    segments,
  };
}

export interface SavedTranscript {
  language: string | null;
  durationMs: number;
  rawNodeId: string | null;
  turns: Array<{ speaker: string | null; startMs: number; endMs: number; text: string }>;
  speakers: Array<{
    label: string;
    name: string | null;
    address: string | null;
    source: "mic" | "engine" | "ai" | "person" | null;
    confidence: number;
  }>;
}

async function lockStatus(ex: Ex, meetingId: string) {
  const [row] = await ex
    .select({ status: meetingsMeetings.status })
    .from(meetingsMeetings)
    .where(eq(meetingsMeetings.id, meetingId))
    .for("update");
  return row?.status ?? "gone";
}

/**
 * Replaces the meeting's transcript and speakers in one go and moves it to `naming`, only while
 * it is `transcribing`: a second delivery of the poll that fetched the same result never sends a
 * meeting that moved on back to `naming`. A speaker a person already named keeps that name, so
 * working speakers out again never undoes a rename. Answers `saved`, `moved_on` or `gone`.
 */
export async function saveTranscript(
  ex: Ex,
  meetingId: string,
  orgId: string,
  saved: SavedTranscript,
) {
  const status = await lockStatus(ex, meetingId);
  if (status === "gone") return "gone" as const;
  if (status !== "transcribing") return "moved_on" as const;
  const renamed = await ex
    .select()
    .from(meetingsSpeakers)
    .where(and(eq(meetingsSpeakers.meetingId, meetingId), eq(meetingsSpeakers.source, "person")));
  const byPerson = new Map(renamed.map((s) => [s.label, s]));
  await ex.delete(meetingsSegments).where(eq(meetingsSegments.meetingId, meetingId));
  await ex.delete(meetingsSpeakers).where(eq(meetingsSpeakers.meetingId, meetingId));
  for (let i = 0; i < saved.turns.length; i += 1000) {
    await ex.insert(meetingsSegments).values(
      saved.turns.slice(i, i + 1000).map((t, j) => ({
        meetingId,
        orgId,
        seq: i + j,
        speakerLabel: t.speaker,
        startMs: t.startMs,
        endMs: t.endMs,
        text: t.text,
      })),
    );
  }
  if (saved.speakers.length) {
    await ex.insert(meetingsSpeakers).values(
      saved.speakers.map((s) => {
        const kept = byPerson.get(s.label);
        return kept
          ? { ...kept }
          : {
              meetingId,
              orgId,
              label: s.label,
              name: s.name,
              address: s.address,
              source: s.source,
              confidence: s.confidence,
            };
      }),
    );
  }
  await ex
    .update(meetingsMeetings)
    .set({
      language: saved.language,
      durationMs: saved.durationMs,
      rawNodeId: saved.rawNodeId,
      status: "naming",
      failure: null,
    })
    .where(eq(meetingsMeetings.id, meetingId));
  return "saved" as const;
}

/** Names from the names pass, only for speakers still without one. */
export async function nameSpeakers(
  ex: Ex,
  meetingId: string,
  named: Array<{ label: string; name: string | null; address: string | null; confidence: number }>,
) {
  for (const s of named) {
    await ex
      .update(meetingsSpeakers)
      .set({ name: s.name, address: s.address, source: "ai", confidence: s.confidence })
      .where(
        and(
          eq(meetingsSpeakers.meetingId, meetingId),
          eq(meetingsSpeakers.label, s.label),
          sql`${meetingsSpeakers.name} is null`,
        ),
      );
  }
}

export interface SavedNotes {
  title: string | null;
  summary: string;
  highlights: Array<{ text: string; atMs: number }>;
  topics: string[];
  actions: Array<{ kind: "task" | "email"; payload: Record<string, unknown> }>;
  model: string;
  promptVersion: number;
}

/**
 * The notes and their actions, once, while the meeting is `writing`: a second run keeps the
 * first, and a run that finds it already `ready` (or deleted) writes nothing. Moves it to `ready`.
 */
export async function saveNotes(ex: Ex, meetingId: string, orgId: string, notes: SavedNotes) {
  if ((await lockStatus(ex, meetingId)) !== "writing") return false;
  await ex
    .insert(meetingsNotes)
    .values({
      meetingId,
      orgId,
      summary: notes.summary,
      highlights: notes.highlights,
      topics: notes.topics,
      model: notes.model,
      promptVersion: notes.promptVersion,
    })
    .onConflictDoNothing();
  if (notes.actions.length) {
    await ex
      .insert(meetingsActions)
      .values(
        notes.actions.map((a, seq) => ({
          meetingId,
          orgId,
          seq,
          kind: a.kind,
          payload: a.payload,
        })),
      )
      .onConflictDoNothing();
  }
  await ex
    .update(meetingsMeetings)
    .set({
      status: "ready",
      failure: null,
      ...(notes.title ? { title: sql`coalesce(${meetingsMeetings.title}, ${notes.title})` } : {}),
    })
    .where(eq(meetingsMeetings.id, meetingId));
  return true;
}

/** True once: the first caller writes the notes into the doc, a retry skips it. */
export async function claimDocWrite(ex: Ex, meetingId: string) {
  const rows = await ex
    .update(meetingsNotes)
    .set({ writtenToDocAt: new Date() })
    .where(
      and(eq(meetingsNotes.meetingId, meetingId), sql`${meetingsNotes.writtenToDocAt} is null`),
    )
    .returning({ id: meetingsNotes.meetingId });
  return rows.length > 0;
}

export async function setFiles(
  ex: Ex,
  meetingId: string,
  files: { notesNodeId?: string; groupKey?: string },
) {
  await ex.update(meetingsMeetings).set(files).where(eq(meetingsMeetings.id, meetingId));
}

/** The workspace's members who can open the meeting now: who its realtime events go to. */
export async function memberAudience(ex: Ex, meetingId: string) {
  const [meeting] = await ex
    .select()
    .from(meetingsMeetings)
    .where(eq(meetingsMeetings.id, meetingId));
  if (!meeting) return [];
  const [people, grants] = await Promise.all([
    ex
      .select({
        id: members.id,
        role: members.role,
        email: users.email,
        verified: users.emailVerified,
        extra: userEmails.email,
      })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .leftJoin(userEmails, eq(userEmails.userId, users.id))
      .where(eq(members.organizationId, meeting.orgId)),
    ex
      .select({ address: meetingsGrants.address })
      .from(meetingsGrants)
      .where(eq(meetingsGrants.meetingId, meetingId)),
  ]);
  const granted = new Set(grants.map((g) => g.address));
  const reach = new Set<string>();
  for (const p of people) {
    const teammate = p.role.split(",").some((r) => r.trim() !== "freelancer");
    const addresses = [p.verified ? p.email : null, p.extra]
      .filter((a): a is string => !!a)
      .map((a) => a.toLowerCase());
    if (
      p.id === meeting.recordedByMemberId ||
      (teammate && meeting.access === "workspace") ||
      addresses.some((a) => granted.has(a))
    ) {
      reach.add(p.id);
    }
  }
  return [...reach];
}

/**
 * Picks a failed meeting up again from what it already has: without a transcript it goes back to
 * `uploaded` with the engine's job and polls cleared, so the audio is sent again; with one, to
 * `naming`. Null when the meeting had not failed.
 */
export async function restartFailed(ex: Ex, meetingId: string) {
  const [segment] = await ex
    .select({ seq: meetingsSegments.seq })
    .from(meetingsSegments)
    .where(eq(meetingsSegments.meetingId, meetingId))
    .limit(1);
  const to: MeetingStatus = segment ? "naming" : "uploaded";
  if (!(await advance(ex, meetingId, ["failed"], to))) return null;
  if (to === "uploaded") {
    await ex
      .update(meetingsJobs)
      .set({ provider: null, providerJobId: null, submittedAt: null, polls: 0, attempts: 0 })
      .where(eq(meetingsJobs.meetingId, meetingId));
  } else {
    await ex.update(meetingsJobs).set({ attempts: 0 }).where(eq(meetingsJobs.meetingId, meetingId));
  }
  return to;
}

/**
 * Meetings part way through the pipeline that nothing has touched for `olderThanMs`: a step's
 * hand-off to the queue was lost. The minute sweep sends each one again; the step it runs comes
 * from the saved status.
 */
export async function stalled(ex: Ex, olderThanMs: number, limit = 50) {
  const before = new Date(Date.now() - olderThanMs).toISOString();
  return ex
    .select({ id: meetingsMeetings.id, orgId: meetingsMeetings.orgId })
    .from(meetingsMeetings)
    .innerJoin(meetingsJobs, eq(meetingsJobs.meetingId, meetingsMeetings.id))
    .where(
      and(
        inArray(meetingsMeetings.status, ["uploaded", "transcribing", "naming", "writing"]),
        sql`greatest(${meetingsMeetings.updatedAt}, ${meetingsJobs.updatedAt}) < ${before}::timestamptz`,
      ),
    )
    .limit(limit);
}

/** Marks a stalled meeting as just sent again, so the sweep waits before sending it once more. */
export async function nudged(ex: Ex, meetingId: string) {
  await ex
    .update(meetingsJobs)
    .set({ updatedAt: new Date() })
    .where(eq(meetingsJobs.meetingId, meetingId));
}

/**
 * Counts one failed try of the meeting's current step and marks the job as just touched, so the
 * sweep leaves it to the queue's retry. The count lives on the meeting, not on a queue message,
 * so a step the sweep sends again still stops at the same cap. Answers the count so far.
 */
export async function failedAttempt(ex: Ex, meetingId: string) {
  const [row] = await ex
    .update(meetingsJobs)
    .set({ attempts: sql`${meetingsJobs.attempts} + 1` })
    .where(eq(meetingsJobs.meetingId, meetingId))
    .returning({ attempts: meetingsJobs.attempts });
  return row?.attempts ?? 0;
}

/** A step went through: the next failure starts counting from zero again. */
export async function succeeded(ex: Ex, meetingId: string) {
  await ex
    .update(meetingsJobs)
    .set({ attempts: 0 })
    .where(and(eq(meetingsJobs.meetingId, meetingId), sql`${meetingsJobs.attempts} > 0`));
}

/**
 * How long a claim to send a recording to the engine holds before another step may take it:
 * longer than the engine's upload may take (`ENGINE_UPLOAD_MS` in the Worker), so a slow upload
 * is never sent a second time.
 */
export const SUBMIT_CLAIM_MS = 20 * 60_000;

/**
 * Claims sending the meeting's recording to the engine, so two deliveries of a step never both
 * send it (and pay twice). True for the one that may send; a claim left by a step that died
 * expires after `SUBMIT_CLAIM_MS`.
 */
export async function claimSubmission(ex: Ex, meetingId: string) {
  const expired = new Date(Date.now() - SUBMIT_CLAIM_MS).toISOString();
  const rows = await ex
    .update(meetingsJobs)
    .set({ submittedAt: new Date() })
    .where(
      and(
        eq(meetingsJobs.meetingId, meetingId),
        sql`${meetingsJobs.providerJobId} is null`,
        sql`(${meetingsJobs.submittedAt} is null or ${meetingsJobs.submittedAt} < ${expired}::timestamptz)`,
      ),
    )
    .returning({ id: meetingsJobs.meetingId });
  return rows.length > 0;
}

/**
 * Lets go of a claim whose send failed, so the step's retry claims again and counts against the
 * same retries instead of waiting out the claim.
 */
export async function releaseSubmission(ex: Ex, meetingId: string) {
  await ex
    .update(meetingsJobs)
    .set({ submittedAt: null })
    .where(and(eq(meetingsJobs.meetingId, meetingId), sql`${meetingsJobs.providerJobId} is null`));
}
