// Mail (ADR 0035): what waits to be done on IMAP/SMTP, staged uploads, drafts and signatures.
import { sql } from "drizzle-orm";
import { foreignKey, index, integer, jsonb, pgTable, text, unique } from "drizzle-orm/pg-core";
import { members } from "../auth.ts";
import { id, timestamptz, createdAt, updatedAt } from "../columns.ts";
import { mailActionKind, draftKind, mailActionStatus } from "./enums.ts";
import { type Address, mailboxes } from "./mailboxes.ts";
import { threads, messages } from "./messages.ts";

export const mailActions = pgTable(
  "mail_actions",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    /** Who asked for it; null for system actions or after the member is removed. */
    memberId: text("member_id").references(() => members.id, { onDelete: "set null" }),
    kind: mailActionKind("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: mailActionStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** Earliest time a worker may claim it; pushed out on retry for backoff. */
    runAfter: timestamptz("run_after").notNull().defaultNow(),
    /** When the current claim started. A stale lease means the worker died; reclaim it. */
    lockedAt: timestamptz("locked_at"),
    /** SMTP accepted the send; a retry only finishes the Sent append and never resends. */
    smtpAcceptedAt: timestamptz("smtp_accepted_at"),
    completedAt: timestamptz("completed_at"),
    /** The request that asked for it (`x-request-id`): ties its logs to the Worker's. */
    requestId: text("request_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "mail_actions_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
    index("mail_actions_claim_idx")
      .on(t.runAfter)
      .where(sql`${t.status} in ('pending', 'running')`),
    // Indexing a sent message finds the send (and who asked for it) by its Message-ID.
    index("mail_actions_send_message_id_idx")
      .on(t.mailboxId, sql`(${t.payload} ->> 'messageId')`)
      .where(sql`${t.kind} = 'send'`),
  ],
);

/** One file on a draft: exactly one of the two ids. */
export interface DraftAttachment {
  /** A file uploaded for this draft (`uploads.id`). */
  uploadId?: string;
  /** An attachment of a stored message, forwarded by reference (`attachments.id`). */
  attachmentId?: string;
}

/**
 * A file a member uploaded to R2 to attach to a send. Unsent uploads are deleted after
 * `expires_at`; `used_at` marks one a send took, which the cleanup leaves alone.
 */
export const uploads = pgTable(
  "uploads",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    memberId: text("member_id").references(() => members.id, { onDelete: "set null" }),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    r2Key: text("r2_key").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    usedAt: timestamptz("used_at"),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "uploads_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
    index("uploads_expiry_idx")
      .on(t.expiresAt)
      .where(sql`${t.usedAt} is null`),
  ],
);

/**
 * Unsent mail, shared with everyone who can see the inbox. Postgres only: never mirrored to the
 * IMAP Drafts folder. `version` goes up on each save, so a stale autosave cannot overwrite a
 * teammate's newer one.
 */
export const drafts = pgTable(
  "drafts",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    /** Null for a new conversation. */
    threadId: text("thread_id").references(() => threads.id, { onDelete: "cascade" }),
    kind: draftKind("kind").notNull(),
    /** The message replied to or forwarded. */
    sourceMessageId: text("source_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    authorMemberId: text("author_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    updatedByMemberId: text("updated_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    to: jsonb("to").$type<Address[]>().notNull().default([]),
    cc: jsonb("cc").$type<Address[]>().notNull().default([]),
    bcc: jsonb("bcc").$type<Address[]>().notNull().default([]),
    subject: text("subject").notNull().default(""),
    bodyText: text("body_text").notNull().default(""),
    bodyHtml: text("body_html"),
    attachments: jsonb("attachments").$type<DraftAttachment[]>().notNull().default([]),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "drafts_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
    index("drafts_thread_idx").on(t.threadId),
    index("drafts_mailbox_idx").on(t.mailboxId, t.updatedAt.desc().nullsFirst()),
  ],
);

/** An inbox's signature (`member_id` null), or one member's own on that inbox. */
export const signatures = pgTable(
  "signatures",
  {
    id: id(),
    orgId: text("org_id").notNull(),
    mailboxId: text("mailbox_id").notNull(),
    memberId: text("member_id").references(() => members.id, { onDelete: "cascade" }),
    bodyText: text("body_text").notNull(),
    bodyHtml: text("body_html"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "signatures_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
    unique("signatures_mailbox_member_unique").on(t.mailboxId, t.memberId).nullsNotDistinct(),
  ],
);
