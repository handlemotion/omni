import { and, asc, eq, ne } from "drizzle-orm";
import { mailboxAccess, mailboxes, members } from "../schema/index.ts";
import { grantInOrg } from "./grants.ts";
import type { ConversationRow, Executor, Tx } from "./conversation-core.ts";

/**
 * The teammate whose turn it is on the conversation's inbox when round-robin auto-assign is on,
 * recorded as the inbox's last turn; null when it is off or nobody is on the inbox.
 */
export async function nextInTurn(tx: Tx, row: ConversationRow) {
  const [flag] = await tx
    .select({ on: mailboxes.autoAssign })
    .from(mailboxes)
    .where(eq(mailboxes.id, row.mailboxId));
  if (!flag?.on) return null;
  const [inbox] = await tx
    .select({ on: mailboxes.autoAssign, last: mailboxes.autoAssignLastMemberId })
    .from(mailboxes)
    .where(eq(mailboxes.id, row.mailboxId))
    .for("no key update");
  if (!inbox?.on) return null;
  const team = (
    await tx
      .select({ id: mailboxAccess.memberId })
      .from(mailboxAccess)
      .innerJoin(members, grantInOrg(row.orgId))
      .where(eq(mailboxAccess.mailboxId, row.mailboxId))
      .orderBy(asc(mailboxAccess.memberId))
  ).map((m) => m.id);
  if (team.length === 0) return null;
  const last = inbox.last;
  const next = (last !== null && team.find((id) => id > last)) || team[0]!;
  await tx
    .update(mailboxes)
    .set({ autoAssignLastMemberId: next })
    .where(eq(mailboxes.id, row.mailboxId));
  return next;
}

/**
 * Turns round-robin auto-assign on or off for a shared inbox of the org. False when there is no
 * such inbox. Turning it on starts with whoever comes first; turning it off forgets the turn.
 */
export async function setAutoAssign(db: Executor, orgId: string, mailboxId: string, on: boolean) {
  const rows = await db
    .update(mailboxes)
    .set({ autoAssign: on, autoAssignLastMemberId: null, updatedAt: new Date() })
    .where(
      and(
        eq(mailboxes.id, mailboxId),
        eq(mailboxes.orgId, orgId),
        eq(mailboxes.kind, "shared"),
        ne(mailboxes.autoAssign, on),
      ),
    )
    .returning({ id: mailboxes.id });
  if (rows.length) return true;
  const [exists] = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(
      and(eq(mailboxes.id, mailboxId), eq(mailboxes.orgId, orgId), eq(mailboxes.kind, "shared")),
    );
  return exists !== undefined;
}
