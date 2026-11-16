// Platform (ADR 0035): a member's preferences, their phones, and their notifications.
import { sql } from "drizzle-orm";
import { index, integer, jsonb, pgEnum, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { members } from "./auth.ts";
import { id, orgId, memberId, timestamptz, createdAt, updatedAt } from "./columns.ts";
import { notes } from "./mail/helpdesk.ts";
import { threads } from "./mail/messages.ts";

export const notificationKind = pgEnum("notification_kind", [
  "assigned",
  "mention",
  "customer_reply",
  "sla_at_risk",
  "sla_breached",
  /** A teammate left a note on a shared conversation you take part in (assignee, earlier notes). */
  "note",
  /** Someone joined your workspace; no thread. `actor_member_id` is the new member. */
  "member_joined",
]);

export const theme = pgEnum("theme", ["system", "light", "dark"]);

export const pushTokens = pgTable(
  "push_tokens",
  {
    id: id(),
    orgId: orgId(),
    memberId: memberId(),
    expoToken: text("expo_token").notNull(),
    device: text("device"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("push_tokens_expo_token_unique").on(t.expoToken),
    index("push_tokens_member_id_idx").on(t.memberId),
  ],
);

/** Where one notification kind reaches a member. */
export interface NotificationChannels {
  realtime: boolean;
  desktop: boolean;
  push: boolean;
}

/** A member's settings. No row means every default. */
export const memberPreferences = pgTable("member_preferences", {
  memberId: text("member_id")
    .primaryKey()
    .references(() => members.id, { onDelete: "cascade" }),
  orgId: orgId(),
  /** Per notification kind; a kind left out uses the default (all channels on). */
  notifications: jsonb("notifications")
    .$type<Partial<Record<(typeof notificationKind.enumValues)[number], NotificationChannels>>>()
    .notNull()
    .default({}),
  theme: theme("theme").notNull().default("system"),
  /** How long a send can be undone (Rodrigo, Nov 12: 5 seconds by default). 0 sends at once. */
  undoSendSeconds: integer("undo_send_seconds").notNull().default(5),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Something a member should know about: assigned to them, mentioned, a note on a conversation
 * they take part in, their customer replied, an SLA at risk, a new teammate. `thread_id` is null
 * for workspace notifications. `dedupe_key` makes a job that runs twice notify once.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    orgId: orgId(),
    memberId: memberId(),
    kind: notificationKind("kind").notNull(),
    threadId: text("thread_id").references(() => threads.id, { onDelete: "cascade" }),
    noteId: text("note_id").references(() => notes.id, { onDelete: "cascade" }),
    actorMemberId: text("actor_member_id").references(() => members.id, { onDelete: "set null" }),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    dedupeKey: text("dedupe_key"),
    readAt: timestamptz("read_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("notifications_member_idx").on(
      t.memberId,
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    index("notifications_member_unread_idx")
      .on(t.memberId)
      .where(sql`${t.readAt} is null`),
    uniqueIndex("notifications_member_dedupe_unique")
      .on(t.memberId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
    index("notifications_thread_idx").on(t.threadId),
  ],
);
