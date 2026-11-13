// Sync's own bookkeeping, kept out of `mail.ts` (over the file-length cap).
import { foreignKey, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { uuidv7 } from "uuidv7";
import { organizations } from "./auth.ts";
import { mailboxes } from "./mail.ts";

/**
 * Mail events (`@omni/contracts` `MailEvent`) the Worker has not accepted yet. Sync writes a row in
 * the same transaction as the change it reports (a merge, a prune, an action that failed for
 * good), so a crash or a Worker outage can delay an event but never lose it. The mail service
 * delivers rows oldest first (ids are UUIDv7) and deletes each once the Worker answers 2xx; the
 * Worker handles every event idempotently, so a row delivered twice is harmless.
 *
 * `message.created` is not here: `messages.notify_pending` already makes it durable.
 */
export const pendingMailEvents = pgTable(
  "pending_mail_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => uuidv7()),
    orgId: text("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id").notNull(),
    /** The event as the Worker receives it. Ids only, never mail content. */
    event: jsonb("event").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    // A deleted mailbox takes its undelivered events with it: nobody is left to show them to.
    foreignKey({
      name: "pending_mail_events_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
  ],
);
