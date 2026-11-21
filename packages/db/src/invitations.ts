import { and, asc, eq, gt, inArray, notExists, sql, type SQL } from "drizzle-orm";
import type { Db } from "./client.ts";
import { isCompany } from "./personal-space.ts";
import { invitations, members, organizations, users } from "./schema/auth.ts";
import { userEmails } from "./schema/identity.ts";

/** A pending invitation as the person invited sees it. */
export interface InvitationView {
  id: string;
  email: string;
  role: string;
  expiresAt: Date;
  organization: { id: string; name: string };
  inviter: { name: string; email: string; image: string | null };
}

function verifiedAddresses(db: Db, userId: string) {
  return db
    .select({ email: sql<string>`lower(${users.email})` })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.emailVerified, true)))
    .union(
      db
        .select({ email: sql<string>`lower(${userEmails.email})` })
        .from(userEmails)
        .where(eq(userEmails.userId, userId)),
    );
}

function invitationRows(db: Db, where: SQL | undefined) {
  return db
    .select({
      id: invitations.id,
      email: invitations.email,
      role: invitations.role,
      status: invitations.status,
      expiresAt: invitations.expiresAt,
      organization: { id: organizations.id, name: organizations.name },
      inviter: { name: users.name, email: users.email, image: users.image },
    })
    .from(invitations)
    .innerJoin(organizations, eq(organizations.id, invitations.organizationId))
    .innerJoin(users, eq(users.id, invitations.inviterId))
    .where(where);
}

const view = (row: Awaited<ReturnType<typeof invitationRows>>[number]) =>
  ({
    id: row.id,
    email: row.email.toLowerCase(),
    role: row.role ?? "member",
    expiresAt: row.expiresAt,
    organization: row.organization,
    inviter: row.inviter,
  }) satisfies InvitationView;

/**
 * The pending, unexpired invitations to a company addressed to any address `userId` verifiably
 * signs in with (case-insensitively), oldest first. Leaves out companies they already belong to,
 * and, with `scopeOrgId` (a session opened with a company's address), every other company.
 */
export const listPendingInvitations: (
  db: Db,
  userId: string,
  scopeOrgId?: string | null,
) => Promise<InvitationView[]> = async (db, userId, scopeOrgId) => {
  const rows = await invitationRows(
    db,
    and(
      eq(invitations.status, "pending"),
      gt(invitations.expiresAt, new Date()),
      inArray(sql`lower(${invitations.email})`, verifiedAddresses(db, userId)),
      isCompany(db, invitations.organizationId),
      scopeOrgId ? eq(invitations.organizationId, scopeOrgId) : undefined,
      notExists(
        db
          .select({ one: sql`1` })
          .from(members)
          .where(
            and(eq(members.organizationId, invitations.organizationId), eq(members.userId, userId)),
          ),
      ),
    ),
  ).orderBy(asc(invitations.createdAt));
  return rows.map(view);
};

/**
 * Invitation `invitationId` as `userId` may see it. `wrong_account` when it is addressed to an
 * address they do not verifiably own: nothing about it is answered then, not even its workspace.
 * `accepted` also when they are already a member of its workspace. (Accepting readdresses an
 * invitation to an extra address to the accepter's primary, so they still own it afterwards.)
 */
export type InvitationForUser =
  | { status: "not_found" }
  | { status: "wrong_account" }
  | { status: "pending" | "expired" | "accepted" | "declined"; invitation: InvitationView };

export const invitationForUser: (
  db: Db,
  userId: string,
  invitationId: string,
) => Promise<InvitationForUser> = async (db, userId, invitationId) => {
  const [row] = await invitationRows(db, eq(invitations.id, invitationId)).limit(1);
  if (!row) return { status: "not_found" };
  const addresses = await verifiedAddresses(db, userId);
  if (!addresses.some((a) => a.email === row.email.toLowerCase())) {
    return { status: "wrong_account" };
  }
  const [member] = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.organizationId, row.organization.id), eq(members.userId, userId)))
    .limit(1);
  if (member) return { status: "accepted", invitation: view(row) };
  return { status: statusOf(row), invitation: view(row) };
};

function statusOf(row: { status: string; expiresAt: Date }) {
  if (row.status === "accepted") return "accepted" as const;
  if (row.status === "rejected" || row.status === "canceled") return "declined" as const;
  return row.expiresAt > new Date() ? ("pending" as const) : ("expired" as const);
}
