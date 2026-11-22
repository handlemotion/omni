import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, inArray, lt, max, sql } from "drizzle-orm";
import {
  meetingsActions,
  meetingsAttendees,
  meetingsGrants,
  meetingsGroups,
  meetingsMeetings,
  meetingsNotes,
  meetingsSegments,
  meetingsSpeakers,
} from "../schema/meetings.ts";
import { NOT_FOUND, atLeast, reachable, withMeeting, type Ex, type MeetingsActor } from "./core.ts";

export const MEETINGS_PAGE_MAX = 100;

const view = (m: typeof meetingsMeetings.$inferSelect) => ({
  id: m.id,
  title: m.title,
  startedAt: m.startedAt,
  endedAt: m.endedAt,
  durationMs: m.durationMs,
  event: m.eventUid ? { uid: m.eventUid, recurrenceId: m.eventRecurrenceId || null } : null,
  part: m.part,
  groupKey: m.groupKey,
  record: m.recordKind && m.recordId ? { kind: m.recordKind, id: m.recordId } : null,
  status: m.status,
  language: m.language,
  recordedByMemberId: m.recordedByMemberId,
  failure: m.failure,
  hasAudio: m.audioNodeId !== null,
  notesNodeId: m.notesNodeId,
});

export type MeetingView = ReturnType<typeof view>;

/** One meeting with its people, speakers, notes and actions; sharing only for its editors. */
export function getMeeting(ex: Ex, actor: MeetingsActor | null, meetingId: string) {
  return withMeeting(ex, actor, meetingId, "viewer", async ({ meeting, role }) => {
    const [attendees, speakers, notes, actions] = await Promise.all([
      ex
        .select({ address: meetingsAttendees.address, name: meetingsAttendees.name })
        .from(meetingsAttendees)
        .where(eq(meetingsAttendees.meetingId, meetingId)),
      ex.select().from(meetingsSpeakers).where(eq(meetingsSpeakers.meetingId, meetingId)),
      ex.select().from(meetingsNotes).where(eq(meetingsNotes.meetingId, meetingId)),
      ex
        .select()
        .from(meetingsActions)
        .where(eq(meetingsActions.meetingId, meetingId))
        .orderBy(asc(meetingsActions.seq)),
    ]);
    const editor = atLeast(role, "editor");
    const grants = editor
      ? await ex
          .select({ address: meetingsGrants.address, role: meetingsGrants.role })
          .from(meetingsGrants)
          .where(eq(meetingsGrants.meetingId, meetingId))
      : null;
    return {
      status: "ok",
      role,
      meeting: view(meeting),
      sharing: editor
        ? {
            access: meeting.access,
            linkAccess: meeting.linkAccess,
            linkToken: meeting.linkToken,
            grants,
          }
        : null,
      attendees,
      speakers: speakers.map(({ orgId: _org, meetingId: _m, ...s }) => s),
      notes: notes[0]
        ? { summary: notes[0].summary, highlights: notes[0].highlights, topics: notes[0].topics }
        : null,
      actions: actions.map((a) => ({
        id: a.id,
        kind: a.kind,
        payload: a.payload,
        state: a.state,
        taskId: a.taskId,
      })),
    } as const;
  });
}

/** The transcript's turns, in order. */
export function getTranscript(ex: Ex, actor: MeetingsActor | null, meetingId: string) {
  return withMeeting(ex, actor, meetingId, "viewer", async () => {
    const segments = await ex
      .select({
        seq: meetingsSegments.seq,
        speaker: meetingsSegments.speakerLabel,
        startMs: meetingsSegments.startMs,
        endMs: meetingsSegments.endMs,
        text: meetingsSegments.text,
      })
      .from(meetingsSegments)
      .where(eq(meetingsSegments.meetingId, meetingId))
      .orderBy(asc(meetingsSegments.seq));
    return { status: "ok", segments } as const;
  });
}

/** The meetings the actor can open, newest first. */
export async function listMeetings(
  ex: Ex,
  actor: MeetingsActor | null,
  page: {
    before?: Date | null;
    limit?: number;
    groupKey?: string;
    record?: { kind: string; id: string };
  } = {},
) {
  if (!actor) return NOT_FOUND;
  const m = meetingsMeetings;
  const rows = await ex
    .select()
    .from(m)
    .where(
      and(
        reachable(actor),
        page.before ? lt(m.startedAt, page.before) : undefined,
        page.groupKey ? eq(m.groupKey, page.groupKey) : undefined,
        page.record
          ? and(eq(m.recordKind, page.record.kind), eq(m.recordId, page.record.id))
          : undefined,
      ),
    )
    .orderBy(desc(m.startedAt))
    .limit(Math.min(Math.max(page.limit ?? 50, 1), MEETINGS_PAGE_MAX));
  return { status: "ok", meetings: rows.map(view) } as const;
}

