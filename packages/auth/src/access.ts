import { findEmailOwner, isCompany, MANAGER_ROLES, schema, type Db } from "@omni/db";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { SignUp } from "./env.ts";

/**
 * Who gets a magic link. With open sign-up, anyone: the link proves the address, and a new
 * address becomes a user with no workspace. With `invitation`, any of a known user's
 * sign-in emails, or an unknown email while it holds a pending, unexpired invitation.
 */
export async function maySignIn(db: Db, email: string, policy: SignUp = "open") {
  if (policy === "open") return true;
  const address = email.toLowerCase();
  return (await findEmailOwner(db, address)) !== null || (await hasPendingInvitation(db, address));
}

/**
 * Whether `userId` may create an organization in the app under `policy`. `open`: anyone signed
 * in (a new account's first step is its own workspace). `invitation`: only someone who already
 * owns one (they set up a second workspace); everyone else joins by invitation.
 */
export async function mayCreateOrganization(db: Db, userId: string, policy: SignUp = "open") {
  if (policy === "open") return true;
  const [owned] = await db
    .select({ id: schema.members.id })
    .from(schema.members)
    .where(
      and(
        eq(schema.members.userId, userId),
        eq(schema.members.role, "owner"),
        isCompany(db, schema.members.organizationId),
      ),
    )
    .limit(1);
  return owned !== undefined;
}

export async function hasPendingInvitation(db: Db, email: string) {
  const [invitation] = await db
    .select({ id: schema.invitations.id })
    .from(schema.invitations)
    .where(
      and(
        eq(sql`lower(${schema.invitations.email})`, email.toLowerCase()),
        eq(schema.invitations.status, "pending"),
        gt(schema.invitations.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return invitation !== undefined;
}

/** Whether `userId` is an owner or admin of `orgId`: the people who manage its billing. */
export async function mayManageBilling(db: Db, userId: string, orgId: string) {
  const [member] = await db
    .select({ id: schema.members.id })
    .from(schema.members)
    .where(
      and(
        eq(schema.members.userId, userId),
        eq(schema.members.organizationId, orgId),
        inArray(schema.members.role, MANAGER_ROLES),
      ),
    )
    .limit(1);
  return member !== undefined;
}
