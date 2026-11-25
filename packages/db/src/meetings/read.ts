import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, lt, max, sql, type SQL } from "drizzle-orm";
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
import {
  NOT_FOUND,
  access,
  atLeast,
  reachable,
  withMeeting,
  type Ex,
  type MeetingsActor,
} from "./core.ts";

export const MEETINGS_PAGE_MAX = 100;

/** A meeting row as every reader sees it. */
export const meetingView = (m: typeof meetingsMeetings.$inferSelect) => ({
  id: m.id,
  title: m.title,
  startedAt: m.startedAt,
  endedAt: m.endedAt,
  durationMs: m.durationMs,
  event: m.eventUid ? { uid: m.eventUid, recurrenceId: m.eventRecurrenceId || null } : null,
  part: m.part,
  groupKey: m.groupKey,
  record:
    m.recordKind && m.recordId && m.recordKind !== "none"
      ? { kind: m.recordKind, id: m.recordId }
      : null,
  recordOff: m.recordKind === "none",
  status: m.status,
  language: m.language,
  recordedByMemberId: m.recordedByMemberId,
  failure: m.failure,
  hasAudio: m.audioNodeId !== null,
  hasVideo: m.videoNodeId !== null,
  notesNodeId: m.notesNodeId,
});

export type MeetingView = ReturnType<typeof meetingView>;

function talkShares(rows: { label: string; ms: number; turns: number }[]) {
  const total = rows.reduce((sum, r) => sum + r.ms, 0);
  return rows
    .map((r) => ({
      label: r.label,
      ms: r.ms,
      turns: r.turns,
      share: total ? Math.round((r.ms / total) * 1000) / 1000 : 0,
    }))
    .toSorted((a, b) => b.ms - a.ms);
}

const list = (from: SQL, row: SQL, order: SQL = sql``) =>
  sql`coalesce((select json_agg(${row}${order}) from ${from}), '[]'::json)`;

type Speaker = Omit<typeof meetingsSpeakers.$inferSelect, "orgId" | "meetingId">;
type Notes = typeof meetingsNotes.$inferSelect;
type Action = typeof meetingsActions.$inferSelect;
type Grant = Pick<typeof meetingsGrants.$inferSelect, "address" | "role">;

async function meetingParts(ex: Ex, meetingId: string) {
  const a = meetingsAttendees;
  const s = meetingsSpeakers;
  const n = meetingsNotes;
  const x = meetingsActions;
  const g = meetingsGrants;
  const seg = meetingsSegments;
  const [row] = await ex
    .select({
      attendees: sql<Array<{ address: string; name: string | null }>>`${list(
        sql`${a} where ${a.meetingId} = ${meetingId}`,
        sql`json_build_object('address', ${a.address}, 'name', ${a.name})`,
      )}`,
      speakers: sql<Speaker[]>`${list(
        sql`${s} where ${s.meetingId} = ${meetingId}`,
        sql`json_build_object('label', ${s.label}, 'name', ${s.name}, 'address', ${s.address}, 'source', ${s.source}, 'confidence', ${s.confidence})`,
      )}`,
      notes: sql<Pick<
        Notes,
        "summary" | "highlights" | "topics" | "decisions" | "questions" | "chapters"
      > | null>`(select json_build_object('summary', ${n.summary}, 'highlights', ${n.highlights}, 'topics', ${n.topics}, 'decisions', ${n.decisions}, 'questions', ${n.questions}, 'chapters', ${n.chapters}) from ${n} where ${n.meetingId} = ${meetingId})`,
      actions: sql<Array<Pick<Action, "id" | "kind" | "payload" | "state" | "taskId">>>`${list(
        sql`${x} where ${x.meetingId} = ${meetingId}`,
        sql`json_build_object('id', ${x.id}, 'kind', ${x.kind}, 'payload', ${x.payload}, 'state', ${x.state}, 'taskId', ${x.taskId})`,
        sql` order by ${x.seq}`,
      )}`,
      talk: sql<Array<{ label: string; ms: number; turns: number }>>`${list(
        sql`(select ${seg.speakerLabel} as label, sum(greatest(${seg.endMs} - ${seg.startMs}, 0))::int as ms, count(*)::int as turns from ${seg} where ${seg.meetingId} = ${meetingId} and ${seg.speakerLabel} is not null group by ${seg.speakerLabel}) t`,
        sql`json_build_object('label', t.label, 'ms', t.ms, 'turns', t.turns)`,
      )}`,
      grants: sql<Grant[]>`${list(
        sql`${g} where ${g.meetingId} = ${meetingId}`,
        sql`json_build_object('address', ${g.address}, 'role', ${g.role})`,
      )}`,
    })
    .from(sql`(select 1) as one`);
  if (!row) throw new Error("a select with no table answers one row");
  return row;
}

