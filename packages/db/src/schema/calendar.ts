import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { members } from "./auth.ts";
import { createdAt, id, orgId, timestamptz, updatedAt } from "./columns.ts";
import { attachments, messages } from "./mail/messages.ts";
import { mailboxes } from "./mail/mailboxes.ts";

/**
 * The calendar's tables (`docs/spec/calendar.md`, "Data model"). Events from invitations are an
 * index of mail and converge on a re-sync; events made in Omni are the truth, like CRM rows.
 */

export const calendarEventSource = pgEnum("calendar_event_source", ["invite", "omni"]);
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

/** One per inbox, made the first time it is needed. Who sees it is who sees the inbox. */
export const calendarCalendars = pgTable(
  "calendar_calendars",
  {
    id: id(),
    orgId: orgId(),
    mailboxId: text("mailbox_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("calendar_calendars_mailbox_id_unique").on(t.mailboxId),
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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
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
