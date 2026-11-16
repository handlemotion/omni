// What a mailbox shows the CRM beyond the members who can open it (ADR 0039 decision 2). Mail owns
// the setting; the CRM reads its effect only through Mail's door (`sharedActivityWith`).
import { foreignKey, pgEnum, pgTable, text } from "drizzle-orm/pg-core";
import { members } from "../auth.ts";
import { orgId, updatedAt } from "../columns.ts";
import { mailboxes } from "./mailboxes.ts";

/** `activity`: who corresponded with a record's people, and when. `subjects`: also the subject. */
export const mailboxCrmSharingLevel = pgEnum("mailbox_crm_sharing_level", [
  "off",
  "activity",
  "subjects",
]);

/**
 * A mailbox's CRM sharing level. No row is `off`, the default. Set by a personal mailbox's owner,
 * or a shared inbox's owners and admins. Turning it off hides its activity on the next read:
 * nothing derived from it is stored.
 */
export const mailboxCrmSharing = pgTable(
  "mailbox_crm_sharing",
  {
    mailboxId: text("mailbox_id").primaryKey(),
    orgId: orgId(),
    level: mailboxCrmSharingLevel("level").notNull(),
    updatedByMemberId: text("updated_by_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: "mailbox_crm_sharing_mailbox_org_fk",
      columns: [t.mailboxId, t.orgId],
      foreignColumns: [mailboxes.id, mailboxes.orgId],
    }).onDelete("cascade"),
  ],
);
