import { and, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { mailboxAccess, mailboxes, members } from "../schema/index.ts";
import { ownedPersonalMailbox } from "./forwarding.ts";

/**
 * Sets what the user calls one of their own personal inboxes ("Work") and the From name mail
 * from it carries ("Rodrigo @ Chow Mein"); an absent field is left as it is, null clears it.
 * False when the mailbox is not a personal one they own.
 */
export async function setInboxNames(
  db: Db,
  input: {
    userId: string;
    scopeOrgId?: string | null;
    mailboxId: string;
    label?: string | null;
    senderName?: string | null;
  },
) {
  const rows = await db
    .update(mailboxes)
    .set({
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.senderName !== undefined ? { senderName: input.senderName } : {}),
    })
    .where(
      and(eq(mailboxes.id, input.mailboxId), ownedPersonalMailbox(input.userId, input.scopeOrgId)),
    )
    .returning({ id: mailboxes.id });
  return rows.length > 0;
}

/**
 * The From name set on a mailbox the member is on, or null: also null when they have no access
 * to it, or it sits in another org than their membership.
 */
export async function mailboxSenderName(db: Db, memberId: string, mailboxId: string) {
  const [row] = await db
    .select({ senderName: mailboxes.senderName })
    .from(mailboxes)
    .innerJoin(
      mailboxAccess,
      and(eq(mailboxAccess.mailboxId, mailboxes.id), eq(mailboxAccess.memberId, memberId)),
    )
    .innerJoin(
      members,
      and(eq(members.id, mailboxAccess.memberId), eq(members.organizationId, mailboxes.orgId)),
    )
    .where(eq(mailboxes.id, mailboxId));
  return row?.senderName ?? null;
}
