// Mail's helpdesk (ADR 0021, ADR 0035): conversation events, notes, tags, canned replies, SLA
// policies, business hours and customers.
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { members } from "../auth.ts";
import { id, orgId, timestamptz, createdAt, updatedAt } from "../columns.ts";
import { conversationStatus, conversationPriority, conversationEventKind } from "./enums.ts";
import { mailboxes } from "./mailboxes.ts";
import { threads } from "./messages.ts";

/**
 * Who did what to a conversation, oldest first. Append-only, written in the same transaction as
 * the change it records; it drives the timeline, notifications and reports.
 */
export const conversationEvents = pgTable(
  "conversation_events",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    /** Null for the system (ingest, SLA cron, AI triage). */
    actorMemberId: text("actor_member_id").references(() => members.id, { onDelete: "set null" }),
    kind: conversationEventKind("kind").notNull(),
    /** Before and after, by kind: `{ from, to }` for status, priority and assignee. */
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Set for events a job may emit twice (SLA at risk and breached: the target and due time).
     * Unique per conversation, so a second run inserts nothing.
     */
    dedupeKey: text("dedupe_key"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "conversation_events_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
    index("conversation_events_thread_idx").on(t.threadId, t.createdAt),
    index("conversation_events_mailbox_report_idx").on(t.mailboxId, t.kind, t.createdAt),
    uniqueIndex("conversation_events_dedupe_unique")
      .on(t.threadId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null`),
  ],
);

/** Internal notes in a conversation's timeline. Never sent and never written to IMAP. */
export const notes = pgTable(
  "notes",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    authorMemberId: text("author_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    body: text("body").notNull(),
    /** Members @mentioned in the body (`members.id`). */
    mentions: text("mentions")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "notes_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
    index("notes_thread_idx").on(t.threadId, t.createdAt),
  ],
);

/** An inbox's tag list. Names are unique per inbox, ignoring case. */
export const tags = pgTable(
  "tags",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    name: text("name").notNull(),
    /** A token name from the design system, not a hex value. */
    color: text("color"),
    /** What the team files under the tag. Triage reads it to judge when the tag fits. */
    description: text("description"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "tags_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
    uniqueIndex("tags_mailbox_name_unique").on(t.mailboxId, sql`lower(${t.name})`),
  ],
);

export const threadTags = pgTable(
  "thread_tags",
  {
    orgId: orgId(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
    /** Null when AI triage or a canned reply added it. */
    addedByMemberId: text("added_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.tagId] }),
    // The "by tag" view starts from the tag.
    index("thread_tags_tag_idx").on(t.tagId, t.threadId),
  ],
);

/**
 * Reply templates with `{{customer.first_name}}`-style variables. An inbox's (`mailbox_id`) or one
 * member's own (`owner_member_id`), never both. Using one can also set status and add tags.
 */
export const cannedReplies = pgTable(
  "canned_replies",
  {
    id: id(),
    orgId: orgId(),
    mailboxId: text("mailbox_id"),
    ownerMemberId: text("owner_member_id").references(() => members.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    bodyText: text("body_text").notNull(),
    bodyHtml: text("body_html"),
    setStatus: conversationStatus("set_status"),
    addTagIds: text("add_tag_ids")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdByMemberId: text("created_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "canned_replies_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
    check(
      "canned_replies_one_owner",
      sql`(${t.mailboxId} is null) <> (${t.ownerMemberId} is null)`,
    ),
    index("canned_replies_mailbox_idx").on(t.mailboxId),
    index("canned_replies_owner_idx").on(t.ownerMemberId),
  ],
);

/**
 * An inbox's response targets for one priority, in minutes. A null target is not tracked. With
 * `business_hours_only`, time outside the inbox's `business_hours` does not count.
 */
export const slaPolicies = pgTable(
  "sla_policies",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    priority: conversationPriority("priority").notNull(),
    firstResponseMinutes: integer("first_response_minutes"),
    nextResponseMinutes: integer("next_response_minutes"),
    resolutionMinutes: integer("resolution_minutes"),
    businessHoursOnly: boolean("business_hours_only").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "sla_policies_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
    unique("sla_policies_mailbox_priority_unique").on(t.mailboxId, t.priority),
  ],
);

/** One weekly opening window: `day` 0 is Sunday; times are `HH:MM` in the inbox's zone. */
export interface BusinessHoursWindow {
  day: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  start: string;
  end: string;
}

/** When an inbox is staffed. One row per inbox; none means always open. */
export const businessHours = pgTable(
  "business_hours",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    /** IANA zone, e.g. `America/Mexico_City`. */
    timezone: text("timezone").notNull(),
    windows: jsonb("windows").$type<BusinessHoursWindow[]>().notNull().default([]),
    /** Closed all day, as `YYYY-MM-DD` in the inbox's zone. */
    holidays: date("holidays", { mode: "string" })
      .array()
      .notNull()
      .default(sql`'{}'::date[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "business_hours_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
    unique("business_hours_mailbox_unique").on(t.mailboxId),
  ],
);

/** The people who write to an org's inboxes, keyed by address. Filled on ingest. */
export const customers = pgTable(
  "customers",
  {
    id: id(),
    orgId: orgId(),
    /** Normalized: lowercase. */
    address: text("address").notNull(),
    name: text("name"),
    /** When the message that gave `name` was sent: a later name wins, whatever order mail is indexed in. */
    nameSeenAt: timestamptz("name_seen_at"),
    /** The address's domain, unless it is a webmail one; the company is guessed from it. */
    domain: text("domain"),
    company: text("company"),
    firstSeenAt: timestamptz("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("customers_org_address_unique").on(t.orgId, t.address),
    index("customers_org_domain_idx").on(t.orgId, t.domain),
  ],
);
