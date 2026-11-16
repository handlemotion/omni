// What owners and admins do with a company's inboxes when someone leaves (ADR 0026): a personal
// inbox whose owner left the org is orphaned (nobody can open it, and the mail service stops
// syncing it). It can be given to a member or turned into a shared inbox. Every inbox action is
// recorded in `audit_events`, without mail content, so "admins cannot read it" is checkable.
import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { recordAudit } from "../domains.ts";
import { addTeamMembers, ensureMailboxTeam, syncMailboxAccess } from "./mailbox-teams.ts";
import {
  auditEvents,
  invitationInboxes,
  mailboxAccess,
  mailboxes,
  members,
} from "../schema/index.ts";

export type InboxAuditAction =
  | "inbox.issued"
  | "inbox.removed"
  | "inbox.given"
  | "inbox.made_shared"
  | "shared_inbox.created"
  | "shared_inbox.person_added"
  | "shared_inbox.person_removed";

/** Records one inbox action. `subject` is the inbox's address. */
export function recordInboxEvent(
  db: Db,
  input: {
    orgId: string;
    actorMemberId: string;
    action: InboxAuditAction;
    address: string;
    data: { mailboxId: string; memberIds?: string[]; invitationId?: string };
  },
) {
  const { address, ...rest } = input;
  return recordAudit(db, { ...rest, subject: address });
}

/** The org's inbox actions, newest first. Callers check the actor is an owner or admin. */
export function listInboxEvents(db: Db, orgId: string, limit = 200) {
  return db
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      address: auditEvents.subject,
      actorMemberId: auditEvents.actorMemberId,
      data: auditEvents.data,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.orgId, orgId),
        or(like(auditEvents.action, "inbox.%"), like(auditEvents.action, "shared_inbox.%")),
      ),
    )
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(limit);
}

/** A grant on the mailbox held by a member of its own org. */
const ownedInOrg = sql`exists (
  select 1 from ${mailboxAccess}
  join ${members} on ${members.id} = ${mailboxAccess.memberId}
    and ${members.organizationId} = ${mailboxes.orgId}
  where ${mailboxAccess.mailboxId} = ${mailboxes.id}
)`;

/**
 * The condition the mail service syncs by: a shared inbox, or a personal one someone in its org
 * still owns. An orphaned inbox drops out on its own and comes back once it has an owner again.
 */
export const syncableMailbox = or(eq(mailboxes.kind, "shared"), ownedInOrg);

export type OrphanResult = "ok" | "not_found" | "not_orphaned" | "member_not_found";

/** The org's mailbox, locked for the rest of the transaction, with whether it is orphaned. */
async function lockOrgMailbox(tx: Db, orgId: string, mailboxId: string) {
  const [row] = await tx
    .select({
      id: mailboxes.id,
      address: mailboxes.address,
      kind: mailboxes.kind,
      owned: sql<boolean>`${ownedInOrg}`,
    })
    .from(mailboxes)
    .where(and(eq(mailboxes.id, mailboxId), eq(mailboxes.orgId, orgId)))
    .for("update");
  return row ?? null;
}

async function orgMemberIds(db: Db, orgId: string, memberIds: string[]) {
  const rows = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.organizationId, orgId), inArray(members.id, memberIds)));
  return rows.length === new Set(memberIds).size;
}

/**
 * Gives an orphaned inbox to `memberId`: it becomes their personal inbox, old mail included.
 * Idempotent: giving it again to the same member is "ok"; to anyone else it is "not_orphaned".
 */
export async function giveOrphanedInbox(
  db: Db,
  orgId: string,
  mailboxId: string,
  memberId: string,
): Promise<{ result: OrphanResult; address?: string }> {
  if (!(await orgMemberIds(db, orgId, [memberId]))) return { result: "member_not_found" };
  return db.transaction(async (tx) => {
    const mailbox = await lockOrgMailbox(tx, orgId, mailboxId);
    if (!mailbox || mailbox.kind !== "personal") return { result: "not_found" };
    if (mailbox.owned) {
      const [mine] = await tx
        .select({ memberId: mailboxAccess.memberId })
        .from(mailboxAccess)
        .where(and(eq(mailboxAccess.mailboxId, mailboxId), eq(mailboxAccess.memberId, memberId)));
      return { result: mine ? "ok" : "not_orphaned", address: mailbox.address };
    }
    await tx
      .insert(mailboxAccess)
      .values({ orgId, mailboxId, memberId, role: "owner" })
      .onConflictDoNothing();
    return { result: "ok", address: mailbox.address };
  });
}

/**
 * Turns an orphaned inbox into a shared inbox seen by `memberIds`, with its team. Idempotent: on
 * an inbox already shared it adds the people named, as adding them one by one would.
 */
export async function shareOrphanedInbox(
  db: Db,
  orgId: string,
  mailboxId: string,
  memberIds: string[],
): Promise<{ result: OrphanResult; address?: string }> {
  if (!(await orgMemberIds(db, orgId, memberIds))) return { result: "member_not_found" };
  const converted = await db.transaction(async (tx) => {
    const mailbox = await lockOrgMailbox(tx, orgId, mailboxId);
    if (!mailbox) return { result: "not_found" as const };
    if (mailbox.kind === "personal") {
      if (mailbox.owned) return { result: "not_orphaned" as const };
      await tx.update(mailboxes).set({ kind: "shared" }).where(eq(mailboxes.id, mailboxId));
    }
    // Grants first: a new team is seeded from them. On an inbox that already has its team, the
    // sync below would drop them again, so they are added to the team after it.
    await tx
      .insert(mailboxAccess)
      .values(
        memberIds.map((memberId) => ({ orgId, mailboxId, memberId, role: "member" as const })),
      )
      .onConflictDoNothing();
    return { result: "ok" as const, address: mailbox.address };
  });
  if (converted.result !== "ok") return converted;
  const teamId = await ensureMailboxTeam(db, mailboxId);
  if (teamId) await addTeamMembers(db, teamId, orgId, memberIds);
  await syncMailboxAccess(db, mailboxId);
  return converted;
}

/** Links an inbox made with an invitation to it, so accepting gives it to the new member. */
export async function reserveInvitationInbox(
  db: Db,
  input: { orgId: string; invitationId: string; mailboxId: string },
) {
  await db.insert(invitationInboxes).values(input).onConflictDoNothing();
}

/**
 * Gives the new member the inboxes made with their invitation (ADR 0026), and records it. Safe to
 * run twice: giving an inbox to its owner again changes nothing. An inbox someone else was given
 * in the meantime stays theirs.
 */
export async function claimInvitationInboxes(
  db: Db,
  input: { orgId: string; invitationId: string; memberId: string },
) {
  const rows = await db
    .select({ mailboxId: invitationInboxes.mailboxId })
    .from(invitationInboxes)
    .where(
      and(
        eq(invitationInboxes.invitationId, input.invitationId),
        eq(invitationInboxes.orgId, input.orgId),
      ),
    );
  for (const { mailboxId } of rows) {
    const { result, address } = await giveOrphanedInbox(db, input.orgId, mailboxId, input.memberId);
    if (result === "ok" && address) {
      await recordInboxEvent(db, {
        orgId: input.orgId,
        actorMemberId: input.memberId,
        action: "inbox.given",
        address,
        data: { mailboxId, memberIds: [input.memberId], invitationId: input.invitationId },
      });
    }
  }
}
