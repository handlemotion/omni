import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { members } from "./auth.ts";
import { createdAt, id, memberId, orgId, timestamptz, updatedAt } from "./columns.ts";
import { attachments, messages } from "./mail/messages.ts";
import { mailboxes } from "./mail/mailboxes.ts";

/**
 * The calendar's tables (`docs/spec/calendar.md`, "Data model"). Events from invitations are an
 * index of mail and converge on a re-sync; events made in Omni are the truth, like CRM rows.
 * An event comes from an invitation in mail, from Omni, or from a connected Google account's own
 * calendar ("Google calendars").
 */
export const calendarEventSource = pgEnum("calendar_event_source", ["invite", "omni", "google"]);
export const calendarEventStatus = pgEnum("calendar_event_status", [
  "confirmed",
  "tentative",
  "cancelled",
]);
export const calendarAttendeeRole = pgEnum("calendar_attendee_role", [
  "chair",
  "required",
  "optional",
  "none",
]);
export const calendarResponse = pgEnum("calendar_response", [
  "needs_action",
  "accepted",
  "declined",
  "tentative",
  "delegated",
]);
/** What one `text/calendar` part did when the sweep applied it. */
export const calendarPartOutcome = pgEnum("calendar_part_outcome", [
  "applied",
  "stale",
  "ignored",
  "invalid",
]);

/**
 * An inbox's calendars. Every inbox has its own (`google_id` null), made the first time it is
 * needed, which mail's invitations and Omni's events land on and which shows a Gmail account's
 * primary Google calendar. A Gmail inbox also has one per other calendar in its Google calendar
 * list, read only in Omni ("Google calendars"). Who sees a calendar is who sees the inbox.
 */
export const calendarCalendars = pgTable(
  "calendar_calendars",
  {
    id: id(),
    orgId: orgId(),
    mailboxId: text("mailbox_id").notNull(),
    /** The calendar's id in its Google account; null for the inbox's own calendar. */
    googleId: text("google_id"),
    /** Google's name for it; null for the inbox's own calendar, named after the inbox. */
    name: text("name"),
    /** Google's colour for it, `#rrggbb`: the default when a member picked none. */
    color: text("color"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("calendar_calendars_mailbox_id_unique").on(t.mailboxId),
    unique("calendar_calendars_mailbox_google_unique")
      .on(t.mailboxId, t.googleId)
      .nullsNotDistinct(),
    unique("calendar_calendars_id_org_id_unique").on(t.id, t.orgId),
    foreignKey({
      name: "calendar_calendars_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
  ],
);

/**
 * One event, a series, or one changed instance of a series (`recurrence_id`). The iCalendar
 * identity is (`uid`, `recurrence_id`) on its calendar; `(sequence, dtstamp)` orders versions.
 */
export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: id(),
    orgId: orgId(),
    calendarId: text("calendar_id").notNull(),
    uid: text("uid").notNull(),
    /** The original start of the instance a changed instance replaces; null otherwise. */
    recurrenceId: timestamptz("recurrence_id"),
    sequence: integer("sequence").notNull().default(0),
    dtstamp: timestamptz("dtstamp"),
    source: calendarEventSource("source").notNull(),
    status: calendarEventStatus("status").notNull().default("confirmed"),
    busy: boolean("busy").notNull().default(true),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    conferenceUrl: text("conference_url"),
    startsAt: timestamptz("starts_at").notNull(),
    endsAt: timestamptz("ends_at").notNull(),
    allDay: boolean("all_day").notNull().default(false),
    /** `YYYY-MM-DD` of an all-day event; `end_day` is exclusive. */
    startDay: text("start_day"),
    endDay: text("end_day"),
    timeZone: text("time_zone"),
    rrule: text("rrule"),
    exdates: timestamptz("exdates")
      .array()
      .notNull()
      .default(sql`'{}'::timestamptz[]`),
    rdates: timestamptz("rdates")
      .array()
      .notNull()
      .default(sql`'{}'::timestamptz[]`),
    /** A series' last end; null for a series that never ends. An event's own end otherwise. */
    recursUntil: timestamptz("recurs_until"),
    organizerAddress: text("organizer_address"),
    organizerName: text("organizer_name"),
    /** The message that last set it. A pruned message leaves the event; a re-sync sets it again. */
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    createdByMemberId: text("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    /**
     * The event's id in a connected Google calendar, when Google has it: a deleted event comes
     * back from Google with nothing else to find it by.
     */
    googleId: text("google_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("calendar_events_google_id_idx")
      .on(t.calendarId, t.googleId)
      .where(sql`${t.googleId} is not null`),
    unique("calendar_events_identity_unique")
      .on(t.calendarId, t.uid, t.recurrenceId)
      .nullsNotDistinct(),
    foreignKey({
      name: "calendar_events_calendar_org_fk",
      columns: [t.calendarId, t.orgId],
      foreignColumns: [calendarCalendars.id, calendarCalendars.orgId],
    }).onDelete("cascade"),
    index("calendar_events_window_idx")
      .on(t.calendarId, t.startsAt)
      .where(sql`${t.rrule} is null`),
    index("calendar_events_series_idx")
      .on(t.calendarId, t.recursUntil)
      .where(sql`${t.rrule} is not null`),
    index("calendar_events_message_id_idx").on(t.messageId),
  ],
);

/** Who an event invites, and each one's answer. The inbox's own address is "me". */
export const calendarAttendees = pgTable(
  "calendar_attendees",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => calendarEvents.id, { onDelete: "cascade" }),
    orgId: orgId(),
    /** Normalized as mail stores addresses. */
    address: text("address").notNull(),
    name: text("name"),
    role: calendarAttendeeRole("role").notNull().default("required"),
    response: calendarResponse("response").notNull().default("needs_action"),
    /** The `DTSTAMP` the answer came with: a later one wins. */
    respondedAt: timestamptz("responded_at"),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.address] }),
    index("calendar_attendees_address_idx").on(t.orgId, t.address),
  ],
);

