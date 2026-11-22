import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { members, users } from "../schema/auth.ts";
import {
  meetingsActions,
  meetingsAttendees,
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
  audioNodeId: string;
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
    .set({ micSpans: stop.micSpans, cuts: stop.cuts })
    .where(eq(meetingsJobs.meetingId, meetingId));
  return true;
}

export async function setUpload(ex: Ex, meetingId: string, uploadId: string) {
  await ex.update(meetingsJobs).set({ uploadId }).where(eq(meetingsJobs.meetingId, meetingId));
}

/** The engine's job, once submitted. A retry that finds it set polls instead of paying again. */
export async function setEngineJob(
  ex: Ex,
  meetingId: string,
  provider: string,
  providerJobId: string,
) {
  await ex
    .update(meetingsJobs)
    .set({ provider, providerJobId, submittedAt: new Date() })
    .where(and(eq(meetingsJobs.meetingId, meetingId), sql`${meetingsJobs.providerJobId} is null`));
}

export async function countPoll(ex: Ex, meetingId: string) {
  const [row] = await ex
    .update(meetingsJobs)
    .set({ polls: sql`${meetingsJobs.polls} + 1` })
    .where(eq(meetingsJobs.meetingId, meetingId))
    .returning({ polls: meetingsJobs.polls });
  return row?.polls ?? 0;
}

export async function fail(ex: Ex, meetingId: string, failure: string) {
  await ex
    .update(meetingsMeetings)
    .set({ status: "failed", failure: failure.slice(0, 500) })
    .where(eq(meetingsMeetings.id, meetingId));
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

/**
 * Replaces the meeting's transcript and speakers in one go and moves it to `naming`. A speaker a
 * person already named keeps that name, so working speakers out again never undoes a rename.
 */
export async function saveTranscript(
  ex: Ex,
  meetingId: string,
  orgId: string,
  saved: SavedTranscript,
) {
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

/** The notes and their actions, once: a second run keeps the first. Moves the meeting to `ready`. */
export async function saveNotes(ex: Ex, meetingId: string, orgId: string, notes: SavedNotes) {
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
