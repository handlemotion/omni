import { foreignKey, pgEnum, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { members } from "../auth.ts";
import { id, orgId, timestamptz } from "../columns.ts";
import { mailboxes } from "./mailboxes.ts";

/** How the list was left: an RFC 8058 one-click POST, or a mail to its `mailto:` address. */
export const unsubscribeKind = pgEnum("unsubscribe_kind", ["post", "mail"]);

/**
 * A mailbox left a sender's list. Keyed by sender, not message: a list's unsubscribe URLs change
 * with every issue, and its mail stored before `unsubscribed_at` all reads as left. Mail it sends
 * later offers Unsubscribe again. Not derived from mail, so a full re-sync keeps it.
 */
export const listUnsubscribes = pgTable(
  "list_unsubscribes",
  {
    id: id(),
    orgId: orgId(),
    mailboxId: text("mailbox_id").notNull(),
    /** The sender's address, lowercased. */
    sender: text("sender").notNull(),
    kind: unsubscribeKind("kind").notNull(),
    memberId: text("member_id").references(() => members.id, { onDelete: "set null" }),
    unsubscribedAt: timestamptz("unsubscribed_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("list_unsubscribes_mailbox_sender_idx").on(t.mailboxId, t.sender),
    foreignKey({
      name: "list_unsubscribes_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
  ],
);
