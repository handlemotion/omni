import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { meetingsActions, meetingsJobs, meetingsMeetings } from "../schema/meetings.ts";
import { groupKeyFor, NOT_FOUND, type MeetingsActor } from "./core.ts";
import { saveNotes, saveTranscript } from "./pipeline.ts";
import { shareWithAttendees } from "./write.ts";

/**
 * A meeting another notetaker recorded, as `@omni/ai`'s `importForeignMeeting` reads it. It has
 * no audio: it is its transcript and its notes (`docs/spec/meetings.md`, "Importing").
 */
export interface ImportMeeting {
  /** The notetaker it came from, such as `circleback`, and its id there. */
  source: string;
  sourceId: string;
  title: string | null;
  startedAt: Date;
  durationMs: number;
  attendees: Array<{ address: string; name: string | null }>;
  turns: Array<{ speaker: string | null; startMs: number; endMs: number; text: string }>;
  speakers: Array<{ label: string; name: string | null; address: string | null }>;
  notes: {
    summary: string;
    topics: string[];
    chapters: Array<{ title: string; startMs: number; points: string[] }>;
  } | null;
  actions: Array<{ payload: Record<string, unknown>; done: boolean }>;
}

/**
 * Files an imported meeting as the member's own, already `ready`, through the same writers the
 * pipeline saves a transcript and notes with. Keyed by where it came from
 * (`meetings_jobs.provider`, `provider_job_id`): importing it again answers the first import's
 * meeting and changes nothing, two imports at once included.
 */
export async function importMeeting(ex: Db, actor: MeetingsActor | null, input: ImportMeeting) {
  const member = actor?.member;
  if (!actor || !member) return NOT_FOUND;
  await ex.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`meetings-import:${member.orgId}:${input.source}:${input.sourceId}`}, 0))`,
  );
  const [existing] = await ex
    .select({ id: meetingsJobs.meetingId })
    .from(meetingsJobs)
    .where(
      and(
        eq(meetingsJobs.orgId, member.orgId),
        eq(meetingsJobs.provider, input.source),
        eq(meetingsJobs.providerJobId, input.sourceId),
      ),
    )
    .limit(1);
  if (existing) return { status: "ok", meetingId: existing.id, created: false } as const;

  const endedAt = new Date(input.startedAt.getTime() + input.durationMs);
  const [meeting] = await ex
    .insert(meetingsMeetings)
    .values({
      orgId: member.orgId,
      title: input.title,
      startedAt: input.startedAt,
      endedAt,
      durationMs: input.durationMs,
      groupKey: "pending",
      recordedByMemberId: member.id,
      consentAt: input.startedAt,
      status: "transcribing",
    })
    .returning({ id: meetingsMeetings.id });
  if (!meeting) throw new Error("the imported meeting was not saved");
  const meetingId = meeting.id;
  await ex
    .update(meetingsMeetings)
    .set({
      groupKey: groupKeyFor({
        meetingId,
        eventUid: null,
        recurring: false,
        attendees: input.attendees.map((a) => a.address),
        ownDomains: actor.addresses.map((a) => a.split("@")[1] ?? ""),
      }),
    })
    .where(eq(meetingsMeetings.id, meetingId));
  await shareWithAttendees(ex, actor, member, meetingId, input.attendees);
  await ex.insert(meetingsJobs).values({
    meetingId,
    orgId: member.orgId,
    provider: input.source,
    providerJobId: input.sourceId,
  });

  await saveTranscript(ex, meetingId, member.orgId, {
    language: null,
    durationMs: input.durationMs,
    rawNodeId: null,
    turns: input.turns,
    speakers: input.speakers.map((s) => ({
      ...s,
      source: s.name ? ("engine" as const) : null,
      confidence: s.name ? 1 : 0,
    })),
  });
  await ex
    .update(meetingsMeetings)
    .set({ status: "writing" })
    .where(eq(meetingsMeetings.id, meetingId));
  await saveNotes(ex, meetingId, member.orgId, {
    title: null,
    summary: input.notes?.summary ?? "",
    highlights: [],
    topics: input.notes?.topics ?? [],
    chapters: input.notes?.chapters ?? [],
    actions: input.actions.map((a) => ({ kind: "task" as const, payload: a.payload })),
    model: input.source,
    promptVersion: 0,
  });
  const done = input.actions.flatMap((a, seq) => (a.done ? [seq] : []));
  for (const seq of done) {
    await ex
      .update(meetingsActions)
      .set({ state: "done", decidedAt: new Date() })
      .where(and(eq(meetingsActions.meetingId, meetingId), eq(meetingsActions.seq, seq)));
  }
  return { status: "ok", meetingId, created: true } as const;
}