/**
 * Each attendee's own answer to an event (`REPLY`, or an answer given in Omni), kept apart from
 * the event so it is not lost when it arrives first: a version of the event takes, per attendee,
 * whichever is later, its own `PARTSTAT` or this. Mail applied in any order converges.
 */
export const calendarAnswers = pgTable(
  "calendar_answers",
  {
    orgId: orgId(),
    calendarId: text("calendar_id")
      .notNull()
      .references(() => calendarCalendars.id, { onDelete: "cascade" }),
    uid: text("uid").notNull(),
    recurrenceId: timestamptz("recurrence_id"),
    address: text("address").notNull(),
    response: calendarResponse("response").notNull(),
    answeredAt: timestamptz("answered_at").notNull(),
  },
  (t) => [
    unique("calendar_answers_identity_unique")
      .on(t.calendarId, t.uid, t.recurrenceId, t.address)
      .nullsNotDistinct(),
  ],
);

/** What each `text/calendar` attachment did, so applying it twice changes nothing. */
export const calendarParts = pgTable(
  "calendar_parts",
  {
    attachmentId: text("attachment_id")
      .primaryKey()
      .references(() => attachments.id, { onDelete: "cascade" }),
    orgId: orgId(),
    calendarId: text("calendar_id").references(() => calendarCalendars.id, {
      onDelete: "cascade",
    }),
    method: text("method"),
    uid: text("uid"),
    outcome: calendarPartOutcome("outcome").notNull(),
    reason: text("reason"),
    processedAt: timestamptz("processed_at").notNull().defaultNow(),
  },
  (t) => [index("calendar_parts_calendar_uid_idx").on(t.calendarId, t.uid)],
);

/** The sweep's place in mail's calendar attachments: the last one it read. */
export const calendarSweep = pgTable("calendar_sweep", {
  name: text("name").primaryKey(),
  cursorAt: timestamptz("cursor_at").notNull(),
  cursorId: text("cursor_id").notNull(),
  updatedAt: updatedAt(),
});

/** How one person shows a calendar: its color and whether it is on. Theirs alone. */
export const calendarMemberPrefs = pgTable(
  "calendar_member_prefs",
  {
    memberId: text("member_id")
      .notNull()
      .references(() => members.id, { onDelete: "cascade" }),
    calendarId: text("calendar_id")
      .notNull()
      .references(() => calendarCalendars.id, { onDelete: "cascade" }),
    orgId: orgId(),
    color: text("color"),
    hidden: boolean("hidden").notNull().default(false),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.memberId, t.calendarId] })],
);

/** What a task can be on in the CRM. The CRM checks the record; the calendar keeps only its id. */
export const calendarTaskRecordKind = pgEnum("calendar_task_record_kind", [
  "company",
  "person",
  "deal",
]);

/**
 * A to-do (`docs/spec/calendar.md`, "Tasks"). Private to its owner while it is on no record; on a
 * CRM record it is the workspace's, seen by whoever can open that record, and assignable. The
 * record is kept as a kind and an id, with no key into the CRM's tables: the CRM deletes a
 * record's tasks through the calendar's surface. Open while `completed_at` is null.
 */
