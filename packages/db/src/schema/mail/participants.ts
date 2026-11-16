// Mail's participant index (ADR 0036 decision 4): every address a thread's messages were from, to
// or cc, and how far the backfill of mail stored before it has read.
import { foreignKey, index, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { orgId, updatedAt } from "../columns.ts";
import { mailboxes } from "./mailboxes.ts";
import { threads } from "./messages.ts";

/**
 * Every address a thread's messages were from, to or cc, one row each. The index `threadsWith`
 * looks threads up by: `messages.to` and `cc` are JSON and cannot serve it. Derived from the
 * messages, so a re-sync rebuilds it (ADR 0013). `address` is `normalizeAddress`'s form and
 * `domain` is `domainOf` it (`@omni/mail-core/addresses`); an address without a domain has no row.
 */
export const threadParticipants = pgTable(
  "thread_participants",
  {
    orgId: orgId(),
    mailboxId: text("mailbox_id").notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    domain: text("domain").notNull(),
  },
  (t) => [
    // One row per address per thread: writes are insert-or-nothing, and re-deriving a thread
    // reads its rows by this key.
    primaryKey({ columns: [t.threadId, t.address] }),
    foreignKey({
      name: "thread_participants_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
    // `threadsWith` reads per granted mailbox, like every mail read: the threads with an address,
    // or anyone at a domain, answered from the index alone.
    index("thread_participants_mailbox_address_idx").on(t.mailboxId, t.address, t.threadId),
    index("thread_participants_mailbox_domain_idx").on(t.mailboxId, t.domain, t.threadId),
  ],
);

/**
 * How far the participant backfill has read a mailbox's messages, by id (UUIDv7, so time order).
 * The backfill indexes mail stored before `thread_participants`, or by an older mail service
 * mid-deploy, and keeps reading from here every minute. No row: nothing read yet.
 */
export const threadParticipantsBackfill = pgTable(
  "thread_participants_backfill",
  {
    mailboxId: text("mailbox_id").primaryKey(),
    orgId: orgId(),
    /** The last message read; every message of the mailbox up to it has its participants. */
    lastMessageId: text("last_message_id"),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "thread_participants_backfill_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
  ],
);
