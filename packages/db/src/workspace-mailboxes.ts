// Every mailbox of a workspace, for its owners and admins to see what exists and whether it syncs
// (settings: shared mailboxes, members' inboxes). Facts about each mailbox only: its address,
// kind, health, who owns a personal one and how many people see a shared one. Never its mail:
// nothing here reads threads or messages, and nothing grants access.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { mailboxAccess, mailboxes, mailboxFolders, members, users } from "./schema/index.ts";

/**
 * The org's mailboxes, by address. `syncedAt` is the latest folder sync. `people` counts the
 * org members with a grant (for a shared mailbox, its team; ADR 0008). `owner` is the member a
 * personal mailbox belongs to, or null for a shared one or one whose owner left the org.
 * Callers check the actor may see this (owners and admins of `orgId`).
 */
export async function listWorkspaceMailboxes(db: Db, orgId: string) {
  const rows = await db
    .select({
      id: mailboxes.id,
      address: mailboxes.address,
      kind: mailboxes.kind,
      provider: mailboxes.provider,
      status: mailboxes.status,
      createdAt: mailboxes.createdAt,
    })
    .from(mailboxes)
    .where(eq(mailboxes.orgId, orgId))
    .orderBy(asc(mailboxes.address));
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);

  const [synced, counts] = await Promise.all([
    db
      .select({
        mailboxId: mailboxFolders.mailboxId,
        at: sql<string | null>`max(${mailboxFolders.syncedAt})`,
      })
      .from(mailboxFolders)
      .where(and(eq(mailboxFolders.orgId, orgId), inArray(mailboxFolders.mailboxId, ids)))
      .groupBy(mailboxFolders.mailboxId),
    db
      .select({ mailboxId: mailboxAccess.mailboxId, people: sql<number>`count(*)::int` })
      .from(mailboxAccess)
      .innerJoin(
        members,
        and(eq(members.id, mailboxAccess.memberId), eq(members.organizationId, orgId)),
      )
      .where(inArray(mailboxAccess.mailboxId, ids))
      .groupBy(mailboxAccess.mailboxId),
  ]);
  const syncedAt = new Map(synced.map((row) => [row.mailboxId, row.at]));
  const people = new Map(counts.map((row) => [row.mailboxId, row.people]));

  const personal = rows.filter((row) => row.kind === "personal").map((row) => row.id);
  const owners =
    personal.length === 0
      ? []
      : await db
          .select({
            mailboxId: mailboxAccess.mailboxId,
            memberId: members.id,
            name: users.name,
            email: users.email,
            image: users.image,
          })
          .from(mailboxAccess)
          .innerJoin(
            members,
            and(eq(members.id, mailboxAccess.memberId), eq(members.organizationId, orgId)),
          )
          .innerJoin(users, eq(users.id, members.userId))
          .where(inArray(mailboxAccess.mailboxId, personal))
          // A personal mailbox's one grant is its owner (spec); `owner` sorts first if there
          // were ever more.
          .orderBy(asc(mailboxAccess.role), asc(mailboxAccess.createdAt));
  const ownerOf = new Map<string, (typeof owners)[number]>();
  for (const owner of owners)
    if (!ownerOf.has(owner.mailboxId)) ownerOf.set(owner.mailboxId, owner);

  return rows.map(({ createdAt, ...row }) => {
    const owner = row.kind === "personal" ? ownerOf.get(row.id) : undefined;
    const at = syncedAt.get(row.id);
    return {
      ...row,
      createdAt: createdAt.toISOString(),
      syncedAt: at ? new Date(at).toISOString() : null,
      people: people.get(row.id) ?? 0,
      owner: owner
        ? { memberId: owner.memberId, name: owner.name, email: owner.email, image: owner.image }
        : null,
    };
  });
}

/**
 * The mailbox at `address` in `orgId` with its kind and the members holding a grant on it, or
 * null (for a personal mailbox, its owner). Lets the Worker refuse a provisioning request that would turn someone's personal inbox
 * into a shared one, or hand it to someone else.
 */
export async function mailboxAtAddress(db: Db, orgId: string, address: string) {
  const [row] = await db
    .select({ id: mailboxes.id, kind: mailboxes.kind })
    .from(mailboxes)
    .where(and(eq(mailboxes.orgId, orgId), eq(mailboxes.address, address)));
  if (!row) return null;
  const grants = await db
    .select({ memberId: mailboxAccess.memberId })
    .from(mailboxAccess)
    .where(eq(mailboxAccess.mailboxId, row.id));
  return { ...row, memberIds: grants.map((grant) => grant.memberId) };
}

/** The member `memberId` of `orgId`, with their sign-in email, or null. */
export async function orgMember(db: Db, orgId: string, memberId: string) {
  const [row] = await db
    .select({ id: members.id, email: users.email })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.id, memberId), eq(members.organizationId, orgId)));
  return row ?? null;
}
