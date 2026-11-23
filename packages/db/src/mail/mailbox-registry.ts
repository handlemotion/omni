import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { mailboxAccess, mailboxes, members, users } from "../schema/index.ts";
import { syncableMailbox } from "./inbox-admin.ts";
import { ensureMailboxTeam, syncMailboxAccess } from "./mailbox-teams.ts";

/**
 * Mailboxes the mail service should keep connected: everything not disabled, except a personal
 * inbox whose owner left the org, which nobody can open until it is given away.
 */
export function listServiceMailboxes(db: Db) {
  return db
    .select({
      id: mailboxes.id,
      orgId: mailboxes.orgId,
      address: mailboxes.address,
      kind: mailboxes.kind,
      provider: mailboxes.provider,
      credentialsEnc: mailboxes.credentialsEnc,
      status: mailboxes.status,
      createdAt: mailboxes.createdAt,
    })
    .from(mailboxes)
    .where(and(ne(mailboxes.status, "disabled"), syncableMailbox));
}

export async function findMailbox(db: Db, mailboxId: string) {
  const [row] = await db
    .select({ orgId: mailboxes.orgId, address: mailboxes.address, kind: mailboxes.kind })
    .from(mailboxes)
    .where(eq(mailboxes.id, mailboxId));
  return row ?? null;
}

export async function setMailboxStatus(
  db: Db,
  mailboxId: string,
  status: (typeof mailboxes.$inferSelect)["status"],
) {
  await db
    .update(mailboxes)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(mailboxes.id, mailboxId), ne(mailboxes.status, status)));
}
/** The member of `orgId` whose user has this email, for granting mailbox access. */
export async function findMemberByEmail(db: Db, orgId: string, email: string) {
  const [row] = await db
    .select({ id: members.id })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(
      and(eq(members.organizationId, orgId), eq(sql`lower(${users.email})`, email.toLowerCase())),
    );
  return row?.id ?? null;
}

export async function findMailboxByAddress(db: Db, orgId: string, address: string) {
  const [row] = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(and(eq(mailboxes.orgId, orgId), eq(mailboxes.address, address)));
  return row?.id ?? null;
}

/**
 * Creates a mailbox, or replaces its credentials when it exists, and grants the owner access. A
 * shared mailbox also gets its Better Auth team, with the owner on it.
 * The caller picks `id` first because the credential ciphertext is bound to it.
 */
export async function saveMailbox(
  db: Db,
  input: {
    id: string;
    orgId: string;
    address: string;
    kind: (typeof mailboxes.$inferSelect)["kind"];
    provider: (typeof mailboxes.$inferSelect)["provider"];
    credentialsEnc: string;
    /** Null only for a personal inbox waiting for an invitee: no grant yet. */
    ownerMemberId: string | null;
    /** The account's picture from its provider. Absent keeps the one saved. */
    picture?: string | null;
    /** The account's name from its provider: the From name until the owner sets their own. */
    senderName?: string;
  },
) {
  if (input.ownerMemberId === null && input.kind !== "personal") {
    throw new Error("a shared mailbox needs someone on it");
  }
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(mailboxes)
      .values({
        id: input.id,
        orgId: input.orgId,
        address: input.address,
        kind: input.kind,
        provider: input.provider,
        credentialsEnc: input.credentialsEnc,
        picture: input.picture ?? null,
        senderName: input.senderName ?? null,
      })
      .onConflictDoUpdate({
        target: mailboxes.id,
        set: {
          kind: input.kind,
          provider: input.provider,
          credentialsEnc: input.credentialsEnc,
          ...(input.picture !== undefined ? { picture: input.picture } : {}),
          ...(input.senderName
            ? { senderName: sql`coalesce(${mailboxes.senderName}, ${input.senderName})` }
            : {}),
          status: "pending",
          updatedAt: new Date(),
        },
      })
      .returning({ id: mailboxes.id });
    if (input.ownerMemberId !== null) {
      await tx
        .insert(mailboxAccess)
        .values({
          orgId: input.orgId,
          mailboxId: row!.id,
          memberId: input.ownerMemberId,
          role: "owner",
        })
        .onConflictDoUpdate({
          target: [mailboxAccess.mailboxId, mailboxAccess.memberId],
          set: { role: "owner" },
        });
    }
    if (input.kind === "shared") {
      await ensureMailboxTeam(tx, row!.id);
      await syncMailboxAccess(tx, row!.id);
    }
    return row!.id;
  });
}

/** Members holding an owner grant on the mailbox. */
export async function mailboxOwnerIds(db: Db, mailboxId: string) {
  const rows = await db
    .select({ memberId: mailboxAccess.memberId })
    .from(mailboxAccess)
    .where(and(eq(mailboxAccess.mailboxId, mailboxId), eq(mailboxAccess.role, "owner")));
  return rows.map((row) => row.memberId) satisfies string[];
}

/**
 * Gmail inboxes the mail service keeps connected, for the calendar's Google sync. No credentials:
 * only the mail service opens those.
 */
export function liveGmailMailboxes(db: Db) {
  return db
    .select({ id: mailboxes.id, orgId: mailboxes.orgId })
    .from(mailboxes)
    .where(and(eq(mailboxes.provider, "gmail"), ne(mailboxes.status, "disabled"), syncableMailbox));
}

/** Gmail mailboxes at `address` in any workspace: one Google account syncs into one place. */
export function findGmailMailboxes(db: Db, address: string) {
  return db
    .select({ id: mailboxes.id, orgId: mailboxes.orgId })
    .from(mailboxes)
    .where(and(eq(mailboxes.provider, "gmail"), eq(mailboxes.address, address)));
}

/** A mailbox with what disconnecting it needs, scoped to its org; null when it is not there. */
export async function findOrgMailboxById(db: Db, orgId: string, mailboxId: string) {
  const [row] = await db
    .select({
      id: mailboxes.id,
      kind: mailboxes.kind,
      provider: mailboxes.provider,
      credentialsEnc: mailboxes.credentialsEnc,
    })
    .from(mailboxes)
    .where(and(eq(mailboxes.orgId, orgId), eq(mailboxes.id, mailboxId)));
  return row ?? null;
}

/**
 * Deletes a mailbox and, through cascades, everything indexed from it (threads, messages,
 * folders, grants, notes). Postgres is only an index of the provider's mail, so nothing is lost
 * that the provider does not still hold. Idempotent.
 */
export async function deleteMailbox(db: Db, mailboxId: string) {
  await db.delete(mailboxes).where(eq(mailboxes.id, mailboxId));
}
