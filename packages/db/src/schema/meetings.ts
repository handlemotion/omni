import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { members } from "./auth.ts";
import { createdAt, id, orgId, timestamptz, tsvector, updatedAt } from "./columns.ts";
import { storageNodes } from "./storage.ts";

export const meetingsStatus = pgEnum("meetings_status", [
  "recording",
  "uploaded",
  "transcribing",
  "naming",
  "writing",
  "ready",
  "failed",
]);
export const meetingsAccess = pgEnum("meetings_access", ["restricted", "workspace"]);
export const meetingsLinkAccess = pgEnum("meetings_link_access", ["off", "signed_in", "anyone"]);
export const meetingsRole = pgEnum("meetings_role", ["owner", "editor", "viewer"]);
export const meetingsSpeakerSource = pgEnum("meetings_speaker_source", [
  "mic",
  "engine",
  "ai",
  "person",
]);
export const meetingsActionKind = pgEnum("meetings_action_kind", ["task", "email"]);
export const meetingsActionState = pgEnum("meetings_action_state", ["open", "done", "dismissed"]);

/**
 * One recorded meeting (`docs/spec/meetings.md`). The event is referenced by its iCalendar
 * identity and the CRM record by kind and id, with no foreign key into either module. A calendar
 * meeting is recorded once per workspace: a second recording of it is its next `part`.
 */
export const meetingsMeetings = pgTable(
  "meetings_meetings",
  {
    id: id(),
    orgId: orgId(),
    title: text("title"),
    startedAt: timestamptz("started_at").notNull().defaultNow(),
    endedAt: timestamptz("ended_at"),
    durationMs: integer("duration_ms"),
    eventUid: text("event_uid"),
    /** `''` for an event that does not repeat, so one recording per event holds for it too. */
    eventRecurrenceId: text("event_recurrence_id").notNull().default(""),
    part: integer("part").notNull().default(1),
    groupKey: text("group_key").notNull(),
    /** `company`, `person` or `deal`; `none` when a person took it off every record. */
    recordKind: text("record_kind"),
    recordId: text("record_id"),
    access: meetingsAccess("access").notNull().default("restricted"),
    linkAccess: meetingsLinkAccess("link_access").notNull().default("off"),
    linkToken: text("link_token"),
    recordedByMemberId: text("recorded_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    consentAt: timestamptz("consent_at").notNull(),
    status: meetingsStatus("status").notNull().default("recording"),
    language: text("language"),
    audioNodeId: text("audio_node_id").references(() => storageNodes.id, { onDelete: "set null" }),
    rawNodeId: text("raw_node_id").references(() => storageNodes.id, { onDelete: "set null" }),
    notesNodeId: text("notes_node_id").references(() => storageNodes.id, { onDelete: "set null" }),
    failure: text("failure"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("meetings_meetings_id_org_id_unique").on(t.id, t.orgId),
    uniqueIndex("meetings_meetings_event_part_unique")
      .on(t.orgId, t.eventUid, t.eventRecurrenceId, t.part)
      .where(sql`${t.eventUid} is not null`),
    uniqueIndex("meetings_meetings_link_token_unique").on(t.linkToken),
    index("meetings_meetings_group_idx").on(t.orgId, t.groupKey, t.startedAt.desc()),
    index("meetings_meetings_record_idx").on(t.orgId, t.recordKind, t.recordId),
    index("meetings_meetings_started_idx").on(t.orgId, t.startedAt.desc()),
    check("meetings_meetings_part_positive", sql`${t.part} >= 1`),
    check(
      "meetings_meetings_record_pair",
      sql`(${t.recordKind} is null) = (${t.recordId} is null)`,
    ),
  ],
);

const ofMeeting = (name: string) => (t: { meetingId: unknown; orgId: unknown }) =>
  foreignKey({
    name,
    columns: [t.meetingId as never, t.orgId as never],
    foreignColumns: [meetingsMeetings.id, meetingsMeetings.orgId],
  }).onDelete("cascade");

/** Who was invited, copied from the event at start or added on the page. */
export const meetingsAttendees = pgTable(
  "meetings_attendees",
  {
    meetingId: text("meeting_id").notNull(),
    orgId: orgId(),
    /** Lowercase. */
    address: text("address").notNull(),
    name: text("name"),
  },
  (t) => [
    primaryKey({ columns: [t.meetingId, t.address] }),
    ofMeeting("meetings_attendees_meeting_org_fk")(t),
    index("meetings_attendees_address_idx").on(t.orgId, t.address),
    index("meetings_attendees_domain_idx").on(t.orgId, sql`split_part(${t.address}, '@', 2)`),
  ],
);

/** Who a meeting is shared with, by address, in Drive's shape. Attendees get `viewer` at start. */
export const meetingsGrants = pgTable(
  "meetings_grants",
  {
    meetingId: text("meeting_id").notNull(),
    orgId: orgId(),
    /** Lowercase. */
    address: text("address").notNull(),
    role: meetingsRole("role").notNull(),
    grantedByMemberId: text("granted_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.meetingId, t.address] }),
    ofMeeting("meetings_grants_meeting_org_fk")(t),
    index("meetings_grants_address_idx").on(t.address),
  ],
);

/** A speaker as the engine labelled them, and who they turned out to be. */
export const meetingsSpeakers = pgTable(
  "meetings_speakers",
  {
    meetingId: text("meeting_id").notNull(),
    label: text("label").notNull(),
    orgId: orgId(),
    name: text("name"),
    address: text("address"),
    source: meetingsSpeakerSource("source"),
    confidence: real("confidence").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.meetingId, t.label] }),
    ofMeeting("meetings_speakers_meeting_org_fk")(t),
  ],
);