/** The sidebar: each group the actor has a meeting in, newest first, counting only theirs. */
export async function listGroups(
  ex: Ex,
  actor: MeetingsActor | null,
  page: { before?: Date | null; limit?: number } = {},
) {
  if (!actor) return NOT_FOUND;
  const m = meetingsMeetings;
  const last = max(m.startedAt);
  const rows = await ex
    .select({ groupKey: m.groupKey, meetings: count(), lastStartedAt: last })
    .from(m)
    .where(reachable(actor))
    .groupBy(m.groupKey)
    .having(page.before ? lt(last, page.before) : undefined)
    .orderBy(desc(last))
    .limit(Math.min(Math.max(page.limit ?? 50, 1), MEETINGS_PAGE_MAX));
  if (!rows.length) return { status: "ok", groups: [] } as const;
  const latest = await ex
    .selectDistinctOn([m.groupKey], { groupKey: m.groupKey, title: m.title, id: m.id })
    .from(m)
    .where(
      and(
        reachable(actor),
        inArray(
          m.groupKey,
          rows.map((r) => r.groupKey),
        ),
      ),
    )
    .orderBy(m.groupKey, desc(m.startedAt));
  const byKey = new Map(latest.map((l) => [l.groupKey, l]));
  return {
    status: "ok",
    groups: rows.map((r) => ({
      ...r,
      lastMeetingId: byKey.get(r.groupKey)?.id ?? null,
      lastTitle: byKey.get(r.groupKey)?.title ?? null,
    })),
  } as const;
}

/**
 * What a group's summary is made from for this reader: their meetings in it with notes, newest
 * first, and the key their summary is cached under (the group and exactly those meetings).
 */
export async function groupDigest(
  ex: Ex,
  actor: MeetingsActor | null,
  groupKey: string,
  limit = 12,
) {
  if (!actor) return NOT_FOUND;
  const m = meetingsMeetings;
  const rows = await ex
    .select({
      id: m.id,
      orgId: m.orgId,
      title: m.title,
      startedAt: m.startedAt,
      summary: meetingsNotes.summary,
      highlights: meetingsNotes.highlights,
    })
    .from(m)
    .innerJoin(meetingsNotes, eq(meetingsNotes.meetingId, m.id))
    .where(and(reachable(actor), eq(m.groupKey, groupKey)))
    .orderBy(desc(m.startedAt))
    .limit(limit);
  const [first] = rows;
  if (!first) return { status: "ok", meetings: [], meetingsHash: null, cached: null } as const;
  const meetingsHash = createHash("sha256")
    .update(
      rows
        .map((r) => r.id)
        .toSorted()
        .join(","),
    )
    .digest("hex");
  const [cached] = await ex
    .select({
      summary: meetingsGroups.summary,
      summarizedThrough: meetingsGroups.summarizedThrough,
    })
    .from(meetingsGroups)
    .where(
      and(
        eq(meetingsGroups.orgId, first.orgId),
        eq(meetingsGroups.groupKey, groupKey),
        eq(meetingsGroups.meetingsHash, meetingsHash),
      ),
    );
  return { status: "ok", meetings: rows, meetingsHash, cached: cached ?? null } as const;
}

/** Keeps a group summary for one exact set of meetings. */
export async function saveGroupSummary(
  ex: Ex,
  orgId: string,
  groupKey: string,
  meetingsHash: string,
  summary: string,
  summarizedThrough: Date,
) {
  await ex
    .insert(meetingsGroups)
    .values({ orgId, groupKey, meetingsHash, summary, summarizedThrough })
    .onConflictDoUpdate({
      target: [meetingsGroups.orgId, meetingsGroups.groupKey, meetingsGroups.meetingsHash],
      set: { summary, summarizedThrough },
    });
}

/** Full-text search over the transcripts the actor can open. */
export async function searchMeetings(
  ex: Ex,
  actor: MeetingsActor | null,
  query: string,
  limit = 20,
) {
  if (!actor) return NOT_FOUND;
  const q = query.trim();
  if (!q) return { status: "ok", hits: [] } as const;
  const tsq = sql`websearch_to_tsquery('simple', ${q})`;
  const hits = await ex
    .select({
      meetingId: meetingsSegments.meetingId,
      seq: meetingsSegments.seq,
      startMs: meetingsSegments.startMs,
      text: meetingsSegments.text,
      title: meetingsMeetings.title,
      startedAt: meetingsMeetings.startedAt,
    })
    .from(meetingsSegments)
    .innerJoin(meetingsMeetings, eq(meetingsMeetings.id, meetingsSegments.meetingId))
    .where(and(reachable(actor), sql`${meetingsSegments.search} @@ ${tsq}`))
    .orderBy(
      desc(sql`ts_rank(${meetingsSegments.search}, ${tsq})`),
      desc(meetingsMeetings.startedAt),
    )
    .limit(Math.min(Math.max(limit, 1), MEETINGS_PAGE_MAX));
  return { status: "ok", hits } as const;
}

/** One suggested action, with the meeting's title and the actor's role on that meeting. */
export async function getAction(ex: Ex, actor: MeetingsActor | null, actionId: string) {
  const [action] = await ex.select().from(meetingsActions).where(eq(meetingsActions.id, actionId));
  if (!action) return NOT_FOUND;
  return withMeeting(ex, actor, action.meetingId, "viewer", async ({ meeting, role }) => ({
    status: "ok" as const,
    role,
    meetingTitle: meeting.title,
    action: { id: action.id, kind: action.kind, payload: action.payload, state: action.state },
  }));
}