export const calendarTasks = pgTable(
  "calendar_tasks",
  {
    id: id(),
    orgId: orgId(),
    /** Cascades: a removed member's private tasks go with them; their linked ones are let go first. */
    ownerMemberId: text("owner_member_id").references(() => members.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body"),
    /** Its checklist, in order: each step's own id, its text, and whether it is done. */
    subtasks: jsonb("subtasks")
      .$type<{ id: string; title: string; done: boolean }[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    dueAt: timestamptz("due_at"),
    completedAt: timestamptz("completed_at"),
    completedByMemberId: text("completed_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    assigneeMemberId: text("assignee_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    recordKind: calendarTaskRecordKind("record_kind"),
    recordId: text("record_id"),
    createdByMemberId: text("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("calendar_tasks_record_whole", sql`(${t.recordKind} is null) = (${t.recordId} is null)`),
    check(
      "calendar_tasks_private_is_owned",
      sql`${t.recordKind} is not null or (${t.ownerMemberId} is not null and (${t.assigneeMemberId} is null or ${t.assigneeMemberId} = ${t.ownerMemberId}))`,
    ),
    index("calendar_tasks_owner_open_due_idx")
      .on(t.ownerMemberId, t.dueAt.asc().nullsLast(), t.id)
      .where(sql`${t.completedAt} is null`),
    index("calendar_tasks_assignee_open_due_idx")
      .on(t.assigneeMemberId, t.dueAt.asc().nullsLast(), t.id)
      .where(sql`${t.completedAt} is null`),
    index("calendar_tasks_record_idx").on(t.orgId, t.recordKind, t.recordId),
    index("calendar_tasks_org_open_due_idx")
      .on(t.orgId, t.dueAt.asc().nullsLast(), t.id)
      .where(sql`${t.completedAt} is null and ${t.recordKind} is not null`),
    index("calendar_tasks_completed_by_member_id_idx").on(t.completedByMemberId),
    index("calendar_tasks_created_by_member_id_idx").on(t.createdByMemberId),
  ],
);

/**
 * Where a Gmail inbox's calendar stands with Google's (`events.list`): the sync token of the
 * last finished pass, or the page a pass stopped at. A full pass started at `full_sync_started_at`;
 * when it finishes, Google events it did not see are gone from Google and leave the calendar.
 * Losing this row only costs one full pass.
 */
export const calendarGoogleSync = pgTable("calendar_google_sync", {
  calendarId: text("calendar_id")
    .primaryKey()
    .references(() => calendarCalendars.id, { onDelete: "cascade" }),
  orgId: orgId(),
  syncToken: text("sync_token"),
  pageToken: text("page_token"),
  fullSyncStartedAt: timestamptz("full_sync_started_at"),
  /**
   * Cancelled instances whose series the pass has not reached yet (Google lists events in no set
   * order), applied once it has; what is still waiting when the pass ends had no series.
   */
  waiting: jsonb("waiting")
    .$type<{ googleId: string; seriesGoogleId: string; recurrenceId: string }[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  /** `ok`, or why Google would not answer: `no_access` (no calendar scope, API off, revoked). */
  state: text("state").notNull().default("ok"),
  nextSyncAt: timestamptz("next_sync_at").notNull().defaultNow(),
  syncedAt: timestamptz("synced_at"),
  updatedAt: updatedAt(),
});

/**
 * A booking link (`docs/spec/calendar.md`, "Booking links"): a public page where a visitor picks a
 * free slot and books a meeting with its owner. It never shows what fills the owner's time, only
 * the slots left. A booking lands on `calendar_id` (an inbox its owner can send from), which
 * invites the visitor by mail. Busy is every calendar the owner can open. `slug` is the link's
 * public name; deleting the row closes it.
 */
export const calendarBookingLinks = pgTable(
  "calendar_booking_links",
  {
    id: id(),
    orgId: orgId(),
    memberId: memberId(),
    calendarId: text("calendar_id").notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    timeZone: text("time_zone").notNull(),
    /** Days of the week it takes meetings; 0 is Sunday. */
    weekdays: integer("weekdays")
      .array()
      .notNull()
      .default(sql`'{1,2,3,4,5}'::integer[]`),
    /** Minutes after midnight, in `time_zone`, the day opens and closes. */
    startMinute: integer("start_minute").notNull().default(540),
    endMinute: integer("end_minute").notNull().default(1020),
    noticeMinutes: integer("notice_minutes").notNull().default(240),
    horizonDays: integer("horizon_days").notNull().default(14),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("calendar_booking_links_slug_unique").on(t.slug),
    index("calendar_booking_links_member_idx").on(t.memberId),
    foreignKey({
      name: "calendar_booking_links_calendar_org_fk",
      columns: [t.calendarId, t.orgId],
      foreignColumns: [calendarCalendars.id, calendarCalendars.orgId],
    }).onDelete("cascade"),
    check(
      "calendar_booking_links_hours",
      sql`${t.startMinute} >= 0 and ${t.endMinute} <= 1440 and ${t.startMinute} < ${t.endMinute}`,
    ),
    check(
      "calendar_booking_links_duration",
      sql`${t.durationMinutes} between 5 and 480 and ${t.horizonDays} between 1 and 60`,
    ),
  ],
);
