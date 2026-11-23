import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { hasRole } from "../roles.ts";
import { members } from "../schema/auth.ts";
import { calendarTasks } from "../schema/calendar.ts";
import type { Ex } from "./core.ts";
import type { CalendarTask } from "./tasks.ts";

/**
 * Writes the task as given, made or replaced by id, and keeps its `updated_at`, so a copy of a
 * row reads the same from both tables: the CRM's dual-write and its copy job hand it over whole.
 * A linked task keeps the owner it has. A private one with no owner to give it is skipped.
 */
export async function putTask(tx: Ex, row: CalendarTask) {
  if (!row.record && !row.ownerMemberId) return { status: "skipped" as const };
  const values = {
    id: row.id,
    orgId: row.orgId,
    ownerMemberId: row.ownerMemberId,
    title: row.title,
    body: row.body,
    subtasks: row.subtasks,
    dueAt: row.dueAt,
    completedAt: row.completedAt,
    completedByMemberId: row.completedByMemberId,
    assigneeMemberId: row.record ? row.assigneeMemberId : row.ownerMemberId,
    recordKind: row.record?.kind ?? null,
    recordId: row.record?.id ?? null,
    createdByMemberId: row.createdByMemberId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  const { id: _id, orgId: _org, createdAt: _made, ...changed } = values;
  await tx
    .insert(calendarTasks)
    .values(values)
    .onConflictDoUpdate({
      target: calendarTasks.id,
      set: {
        ...changed,
        ownerMemberId: row.record
          ? sql`coalesce(${calendarTasks.ownerMemberId}, ${row.ownerMemberId})`
          : row.ownerMemberId,
      },
      setWhere: eq(calendarTasks.orgId, row.orgId),
    });
  return { status: "ok" as const };
}

/** When each of these tasks was last changed, by id; a task the calendar lacks is absent. */
export async function taskVersions(ex: Ex, orgIds: readonly string[], ids: readonly string[]) {
  if (ids.length === 0) return new Map<string, Date>();
  const rows = await ex
    .select({ id: calendarTasks.id, orgId: calendarTasks.orgId, at: calendarTasks.updatedAt })
    .from(calendarTasks)
    .where(and(inArray(calendarTasks.id, [...ids]), inArray(calendarTasks.orgId, [...orgIds])));
  return new Map(rows.map((row) => [row.id, row.at]));
}

/**
 * Whether the member is the workspace's only owner. Better Auth refuses to let them leave or be
 * removed, but the member-removed hooks run before it decides, so nothing may be let go for them.
 */
export async function isSoleOwner(ex: Ex, orgId: string, memberId: string) {
  const rows = await ex
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(eq(members.organizationId, orgId));
  const owners = rows.filter((row) => hasRole(row.role, "owner"));
  return owners.length === 1 && owners[0]!.id === memberId;
}

/**
 * A member is leaving the workspace: their private tasks go, and their linked ones stay on their
 * records, owned by nobody and assigned to nobody. Safe to run twice.
 */
export async function releaseMemberTasks(tx: Ex, orgId: string, memberId: string) {
  if (await isSoleOwner(tx, orgId, memberId)) return;
  const inOrg = eq(calendarTasks.orgId, orgId);
  await tx
    .delete(calendarTasks)
    .where(and(inOrg, isNull(calendarTasks.recordKind), eq(calendarTasks.ownerMemberId, memberId)));
  await tx
    .update(calendarTasks)
    .set({ ownerMemberId: null, updatedAt: sql`${calendarTasks.updatedAt}` })
    .where(and(inOrg, eq(calendarTasks.ownerMemberId, memberId)));
  await tx
    .update(calendarTasks)
    .set({ assigneeMemberId: null, updatedAt: sql`${calendarTasks.updatedAt}` })
    .where(and(inOrg, eq(calendarTasks.assigneeMemberId, memberId)));
}
