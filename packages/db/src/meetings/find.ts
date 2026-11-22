import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import {
  meetingsAttendees,
  meetingsMeetings,
  meetingsNotes,
  meetingsSegments,
  meetingsSpeakers,
} from "../schema/meetings.ts";
import { NOT_FOUND, reachable, type Ex, type MeetingsActor } from "./core.ts";
import { MEETINGS_PAGE_MAX } from "./read.ts";

export interface MeetingsFilter {
  /** Words in the transcript, the notes (summary, highlights, topics) or the title. */
  words?: string;
  /** Each must be in the meeting: an attendee or a speaker, by address or part of a name. */
  people?: string[];
  /** Started at or after. */
  from?: Date | null;
  /** Started before. */
  to?: Date | null;
  groupKey?: string;
  limit?: number;
}

const m = meetingsMeetings;

function withPerson(who: string) {
  const term = who.trim().toLowerCase();
  const like = `%${term.replaceAll(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return sql`(exists (select 1 from ${meetingsAttendees} a where a.meeting_id = ${m.id} and (a.address = ${term} or lower(a.name) like ${like}))
    or exists (select 1 from ${meetingsSpeakers} s where s.meeting_id = ${m.id} and (s.address = ${term} or lower(s.name) like ${like})))`;
}

/**
 * The meetings the actor can open that match every filter given, newest first. With words, each
 * carries the transcript turn that matches best (null when only the notes or title matched).
 */
export async function findMeetings(ex: Ex, actor: MeetingsActor | null, filter: MeetingsFilter) {
  if (!actor) return NOT_FOUND;
  const words = filter.words?.trim();
  const tsq = words ? sql`websearch_to_tsquery('simple', ${words})` : null;
  const notesText = sql`to_tsvector('simple', coalesce(${m.title}, '') || ' ' || coalesce((select n.summary || ' ' || n.highlights::text || ' ' || n.topics::text from ${meetingsNotes} n where n.meeting_id = ${m.id}), ''))`;
  const turn = tsq
    ? sql<{
        seq: number;
        speaker: string | null;
        speakerName: string | null;
        startMs: number;
        text: string;
      } | null>`(select json_build_object('seq', s.seq, 'speaker', s.speaker_label, 'speakerName', (select sp.name from ${meetingsSpeakers} sp where sp.meeting_id = s.meeting_id and sp.label = s.speaker_label), 'startMs', s.start_ms, 'text', s.text) from ${meetingsSegments} s where s.meeting_id = ${m.id} and s.search @@ ${tsq} order by ts_rank(s.search, ${tsq}) desc, s.seq limit 1)`
    : sql<null>`null`;
  const rows = await ex
    .select({ meeting: m, summary: meetingsNotes.summary, turn })
    .from(m)
    .leftJoin(meetingsNotes, eq(meetingsNotes.meetingId, m.id))
    .where(
      and(
        reachable(actor),
        filter.from ? gte(m.startedAt, filter.from) : undefined,
        filter.to ? lt(m.startedAt, filter.to) : undefined,
        filter.groupKey ? eq(m.groupKey, filter.groupKey) : undefined,
        ...(filter.people ?? []).filter((p) => p.trim()).map(withPerson),
        tsq
          ? sql`(exists (select 1 from ${meetingsSegments} s where s.meeting_id = ${m.id} and s.search @@ ${tsq}) or ${notesText} @@ ${tsq})`
          : undefined,
      ),
    )
    .orderBy(desc(m.startedAt), desc(m.id))
    .limit(Math.min(Math.max(filter.limit ?? 20, 1), MEETINGS_PAGE_MAX));
  return {
    status: "ok",
    meetings: rows.map((r) => ({
      id: r.meeting.id,
      title: r.meeting.title,
      startedAt: r.meeting.startedAt,
      endedAt: r.meeting.endedAt,
      durationMs: r.meeting.durationMs,
      groupKey: r.meeting.groupKey,
      status: r.meeting.status,
      summary: r.summary,
      turn: r.turn,
    })),
  } as const;
}
