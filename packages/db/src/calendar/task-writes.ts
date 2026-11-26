import { and, eq, isNull, sql } from "drizzle-orm";
import { hasRole } from "../roles.ts";
import { members } from "../schema/auth.ts";
import { calendarTasks } from "../schema/calendar.ts";
import type { Ex } from "./core.ts";
import type { CalendarTask } from "./tasks.ts";

/** Writes a task the CRM made or changed, whole: inserted if new, else replaced in its workspace. */
export async function saveTask(tx: Ex, row: CalendarTask) {
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
    status: row.status,
    priority: row.priority,
    assigneeMemberId: row.assigneeMemberId,
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
      set: changed,
      setWhere: eq(calendarTasks.orgId, row.orgId),
    });
}

async function isSoleOwner(ex: Ex, orgId: string, memberId: string) {
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
