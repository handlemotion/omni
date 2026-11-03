// Shared-mailbox access through Better Auth teams (ADR 0008). Each shared mailbox has one team,
// and the team's members are who can see the mailbox. `mailbox_access` stays the table every
// read joins (`forMember`); for a shared mailbox it is derived from the team here, so reads keep
// their shape and indexes. Personal mailboxes have no team and keep their single owner grant.
//
// Every function is idempotent and converges: `syncMailboxAccess` recomputes the grants from the
// team, whatever ran before it, so a retry or a second run changes nothing.
import { and, asc, eq, exists, isNull, notExists, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "./client.ts";
import { mailboxAccess, mailboxes, members, teamMembers, teams, users } from "./schema/index.ts";

/**
 * Better Auth's `team_members.membership_key`: one row per (team, user). Ours match its rows, so
 * its endpoints and ours never add the same person twice.
 */
async function membershipKey(teamId: string, userId: string) {
  const bytes = new TextEncoder().encode(JSON.stringify([teamId, userId]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return btoa(String.fromCharCode(...digest))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** Locks the mailbox row so concurrent changes to one mailbox's access run one after another. */
async function lockMailbox(db: Db, mailboxId: string) {
  const [row] = await db
    .select({
      id: mailboxes.id,
      orgId: mailboxes.orgId,
      address: mailboxes.address,
      kind: mailboxes.kind,
      teamId: mailboxes.teamId,
    })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId))
    .for("update");
  return row ?? null;
}

/** Better Auth's seat counter (`teams.member_count`), recounted rather than incremented. */
async function recountTeam(db: Db, teamId: string) {
  await db
    .update(teams)
    .set({
      memberCount: sql`(select count(*)::int from ${teamMembers} where ${teamMembers.teamId} = ${teamId})`,
      updatedAt: new Date(),
    })
    .where(eq(teams.id, teamId));
}

async function addTeamUsers(db: Db, teamId: string, userIds: string[]) {
  if (userIds.length === 0) return;
  const now = new Date();
  const rows = await Promise.all(
    userIds.map(async (userId) => ({
      id: uuidv7(),
      teamId,
      userId,
      membershipKey: await membershipKey(teamId, userId),
      createdAt: now,
    })),
  );
  await db.insert(teamMembers).values(rows).onConflictDoNothing({
    target: teamMembers.membershipKey,
  });
}

/**
 * The shared mailbox's team, created on first call: named after the address, in the mailbox's
 * org, and seeded with everyone who has a grant now. This is how new shared mailboxes get their
 * team (`saveMailbox`) and how existing ones are backfilled. Null for a personal or missing
 * mailbox. Safe to run twice: the mailbox row is locked and a linked team is returned as is.
 */
export async function ensureMailboxTeam(db: Db, mailboxId: string) {
  return db.transaction(async (tx) => {
    const mailbox = await lockMailbox(tx, mailboxId);
    if (!mailbox || mailbox.kind !== "shared") return null;
    if (mailbox.teamId) return mailbox.teamId;

    const teamId = uuidv7();
    await tx.insert(teams).values({
      id: teamId,
      name: mailbox.address,
      organizationId: mailbox.orgId,
      createdAt: new Date(),
    });
    await tx.update(mailboxes).set({ teamId }).where(eq(mailboxes.id, mailbox.id));
    const granted = await tx
      .select({ userId: members.userId })
      .from(mailboxAccess)
      .innerJoin(
        members,
        and(eq(members.id, mailboxAccess.memberId), eq(members.organizationId, mailbox.orgId)),
      )
      .where(eq(mailboxAccess.mailboxId, mailbox.id));
    await addTeamUsers(
      tx,
      teamId,
      granted.map((g) => g.userId),
    );
    await recountTeam(tx, teamId);
    return teamId;
  });
}

/**
 * Makes a shared mailbox's grants match its team: a grant for every team member who belongs to
 * the mailbox's org, and none for anyone else. A team in another org grants nothing. Does
 * nothing for a personal mailbox, or a shared one with no team yet (its grants stay as they are
 * until `ensureMailboxTeam` links one).
 */
export async function syncMailboxAccess(db: Db, mailboxId: string) {
  await db.transaction(async (tx) => {
    const mailbox = await lockMailbox(tx, mailboxId);
    if (!mailbox || mailbox.kind !== "shared" || !mailbox.teamId) return;
    await tx
      .insert(mailboxAccess)
      .select(
        tx
          .select({
            orgId: sql<string>`${mailbox.orgId}::text`.as("org_id"),
            mailboxId: sql<string>`${mailbox.id}::text`.as("mailbox_id"),
            memberId: members.id,
            role: sql<"member">`'member'::mailbox_access_role`.as("role"),
            createdAt: sql<Date>`now()`.as("created_at"),
          })
          .from(teamMembers)
          .innerJoin(teams, eq(teams.id, teamMembers.teamId))
          .innerJoin(
            members,
            and(eq(members.userId, teamMembers.userId), eq(members.organizationId, mailbox.orgId)),
          )
          .where(
            and(eq(teamMembers.teamId, mailbox.teamId), eq(teams.organizationId, mailbox.orgId)),
          ),
      )
      .onConflictDoNothing({ target: [mailboxAccess.mailboxId, mailboxAccess.memberId] });
    await tx.delete(mailboxAccess).where(
      and(
        eq(mailboxAccess.mailboxId, mailbox.id),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(teamMembers)
            .innerJoin(teams, eq(teams.id, teamMembers.teamId))
            .innerJoin(
              members,
              and(
                eq(members.userId, teamMembers.userId),
                eq(members.organizationId, mailbox.orgId),
              ),
            )
            .where(
              and(
                eq(teamMembers.teamId, mailbox.teamId),
                eq(teams.organizationId, mailbox.orgId),
                eq(members.id, mailboxAccess.memberId),
              ),
            ),
        ),
      ),
    );
  });
}

/** The shared mailbox a team gives access to, or null for a team that is not one. */
export async function teamMailbox(db: Db, teamId: string) {
  const [row] = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(eq(mailboxes.teamId, teamId));
  return row?.id ?? null;
}

/** `syncMailboxAccess` for the mailbox behind a team; for Better Auth's team hooks. */
export async function syncTeamMailboxAccess(db: Db, teamId: string) {
  const mailboxId = await teamMailbox(db, teamId);
  if (mailboxId) await syncMailboxAccess(db, mailboxId);
}

/**
 * Who may read and change a shared mailbox's member list. `manage` is the actor's org role
 * allowing it (owner or admin); without it they may only list members of a mailbox they can see.
 */
export interface MailboxMembersActor {
  memberId: string;
  orgId: string;
  manage: boolean;
}

/** The actor's shared mailbox, or null if it is not one or they may not see its members. */
async function visibleSharedMailbox(db: Db, actor: MailboxMembersActor, mailboxId: string) {
  const [row] = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(
      and(
        eq(mailboxes.id, mailboxId),
        eq(mailboxes.orgId, actor.orgId),
        eq(mailboxes.kind, "shared"),
        actor.manage
          ? undefined
          : exists(
              db
                .select({ one: sql`1` })
                .from(mailboxAccess)
                .where(
                  and(
                    eq(mailboxAccess.mailboxId, mailboxes.id),
                    eq(mailboxAccess.memberId, actor.memberId),
                  ),
                ),
            ),
      ),
    );
  return row ?? null;
}

/**
 * The people on a shared mailbox's team (members of the actor's org), oldest first. Null when
 * the mailbox is not a shared mailbox the actor may see. A mailbox not yet backfilled gets its
 * team here, so the list is never empty for lack of a team.
 */
export async function listMailboxMembers(db: Db, actor: MailboxMembersActor, mailboxId: string) {
  const mailbox = await visibleSharedMailbox(db, actor, mailboxId);
  if (!mailbox) return null;
  const teamId = await ensureMailboxTeam(db, mailbox.id);
  if (!teamId) return null;
  return db
    .select({
      memberId: members.id,
      userId: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
      addedAt: teamMembers.createdAt,
    })
    .from(teamMembers)
    .innerJoin(
      members,
      and(eq(members.userId, teamMembers.userId), eq(members.organizationId, actor.orgId)),
    )
    .innerJoin(users, eq(users.id, members.userId))
    .where(eq(teamMembers.teamId, teamId))
    .orderBy(asc(teamMembers.createdAt), asc(members.id));
}

export type MailboxMembershipResult = "ok" | "mailbox_not_found" | "member_not_found";

/**
 * Adds `memberId` to the shared mailbox's team and grants them access. Only for an actor with
 * `manage`; the member must belong to the actor's org. Idempotent: adding someone already on the
 * team changes nothing.
 */
export async function addMailboxMember(
  db: Db,
  actor: MailboxMembersActor,
  mailboxId: string,
  memberId: string,
): Promise<MailboxMembershipResult> {
  return changeMailboxMember(db, actor, mailboxId, memberId, "add");
}

/**
 * Removes `memberId` from the shared mailbox's team and revokes their access. Only for an actor
 * with `manage`. Idempotent: removing someone not on the team changes nothing.
 */
export async function removeMailboxMember(
  db: Db,
  actor: MailboxMembersActor,
  mailboxId: string,
  memberId: string,
): Promise<MailboxMembershipResult> {
  return changeMailboxMember(db, actor, mailboxId, memberId, "remove");
}

async function changeMailboxMember(
  db: Db,
  actor: MailboxMembersActor,
  mailboxId: string,
  memberId: string,
  change: "add" | "remove",
): Promise<MailboxMembershipResult> {
  if (!actor.manage) return "mailbox_not_found";
  const mailbox = await visibleSharedMailbox(db, actor, mailboxId);
  if (!mailbox) return "mailbox_not_found";
  const [target] = await db
    .select({ userId: members.userId })
    .from(members)
    .where(and(eq(members.id, memberId), eq(members.organizationId, actor.orgId)));
  if (!target) return "member_not_found";

  const teamId = await ensureMailboxTeam(db, mailbox.id);
  if (!teamId) return "mailbox_not_found";
  await db.transaction(async (tx) => {
    await lockMailbox(tx, mailbox.id);
    if (change === "add") {
      await addTeamUsers(tx, teamId, [target.userId]);
    } else {
      await tx
        .delete(teamMembers)
        .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, target.userId)));
    }
    await recountTeam(tx, teamId);
    await syncMailboxAccess(tx, mailbox.id);
  });
  return "ok";
}

/**
 * Gives every shared mailbox without a team its team, seeded from its current grants. Safe to
 * run twice, and while the app is serving: each mailbox is handled under its own row lock.
 */
export async function backfillMailboxTeams(db: Db) {
  const pending = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(eq(mailboxes.kind, "shared"), isNull(mailboxes.teamId)))
    .orderBy(asc(mailboxes.createdAt));
  for (const mailbox of pending) await ensureMailboxTeam(db, mailbox.id);
  return { linked: pending.length };
}
