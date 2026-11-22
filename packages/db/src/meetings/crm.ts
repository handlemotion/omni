import { and, desc, eq, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import {
  meetingsActions,
  meetingsAttendees,
  meetingsMeetings,
  meetingsNotes,
} from "../schema/meetings.ts";
import { NOT_FOUND, reachable, withMeeting, WEBMAIL, type Ex, type MeetingsActor } from "./core.ts";
import { MEETINGS_PAGE_MAX, meetingView } from "./read.ts";

/** A CRM record as Meetings keeps it: by kind and id, with no foreign key into the CRM. */
export type MeetingRecordKind = "company" | "person" | "deal";
export interface MeetingRecord {
  kind: MeetingRecordKind;
  id: string;
}

/** What `record_kind` holds once a person took a meeting off every record. */
export const NO_RECORD = "none";

/**
 * Which meetings a CRM record shows, as the CRM worked them out: the record itself, and the
 * addresses and domains its people are reached at. `only` keeps the meetings a person has not
 * put on another record or taken off every one, as a deal's tab does.
 */
export interface MeetingsOnQuery {
  record: MeetingRecord;
  addresses: string[];
  domains: string[];
  only?: "unplaced";
  before?: { startedAt: Date; id: string } | null;
  limit?: number;
}

const lower = (values: string[]) => [...new Set(values.map((v) => v.trim().toLowerCase()))];

function withAttendees(orgId: string | null, addresses: string[], domains: string[]) {
  const a = meetingsAttendees;
  const ways: SQL[] = [];
  if (addresses.length) ways.push(inArray(a.address, addresses));
  if (domains.length) ways.push(inArray(sql`split_part(${a.address}, '@', 2)`, domains));
  if (!ways.length) return null;
  return inArray(
    meetingsMeetings.id,
    sql`(select ${a.meetingId} from ${a} where ${and(orgId ? eq(a.orgId, orgId) : undefined, or(...ways))})`,
  );
}

/**
 * The meetings the actor can open that are on a CRM record: put on it, or with someone from it
 * among the attendees (unless placed elsewhere, for `only: "unplaced"`). Newest first, each with
 * its summary and how many of its actions are open. The CRM checks the record first; this only
 * ever narrows what the actor could already open.
 */
export async function meetingsOn(ex: Ex, actor: MeetingsActor | null, query: MeetingsOnQuery) {
  if (!actor) return NOT_FOUND;
  const m = meetingsMeetings;
  const domains = lower(query.domains).filter((d) => d && !WEBMAIL.has(d));
  const byPeople = withAttendees(actor.scopeOrgId, lower(query.addresses), domains);
  const placed = and(eq(m.recordKind, query.record.kind), eq(m.recordId, query.record.id));
  const met =
    byPeople && (query.only === "unplaced" ? and(isNull(m.recordKind), byPeople) : byPeople);
  const before = query.before;
  const limit = Math.min(Math.max(query.limit ?? 30, 1), MEETINGS_PAGE_MAX);
  const openActions = sql<number>`(select count(*)::int from ${meetingsActions} a where a.meeting_id = ${m.id} and a.state = 'open')`;
  const rows = await ex
    .select({ meeting: m, summary: meetingsNotes.summary, openActions })
    .from(m)
    .leftJoin(meetingsNotes, eq(meetingsNotes.meetingId, m.id))
    .where(
      and(
        reachable(actor),
        met ? or(placed, met) : placed,
        before
          ? or(
              lt(m.startedAt, before.startedAt),
              and(eq(m.startedAt, before.startedAt), lt(m.id, before.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(m.startedAt), desc(m.id))
    .limit(limit);
  return {
    status: "ok" as const,
    meetings: rows.map((r) => ({
      ...meetingView(r.meeting),
      summary: r.summary ?? null,
      openActions: Number(r.openActions ?? 0),
      placed: r.meeting.recordKind === query.record.kind && r.meeting.recordId === query.record.id,
    })),
  };
}

/**
 * Puts a meeting on one CRM record, or takes it off every record (`null`), so the CRM no longer
 * places it by its people. Its editors. The CRM checks the record exists and the actor can open
 * it before calling this.
 */
export function setRecord(
  ex: Ex,
  actor: MeetingsActor | null,
  meetingId: string,
  record: MeetingRecord | null,
) {
  return withMeeting(ex, actor, meetingId, "editor", async () => {
    await ex
      .update(meetingsMeetings)
      .set({ recordKind: record?.kind ?? NO_RECORD, recordId: record?.id ?? "" })
      .where(eq(meetingsMeetings.id, meetingId));
    return { status: "ok" } as const;
  });
}

/**
 * The meeting a calendar task was accepted from, when the actor can open it; `not_found`
 * otherwise, so a task never tells who cannot open the meeting that it came from one.
 */
export async function meetingOfTask(ex: Ex, actor: MeetingsActor | null, taskId: string) {
  if (!actor?.scopeOrgId) return NOT_FOUND;
  const [action] = await ex
    .select({ id: meetingsActions.id, meetingId: meetingsActions.meetingId })
    .from(meetingsActions)
    .where(and(eq(meetingsActions.orgId, actor.scopeOrgId), eq(meetingsActions.taskId, taskId)))
    .limit(1);
  if (!action) return NOT_FOUND;
  return withMeeting(ex, actor, action.meetingId, "viewer", async ({ meeting }) => ({
    status: "ok" as const,
    actionId: action.id,
    meeting: meetingView(meeting),
  }));
}
