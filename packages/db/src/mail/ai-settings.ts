import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { mailboxAccess, mailboxes, memberRoleDescriptions, members } from "../schema/index.ts";
import { orgMember } from "./workspace-mailboxes.ts";

/** A role description's longest form; the settings page and the API cap it here. */
export const MAX_ROLE_DESCRIPTION = 500;
/** At most this many teammates are offered to triage for one inbox. */
export const HELPDESK_TEAMMATES_FOR_AI = 10;

/** Every member's role description in the workspace, by member id. */
export async function listMemberRoleDescriptions(db: Db, orgId: string) {
  const rows = await db
    .select({
      memberId: memberRoleDescriptions.memberId,
      description: memberRoleDescriptions.description,
    })
    .from(memberRoleDescriptions)
    .where(eq(memberRoleDescriptions.orgId, orgId));
  return new Map(rows.map((row) => [row.memberId, row.description]));
}

/**
 * Sets what a member of the workspace handles; blank clears it, and then AI never assigns them.
 * False when they are not a member of `orgId`. Idempotent.
 */
export async function setMemberRoleDescription(
  db: Db,
  orgId: string,
  memberId: string,
  description: string,
) {
  if (!(await orgMember(db, orgId, memberId))) return false;
  const text = description.trim();
  if (!text) {
    await db
      .delete(memberRoleDescriptions)
      .where(
        and(eq(memberRoleDescriptions.memberId, memberId), eq(memberRoleDescriptions.orgId, orgId)),
      );
    return true;
  }
  await db
    .insert(memberRoleDescriptions)
    .values({ memberId, orgId, description: text })
    .onConflictDoUpdate({
      target: memberRoleDescriptions.memberId,
      set: { description: text, orgId, updatedAt: new Date() },
    });
  return true;
}

/**
 * Who triage may hand a shared inbox's conversation to: members of its org who can see it and
 * have a role description, ordered by that description (stable across workspaces and ids, so the
 * same team always sends the same request).
 */
export async function helpdeskTeammatesForAi(db: Db, mailboxId: string) {
  return db
    .select({ id: members.id, role: memberRoleDescriptions.description })
    .from(mailboxAccess)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxAccess.mailboxId))
    .innerJoin(
      members,
      and(eq(members.id, mailboxAccess.memberId), eq(members.organizationId, mailboxes.orgId)),
    )
    .innerJoin(
      memberRoleDescriptions,
      and(
        eq(memberRoleDescriptions.memberId, members.id),
        eq(memberRoleDescriptions.orgId, mailboxes.orgId),
      ),
    )
    .where(eq(mailboxAccess.mailboxId, mailboxId))
    .orderBy(asc(sql`lower(${memberRoleDescriptions.description})`), asc(members.id))
    .limit(HELPDESK_TEAMMATES_FOR_AI);
}
