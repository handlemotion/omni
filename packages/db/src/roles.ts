import { eq, sql, type SQLWrapper } from "drizzle-orm";
import type { Db } from "./client.ts";
import { members } from "./schema/auth.ts";

const rolesOf = (role: string) => role.split(",").map((one) => one.trim());

/** Better Auth stores a member's roles as one comma-separated string in `members.role`. */
export const hasRole = (role: string, wanted: string) => rolesOf(role).includes(wanted);

/** Owner or admin of the workspace. */
export const isAdmin = (role: string) =>
  rolesOf(role).some((one) => one === "owner" || one === "admin");

/** Any role but a freelancer's alone. Owners and admins are teammates. */
export const isTeammate = (role: string) => rolesOf(role).some((one) => one !== "freelancer");

/** SQL twin of `hasRole`, for a `members.role` column. */
export const sqlHasRole = (column: SQLWrapper, role: string) =>
  sql<boolean>`${role} = any(string_to_array(replace(${column}, ' ', ''), ','))`;

/** The member row every module starts from; null when they are gone. */
export async function loadMemberRow(ex: Pick<Db, "select">, memberId: string) {
  const [row] = await ex
    .select({
      id: members.id,
      orgId: members.organizationId,
      userId: members.userId,
      role: members.role,
    })
    .from(members)
    .where(eq(members.id, memberId));
  return row ?? null;
}