/**
 * One meeting with its people, speakers, notes and actions; sharing only for its editors. Who
 * may open it and what it holds are read side by side: two round trips in all, with the actor.
 */
export async function getMeeting(ex: Ex, actor: MeetingsActor | null, meetingId: string) {
  if (!actor) return NOT_FOUND;
  const [found, parts] = await Promise.all([
    access(ex, actor, meetingId),
    meetingParts(ex, meetingId),
  ]);
  if (!found) return NOT_FOUND;
  const { meeting, role } = found;
  const { attendees, speakers, notes, actions } = parts;
  const editor = atLeast(role, "editor");
  return {
    status: "ok",
    role,
    meeting: meetingView(meeting),
    sharing: editor
      ? {
          access: meeting.access,
          linkAccess: meeting.linkAccess,
          linkToken: meeting.linkToken,
          grants: parts.grants,
        }
      : null,
    attendees,
    speakers,
    notes,
    talk: talkShares(parts.talk),
    actions,
  } as const;
}

/** The transcript's turns, in order, read beside the check that the actor may open it. */
export async function getTranscript(ex: Ex, actor: MeetingsActor | null, meetingId: string) {
  if (!actor) return NOT_FOUND;
  const [found, segments] = await Promise.all([
    access(ex, actor, meetingId),
    ex
      .select({
        seq: meetingsSegments.seq,
        speaker: meetingsSegments.speakerLabel,
        startMs: meetingsSegments.startMs,
        endMs: meetingsSegments.endMs,
        text: meetingsSegments.text,
      })
      .from(meetingsSegments)
      .where(eq(meetingsSegments.meetingId, meetingId))
      .orderBy(asc(meetingsSegments.seq)),
  ]);
  if (!found) return NOT_FOUND;
  return { status: "ok", segments } as const;
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
    /** One calendar meeting's parts: its `UID` and instance key (`''` for a single event). */
    event?: { uid: string; recurrenceId: string };
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
        page.event
          ? and(eq(m.eventUid, page.event.uid), eq(m.eventRecurrenceId, page.event.recurrenceId))
          : undefined,
      ),
    )
    .orderBy(desc(m.startedAt))
    .limit(Math.min(Math.max(page.limit ?? 50, 1), MEETINGS_PAGE_MAX));
  return { status: "ok", meetings: rows.map(meetingView) } as const;
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
  const newest = (column: SQL | typeof m.id | typeof m.title) =>
    sql`(array_agg(${column} order by ${m.startedAt} desc))[1]`;
  const rows = await ex
    .select({
      groupKey: m.groupKey,
      meetings: count(),
      lastStartedAt: last,
      lastMeetingId: sql<string | null>`${newest(m.id)}`,
      lastTitle: sql<string | null>`${newest(m.title)}`,
    })
    .from(m)
    .where(reachable(actor))
    .groupBy(m.groupKey)
    .having(page.before ? lt(last, page.before) : undefined)
    .orderBy(desc(last))
    .limit(Math.min(Math.max(page.limit ?? 50, 1), MEETINGS_PAGE_MAX));
  return { status: "ok", groups: rows } as const;
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
      durationMs: m.durationMs,
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
    action: {
      id: action.id,
      meetingId: action.meetingId,
      kind: action.kind,
      payload: action.payload,
      state: action.state,
      taskId: action.taskId,
    },
  }));
}
