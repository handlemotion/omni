// System reads for the Worker's trusted paths (background jobs). Not member-scoped:
// never call these with input from a member's request to decide what that member may see.
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "./client.ts";
import { mailboxAccess, mailboxes, members, pushTokens } from "./schema/index.ts";

/** Members who can see each mailbox, with the mailbox's org and address, for realtime fan-out. */
export async function mailboxAudience(db: Db, mailboxIds: string[]) {
  if (mailboxIds.length === 0) return [];
  return db
    .select({
      mailboxId: mailboxAccess.mailboxId,
      orgId: mailboxes.orgId,
      address: mailboxes.address,
      memberId: mailboxAccess.memberId,
    })
    .from(mailboxAccess)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxAccess.mailboxId))
    .innerJoin(
      members,
      and(eq(members.id, mailboxAccess.memberId), eq(members.organizationId, mailboxes.orgId)),
    )
    .where(inArray(mailboxAccess.mailboxId, mailboxIds));
}

/** Expo push tokens registered by these members. */
export async function pushTokensFor(db: Db, memberIds: string[]) {
  if (memberIds.length === 0) return [];
  return db
    .select({ memberId: pushTokens.memberId, expoToken: pushTokens.expoToken })
    .from(pushTokens)
    .where(inArray(pushTokens.memberId, memberIds));
}
