import { sql, type SQL } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { members } from "../auth.ts";
import { id, orgId, memberId, timestamptz, createdAt, updatedAt, tsvector } from "../columns.ts";
import { triageBucket, triageSource, conversationStatus, conversationPriority } from "./enums.ts";
import { customers } from "./helpdesk.ts";
import { type ForwardedMessage, type Address, mailboxes, mailboxFolders } from "./mailboxes.ts";

export const threads = pgTable(
  "threads",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    subjectKey: text("subject_key").notNull(),
    lastMessageAt: timestamptz("last_message_at").notNull(),
    archived: boolean("archived").notNull().default(false),
    triage: triageBucket("triage"),
    triageConfidence: real("triage_confidence"),
    triageSource: triageSource("triage_source"),
    /**
     * The message the triage describes: the thread's latest message when it was triaged. A job for
     * that message again skips the model, and a newer message re-triages even a person's re-sort.
     * A re-sort sets it to the latest message it was made on.
     */
    triageMessageId: text("triage_message_id").references(
      () => {
        const result: AnyPgColumn = messages.id;
        return result;
      },
      {
        onDelete: "set null",
      },
    ),
    summary: text("summary"),
    /** Last message the summary covers; a newer message means the summary is stale. */
    summaryMessageId: text("summary_message_id").references(
      () => {
        const result: AnyPgColumn = messages.id;
        return result;
      },
      {
        onDelete: "set null",
      },
    ),
    /**
     * Set when the latest message was not AI-triaged because the workspace used its monthly
     * allowance: when the allowance resets. Cleared by the next triage.
     */
    triagePausedUntil: timestamptz("triage_paused_until"),
    /**
     * The provider's own thread id, when it has one: Gmail's X-GM-THRID. Messages with
     * one join its thread, so a conversation is the same one the provider shows.
     */
    providerThreadId: text("provider_thread_id"),
    status: conversationStatus("status").notNull().default("open"),
    assigneeMemberId: text("assignee_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    priority: conversationPriority("priority").notNull().default("normal"),
    /** Set while `status` is `snoozed`: when it opens again. */
    snoozedUntil: timestamptz("snoozed_until"),
    customerId: text("customer_id").references(
      () => {
        const result: AnyPgColumn = customers.id;
        return result;
      },
      {
        onDelete: "set null",
      },
    ),
    firstResponseDueAt: timestamptz("first_response_due_at"),
    nextResponseDueAt: timestamptz("next_response_due_at"),
    resolutionDueAt: timestamptz("resolution_due_at"),
    /**
     * SLA clocks. When the customer started waiting for the reply we owe (cleared by
     * our reply), and when the current open stretch began (cleared by resolve). The due times
     * above are these plus the inbox's targets for the priority, in business hours.
     */
    responseClockAt: timestamptz("response_clock_at"),
    resolutionClockAt: timestamptz("resolution_clock_at"),
    firstRespondedAt: timestamptz("first_responded_at"),
    resolvedAt: timestamptz("resolved_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "threads_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
    index("threads_mailbox_list_idx").on(t.mailboxId, t.archived, t.lastMessageAt.desc()),
    index("threads_mailbox_triage_idx").on(t.mailboxId, t.triage, t.lastMessageAt.desc()),
    index("threads_mailbox_page_idx").on(
      t.mailboxId,
      t.archived,
      t.lastMessageAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    index("threads_mailbox_lane_page_idx").on(
      t.mailboxId,
      t.archived,
      t.triage,
      t.lastMessageAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    index("threads_mailbox_all_page_idx").on(
      t.mailboxId,
      t.lastMessageAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    index("threads_mailbox_subject_key_idx").on(
      t.mailboxId,
      t.subjectKey,
      t.lastMessageAt.desc().nullsFirst(),
    ),
    index("threads_summary_message_id_idx")
      .on(t.summaryMessageId)
      .where(sql`${t.summaryMessageId} is not null`),
    index("threads_mailbox_status_page_idx").on(
      t.mailboxId,
      t.status,
      t.lastMessageAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    index("threads_mailbox_assignee_page_idx").on(
      t.mailboxId,
      t.assigneeMemberId,
      t.status,
      t.lastMessageAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    index("threads_mailbox_sla_due_idx")
      .on(t.mailboxId, slaDueAt(t))
      .where(sql`${t.status} = 'open'`),
    index("threads_sla_due_idx")
      .on(slaDueAt(t))
      .where(sql`${t.status} = 'open'`),
    index("threads_snoozed_until_idx")
      .on(t.snoozedUntil)
      .where(sql`${t.status} = 'snoozed'`),
    index("threads_customer_idx").on(t.customerId, t.lastMessageAt.desc().nullsFirst()),
    index("threads_assignee_member_id_idx")
      .on(t.assigneeMemberId)
      .where(sql`${t.assigneeMemberId} is not null`),
    uniqueIndex("threads_mailbox_provider_thread_unique")
      .on(t.mailboxId, t.providerThreadId)
      .where(sql`${t.providerThreadId} is not null`),
  ],
);

/**
 * The soonest SLA due time of a conversation, null when none is set. Queries filter and order by
 * this exact expression so the `*_sla_due_idx` indexes serve them.
 */
export function slaDueAt(t: {
  firstResponseDueAt: AnyPgColumn;
  nextResponseDueAt: AnyPgColumn;
  resolutionDueAt: AnyPgColumn;
}) {
  return sql`least(${t.firstResponseDueAt}, ${t.nextResponseDueAt}, ${t.resolutionDueAt})` satisfies SQL;
}

export const messages = pgTable(
  "messages",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    folderId: text("folder_id").references(() => mailboxFolders.id, { onDelete: "set null" }),
    imapUid: bigint("imap_uid", { mode: "number" }),
    /** Message-ID header, or a hash of the headers when the message has none. */
    messageIdHeader: text("message_id_header").notNull(),
    inReplyTo: text("in_reply_to"),
    references: text("references")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    subject: text("subject").notNull().default(""),
    fromName: text("from_name"),
    fromAddress: text("from_address").notNull(),
    to: jsonb("to").$type<Address[]>().notNull().default([]),
    cc: jsonb("cc").$type<Address[]>().notNull().default([]),
    sentAt: timestamptz("sent_at").notNull(),
    r2Key: text("r2_key"),
    /** Sanitized HTML body in R2; the only HTML ever sent to an app. Null for text-only mail. */
    htmlR2Key: text("html_r2_key"),
    cleanText: text("clean_text").notNull().default(""),
    /** Remote images the sanitizer replaced; the reader offers to load them. */
    remoteImageCount: integer("remote_image_count").notNull().default(0),
    /** The message it forwards, when it is a forward (`@omni/mail-core` `cleanMessage`). */
    forwarded: jsonb("forwarded").$type<ForwardedMessage>(),
    /** List-Unsubscribe URIs, angle brackets removed (`@omni/mail-core` `unsubscribeMethod`). */
    listUnsubscribe: text("list_unsubscribe")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** List-Unsubscribe-Post offers RFC 8058 one-click. */
    listUnsubscribeOneClick: boolean("list_unsubscribe_one_click").notNull().default(false),
    /**
     * Set when the mail service stores the row; cleared once the Worker accepts its
     * `message.created`. A sweep re-sends what is still set after a crash or Worker outage.
     * Defaults false so existing rows are never re-notified.
     */
    notifyPending: boolean("notify_pending").notNull().default(false),
    /**
     * A machine sent it (bounce, auto-reply, out of office: `@omni/mail-core` `automatedKind`).
     * The helpdesk never reopens a conversation or starts an SLA on one.
     */
    automated: boolean("automated").notNull().default(false),
    /**
     * When the Worker applied this message to its conversation (status rule, first response,
     * SLA). Claimed once, so a redelivered `message.created` cannot apply an old message again.
     */
    workflowAppliedAt: timestamptz("workflow_applied_at"),
    /**
     * The teammate whose send this is: the member on the outbox `send` action with this
     * Message-ID. Null for mail from anyone else, a send from another mail app, or after the
     * member is removed. Lets a shared inbox tell your replies from a teammate's.
     */
    sentByMemberId: text("sent_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    searchVector: tsvector("search_vector")
      .notNull()
      .generatedAlwaysAs(
        () =>
          sql`setweight(to_tsvector('english', coalesce(subject, '')), 'A')
          || setweight(to_tsvector('english', coalesce(from_name, '') || ' ' || from_address), 'B')
          || setweight(to_tsvector('english', clean_text), 'C')` satisfies SQL,
      ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "messages_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
    unique("messages_folder_id_imap_uid_unique").on(t.folderId, t.imapUid),
    unique("messages_mailbox_id_message_id_header_unique").on(t.mailboxId, t.messageIdHeader),
    index("messages_thread_id_sent_at_idx").on(t.threadId, t.sentAt),
    index("messages_search_vector_idx").using("gin", t.searchVector),
    index("messages_mailbox_id_in_reply_to_idx").on(t.mailboxId, t.inReplyTo),
    index("messages_references_idx").using("gin", t.references),
    index("messages_notify_pending_idx")
      .on(t.mailboxId)
      .where(sql`${t.notifyPending}`),
    index("messages_mailbox_id_sent_at_idx").on(
      t.mailboxId,
      t.sentAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    index("messages_mailbox_from_address_idx").on(t.mailboxId, sql`lower(${t.fromAddress})`),
    index("messages_mailbox_id_id_idx").on(t.mailboxId, t.id),
  ],
);

/**
 * Every IMAP copy of a message: one row per (folder, UID). A message filed in two folders (a
 * note to self in INBOX and Sent) is one `messages` row with two locations, so neither folder's
 * sync sees the other's copy as missing. Flags are per copy, as on the server.
 */
export const messageLocations = pgTable(
  "message_locations",
  {
    orgId: text("org_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    folderId: text("folder_id")
      .notNull()
      .references(() => mailboxFolders.id, { onDelete: "cascade" }),
    imapUid: bigint("imap_uid", { mode: "number" }).notNull(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    /** The copy's full IMAP flag set, sorted. */
    flags: text("flags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    modseq: bigint("modseq", { mode: "bigint" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.folderId, t.imapUid] }),
    index("message_locations_message_id_idx").on(t.messageId),
    foreignKey({
      name: "message_locations_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
  ],
);

/**
 * Which attachments are iCalendar (`text/calendar`, `application/ics` or a `.ics` name). The
 * calendar's sweep filters with this same expression, so its partial index serves the read.
 */
export const CALENDAR_ATTACHMENT = sql.raw(
  "(lower(mime_type) in ('text/calendar', 'application/ics') or lower(filename) like '%.ics')",
);

export const attachments = pgTable(
  "attachments",
  {
    id: id(),
    orgId: orgId(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    r2Key: text("r2_key").notNull(),
    /** Shown inside the body (`cid:` image), not as a chip. */
    inline: boolean("inline").notNull().default(false),
    /** The part's Content-ID without angle brackets, for `cid:` references. */
    contentId: text("content_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("attachments_message_id_idx").on(t.messageId),
    index("attachments_content_hash_idx").on(sql`split_part(${t.r2Key}, '/att/', 2)`),
    index("attachments_calendar_idx")
      .on(t.createdAt, t.id)
      .where(sql`${CALENDAR_ATTACHMENT}`),
  ],
);

export const threadState = pgTable(
  "thread_state",
  {
    orgId: orgId(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    memberId: memberId(),
    read: boolean("read").notNull().default(false),
    /**
     * Set while the thread is in the member's Later: `infinity`. Rows from when Later
     * was a timed deferral hold a time and leave Later once it passes.
     */
    snoozedUntil: timestamptz("snoozed_until"),
    /**
     * Done, up to the thread's `last_message_at` as the member saw it. The thread is done while
     * `last_message_at <= done_through`, so a newer message brings it back to the Inbox without
     * any job.
     */
    doneThrough: timestamptz("done_through"),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.memberId] }),
    index("thread_state_member_deferred_idx")
      .on(t.memberId, t.threadId, t.snoozedUntil, t.doneThrough)
      .where(sql`${t.snoozedUntil} is not null`),
  ],
);

export const assignments = pgTable("assignments", {
  orgId: orgId(),
  threadId: text("thread_id")
    .primaryKey()
    .references(() => threads.id, { onDelete: "cascade" }),
  memberId: memberId(),
  assignedAt: timestamptz("assigned_at").notNull().defaultNow(),
});