/** One turn of the transcript. Words and their times stay in the raw engine file. */
export const meetingsSegments = pgTable(
  "meetings_segments",
  {
    meetingId: text("meeting_id").notNull(),
    seq: integer("seq").notNull(),
    orgId: orgId(),
    speakerLabel: text("speaker_label"),
    startMs: integer("start_ms").notNull(),
    endMs: integer("end_ms").notNull(),
    text: text("text").notNull(),
    search: tsvector("search").generatedAlwaysAs(() => sql`to_tsvector('simple', text)`),
  },
  (t) => [
    primaryKey({ columns: [t.meetingId, t.seq] }),
    ofMeeting("meetings_segments_meeting_org_fk")(t),
    index("meetings_segments_search_idx").using("gin", t.search),
  ],
);

/** The AI's notes, written in one go once the transcript and speakers are saved. */
export const meetingsNotes = pgTable(
  "meetings_notes",
  {
    meetingId: text("meeting_id").primaryKey(),
    orgId: orgId(),
    summary: text("summary").notNull(),
    highlights: jsonb("highlights").$type<Array<{ text: string; atMs: number }>>().notNull(),
    topics: jsonb("topics").$type<string[]>().notNull(),
    model: text("model").notNull(),
    promptVersion: integer("prompt_version").notNull(),
    writtenToDocAt: timestamptz("written_to_doc_at"),
    createdAt: createdAt(),
  },
  (t) => [ofMeeting("meetings_notes_meeting_org_fk")(t)],
);

/** A task or follow-up email the notes suggested, until someone accepts or dismisses it. */
export const meetingsActions = pgTable(
  "meetings_actions",
  {
    id: id(),
    meetingId: text("meeting_id").notNull(),
    orgId: orgId(),
    seq: integer("seq").notNull(),
    kind: meetingsActionKind("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    state: meetingsActionState("state").notNull().default("open"),
    /** The calendar task an accepted task became. */
    taskId: text("task_id"),
    decidedByMemberId: text("decided_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    decidedAt: timestamptz("decided_at"),
  },
  (t) => [
    ofMeeting("meetings_actions_meeting_org_fk")(t),
    unique("meetings_actions_meeting_seq_unique").on(t.meetingId, t.seq),
    index("meetings_actions_task_idx")
      .on(t.orgId, t.taskId)
      .where(sql`${t.taskId} is not null`),
  ],
);

/**
 * A group's running summary, one per set of meetings a reader can open (`meetings_hash`), so no
 * reader gets one built from a meeting they cannot open.
 */
export const meetingsGroups = pgTable(
  "meetings_groups",
  {
    orgId: orgId(),
    groupKey: text("group_key").notNull(),
    meetingsHash: text("meetings_hash").notNull(),
    summary: text("summary").notNull(),
    summarizedThrough: timestamptz("summarized_through").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.orgId, t.groupKey, t.meetingsHash] })],
);

/** What makes each pipeline job safe to run twice: the engine's job and what the recorder sent. */
export const meetingsJobs = pgTable(
  "meetings_jobs",
  {
    meetingId: text("meeting_id").primaryKey(),
    orgId: orgId(),
    provider: text("provider"),
    providerJobId: text("provider_job_id"),
    micSpans: jsonb("mic_spans").$type<Array<{ startMs: number; endMs: number }> | null>(),
    cuts: jsonb("cuts").$type<Array<{ atMs: number; droppedMs: number }>>(),
    uploadId: text("upload_id"),
    /** How many chunks the recorder sent, as it said when it stopped; null for a Drive upload. */
    chunkCount: integer("chunk_count"),
    submittedAt: timestamptz("submitted_at"),
    polls: integer("polls").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [ofMeeting("meetings_jobs_meeting_org_fk")(t)],
);

/**
 * One piece of a recording as the browser sent it, acknowledged once its bytes are in R2 under
 * `meetings/<org>/<meeting>/chunks/<seq>`. The chunks in order are the recording until the
 * pipeline files them into the recorder's Drive as one file.
 */
export const meetingsChunks = pgTable(
  "meetings_chunks",
  {
    meetingId: text("meeting_id").notNull(),
    seq: integer("seq").notNull(),
    orgId: orgId(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    /** Where the chunk ends on the recording's clock, as the recorder measured it. */
    endMs: integer("end_ms").notNull(),
    receivedAt: timestamptz("received_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.meetingId, t.seq] }),
    ofMeeting("meetings_chunks_meeting_org_fk")(t),
    check("meetings_chunks_seq_nonnegative", sql`${t.seq} >= 0`),
  ],
);
