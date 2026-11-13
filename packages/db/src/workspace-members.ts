// The people of a company workspace with the inboxes each can open, for its owners and admins
// (ADR 0026): which personal inboxes are theirs and which shared inboxes they are on. Facts about
// mailboxes only, never their mail, and nothing here grants access.
import { and, asc, count, eq } from "drizzle-orm";
import type { Db } from "./client.ts";
import { mailboxAccess, mailboxes, members, users } from "./schema/index.ts";
import { listWorkspaceMailboxes } from "./workspace-mailboxes.ts";

type WorkspaceMailbox = Awaited<ReturnType<typeof listWorkspaceMailboxes>>[number];

/** A personal inbox as a member's row shows it. */
function personalInbox({ id, address, provider, status, syncedAt }: WorkspaceMailbox) {
  return { id, address, provider, status, syncedAt };
}

/**
 * Every member of `orgId`, oldest first, with `inboxes` (the personal inboxes they own),
 * `sharedInboxes` (the shared inboxes they are on) and `inboxCount` (how many they can open).
 * Callers check the actor may see this (owners and admins of `orgId`).
 */
export async function listWorkspaceMembers(db: Db, orgId: string) {
  const [people, all, grants] = await Promise.all([
    db
      .select({
        id: members.id,
        role: members.role,
        joinedAt: members.createdAt,
        userId: users.id,
        name: users.name,
        email: users.email,
        image: users.image,
      })
      .from(members)
      .innerJoin(users, eq(users.id, members.userId))
      .where(eq(members.organizationId, orgId))
      .orderBy(asc(members.createdAt), asc(members.id)),
    listWorkspaceMailboxes(db, orgId),
    db
      .select({ memberId: mailboxAccess.memberId, mailboxId: mailboxAccess.mailboxId })
      .from(mailboxAccess)
      .innerJoin(
        mailboxes,
        and(eq(mailboxes.id, mailboxAccess.mailboxId), eq(mailboxes.orgId, orgId)),
      )
      .where(eq(mailboxAccess.orgId, orgId)),
  ]);
  const byId = new Map(all.map((mailbox) => [mailbox.id, mailbox]));
  return people.map(({ userId, name, email, image, ...member }) => {
    const mine = grants
      .filter((grant) => grant.memberId === member.id)
      .map((grant) => byId.get(grant.mailboxId))
      .filter((mailbox) => mailbox !== undefined);
    return {
      ...member,
      joinedAt: member.joinedAt.toISOString(),
      user: { id: userId, name, email, image },
      inboxes: mine.filter((m) => m.kind === "personal").map(personalInbox),
      sharedInboxes: mine
        .filter((m) => m.kind === "shared")
        .map(({ id, address }) => ({ id, address })),
      inboxCount: mine.length,
    };
  });
}

/** How many mailboxes of `orgId` the member can open (personal and shared). */
export async function memberInboxCount(db: Db, orgId: string, memberId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(mailboxAccess)
    .where(and(eq(mailboxAccess.orgId, orgId), eq(mailboxAccess.memberId, memberId)));
  return row?.n ?? 0;
}

/** Whether the member holds a grant on a shared mailbox of `orgId`. */
export async function hasSharedGrant(db: Db, orgId: string, mailboxId: string, memberId: string) {
  const [row] = await db
    .select({ memberId: mailboxAccess.memberId })
    .from(mailboxAccess)
    .innerJoin(
      mailboxes,
      and(
        eq(mailboxes.id, mailboxAccess.mailboxId),
        eq(mailboxes.orgId, orgId),
        eq(mailboxes.kind, "shared"),
      ),
    )
    .where(and(eq(mailboxAccess.mailboxId, mailboxId), eq(mailboxAccess.memberId, memberId)));
  return row !== undefined;
}

/**
 * The members of `orgId` for whom this mailbox is the only inbox they can open: removing the
 * mailbox would leave them with none (ADR 0026).
 */
export async function membersStrandedWithout(db: Db, orgId: string, mailboxId: string) {
  const holders = await db
    .select({ memberId: mailboxAccess.memberId })
    .from(mailboxAccess)
    .innerJoin(
      members,
      and(eq(members.id, mailboxAccess.memberId), eq(members.organizationId, orgId)),
    )
    .where(eq(mailboxAccess.mailboxId, mailboxId));
  const stranded: string[] = [];
  for (const { memberId } of holders) {
    if ((await memberInboxCount(db, orgId, memberId)) <= 1) stranded.push(memberId);
  }
  return stranded;
}
