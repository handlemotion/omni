import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  meetingsMeetings,
  meetingsNotes,
  meetingsSegments,
  meetingsSpeakers,
} from "../schema/meetings.ts";
import { NOT_FOUND, reachable, withMeeting, type Ex, type MeetingsActor } from "./core.ts";
import { groupDigest } from "./read.ts";

/** A group's Ask reads the transcripts of this many meetings, those matching the question best. */
export const ASK_TRANSCRIPTS = 3;

/** A meeting as Ask reads it. Only ever one the asker can open. */
export interface AskSource {
  id: string;
  orgId: string;
  title: string | null;
  startedAt: Date;
  durationMs: number | null;
  summary: string | null;
  highlights: Array<{ text: string; atMs: number }>;
  transcript: {
    turns: Array<{ speaker: string | null; startMs: number; endMs: number; text: string }>;
    speakers: Array<{ label: string; name: string | null }>;
  } | null;
}

async function transcriptsOf(ex: Ex, meetingIds: string[]) {
  if (!meetingIds.length) return new Map<string, NonNullable<AskSource["transcript"]>>();
  const [segments, speakers] = await Promise.all([
    ex
      .select()
      .from(meetingsSegments)
      .where(inArray(meetingsSegments.meetingId, meetingIds))
      .orderBy(asc(meetingsSegments.meetingId), asc(meetingsSegments.seq)),
    ex
      .select({
        meetingId: meetingsSpeakers.meetingId,
        label: meetingsSpeakers.label,
        name: meetingsSpeakers.name,
      })
      .from(meetingsSpeakers)
      .where(inArray(meetingsSpeakers.meetingId, meetingIds)),
  ]);
  const byMeeting = new Map<string, NonNullable<AskSource["transcript"]>>(
    meetingIds.map((id) => [id, { turns: [], speakers: [] }]),
  );
  for (const s of segments) {
    byMeeting.get(s.meetingId)?.turns.push({
      speaker: s.speakerLabel,
      startMs: s.startMs,
      endMs: s.endMs,
      text: s.text,
    });
  }
  for (const s of speakers) byMeeting.get(s.meetingId)?.speakers.push(s);
  return byMeeting;
}

/** One meeting the actor can open, with its notes and its whole transcript. */
export function askOneMeeting(ex: Ex, actor: MeetingsActor | null, meetingId: string) {
  return withMeeting(ex, actor, meetingId, "viewer", async ({ meeting }) => {
    const [notes] = await ex
      .select()
      .from(meetingsNotes)
      .where(eq(meetingsNotes.meetingId, meetingId));
    const transcript = (await transcriptsOf(ex, [meetingId])).get(meetingId) ?? null;
    const source: AskSource = {
      id: meeting.id,
      orgId: meeting.orgId,
      title: meeting.title,
      startedAt: meeting.startedAt,
      durationMs: meeting.durationMs,
      summary: notes?.summary || null,
      highlights: notes?.highlights ?? [],
      transcript: transcript?.turns.length ? transcript : null,
    };
    return { status: "ok", meetings: [source] } as const;
  });
}

/** The question's words as a Postgres `simple` query matching any of them; null with none. */
export function anyWordQuery(question: string) {
  const words = [...new Set(question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 20);
  return words.length ? words.join(" | ") : null;
}

/**
 * A group's meetings for one asker: only those they can open, with notes, newest first (the
 * same set their group summary reads), and the transcripts of the few whose words match the
 * question best.
 */
export async function askGroupMeetings(
  ex: Ex,
  actor: MeetingsActor | null,
  groupKey: string,
  question: string,
) {
  if (!actor) return NOT_FOUND;
  const digest = await groupDigest(ex, actor, groupKey);
  if (digest.status !== "ok") return digest;
  if (!digest.meetings.length) return NOT_FOUND;
  const ids = digest.meetings.map((m) => m.id);
  const words = anyWordQuery(question);
  const tsq = sql`to_tsquery('simple', ${words ?? ""})`;
  const best = words
    ? await ex
        .select({ id: meetingsSegments.meetingId })
        .from(meetingsSegments)
        .innerJoin(meetingsMeetings, eq(meetingsMeetings.id, meetingsSegments.meetingId))
        .where(
          and(
            inArray(meetingsSegments.meetingId, ids),
            reachable(actor),
            sql`${meetingsSegments.search} @@ ${tsq}`,
          ),
        )
        .groupBy(meetingsSegments.meetingId)
        .orderBy(desc(sql`sum(ts_rank(${meetingsSegments.search}, ${tsq}))`))
        .limit(ASK_TRANSCRIPTS)
    : [];
  const transcripts = await transcriptsOf(
    ex,
    best.map((b) => b.id),
  );
  const meetings: AskSource[] = digest.meetings.map((m) => ({
    id: m.id,
    orgId: m.orgId,
    title: m.title,
    startedAt: m.startedAt,
    durationMs: m.durationMs,
    summary: m.summary || null,
    highlights: m.highlights,
    transcript: transcripts.get(m.id) ?? null,
  }));
  return { status: "ok", meetings } as const;
}
