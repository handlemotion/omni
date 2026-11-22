import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import {
  isSoleOwner,
  putTask,
  taskVersions,
  type CalendarTask,
  type TaskMirror,
  type TaskRecord,
  type TaskRow,
} from "../calendar.ts";
import { members } from "../schema/auth.ts";
import { crmTasks } from "../schema/crm/tasks.ts";
import { hasRole, type Ex } from "./core.ts";

type CrmTaskRow = typeof crmTasks.$inferSelect;

const recordOf = (row: CrmTaskRow) => {
  let record: TaskRecord | null = null;
  if (row.companyId) record = { kind: "company", id: row.companyId };
  else if (row.personId) record = { kind: "person", id: row.personId };
  else if (row.dealId) record = { kind: "deal", id: row.dealId };
  return record;
};

async function workspaceOwner(ex: Ex, orgId: string) {
  const rows = await ex
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(eq(members.organizationId, orgId))
    .orderBy(asc(members.createdAt), asc(members.id));
  return rows.find((row) => hasRole(row.role, "owner"))?.id ?? null;
}

async function calendarRowOf(ex: Ex, row: CrmTaskRow) {
  const record = recordOf(row);
  const ownerMemberId = record
    ? row.createdByMemberId
    : (row.assigneeMemberId ?? row.createdByMemberId ?? (await workspaceOwner(ex, row.orgId)));
  const task: TaskRow = {
    id: row.id,
    orgId: row.orgId,
    ownerMemberId,
    title: row.title,
    body: row.body,
    subtasks: row.subtasks,
    dueAt: row.dueAt,
    completedAt: row.completedAt,
    completedByMemberId: row.completedByMemberId,
    assigneeMemberId: record ? row.assigneeMemberId : ownerMemberId,
    record,
    createdByMemberId: row.createdByMemberId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  return task;
}

/**
 * The dual write, until `crm_tasks` is dropped (T4): a task on a record reads the same from
 * `crm_tasks` as from the calendar, keyed by the same id, so a Worker that still reads
 * `crm_tasks` finds it whole. A private task is never written there.
 */
export async function writeCrmTask(tx: Ex, task: CalendarTask) {
  if (!task.record) return dropCrmTask(tx, task.orgId, task.id);
  const values = {
    id: task.id,
    orgId: task.orgId,
    title: task.title,
    body: task.body,
    subtasks: task.subtasks,
    companyId: task.record.kind === "company" ? task.record.id : null,
    personId: task.record.kind === "person" ? task.record.id : null,
    dealId: task.record.kind === "deal" ? task.record.id : null,
    assigneeMemberId: task.assigneeMemberId,
    dueAt: task.dueAt,
    completedAt: task.completedAt,
    completedByMemberId: task.completedByMemberId,
    createdByMemberId: task.createdByMemberId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
  const { id: _id, orgId: _org, createdAt: _made, ...changed } = values;
  await tx
    .insert(crmTasks)
    .values(values)
    .onConflictDoUpdate({
      target: crmTasks.id,
      set: changed,
      setWhere: eq(crmTasks.orgId, task.orgId),
    });
}

/** The task is gone, or private now: `crm_tasks` no longer holds it, and the copy job brings nothing back. */
export async function dropCrmTask(tx: Ex, orgId: string, id: string) {
  await tx.delete(crmTasks).where(and(eq(crmTasks.orgId, orgId), eq(crmTasks.id, id)));
}

/** What the calendar's door calls when a member changes their own task outside the CRM. */
export const crmTaskMirror: TaskMirror = {
  put: writeCrmTask,
  drop: dropCrmTask,
};

export const TASK_COPY_BATCH = 500;
export const TASK_COPY_PAGES = 40;

async function firstIdOfRun(db: Db, batch: number, pages: number, now: Date) {
  const [{ total } = { total: 0 }] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(crmTasks);
  const pagesInAll = Math.ceil(total / batch);
  if (pagesInAll <= pages) return "";
  const runs = Math.ceil(pagesInAll / pages);
  const run = Math.floor(now.getTime() / 60_000) % runs;
  if (run === 0) return "";
  const [before] = await db
    .select({ id: crmTasks.id })
    .from(crmTasks)
    .orderBy(asc(crmTasks.id))
    .offset(run * pages * batch - 1)
    .limit(1);
  return before?.id ?? "";
}

/**
 * Copies the `crm_tasks` rows the calendar lacks or holds older, a page at a time in id order.
 * Each run reads at most `pages` pages; a table longer than that is read in turns, one stretch a
 * minute, so every row is reached. Idempotent: a second pass copies nothing.
 */
export async function copyTasksToCalendar(
  db: Db,
  { batch = TASK_COPY_BATCH, pages = TASK_COPY_PAGES, now = new Date() } = {},
) {
  let copied = 0;
  let after = await firstIdOfRun(db, batch, pages, now);
  for (let page = 0; page < pages; page++) {
    const rows = await db
      .select()
      .from(crmTasks)
      .where(gt(crmTasks.id, after))
      .orderBy(asc(crmTasks.id))
      .limit(batch);
    if (rows.length === 0) break;
    after = rows.at(-1)!.id;
    const orgIds = [...new Set(rows.map((row) => row.orgId))];
    const held = await taskVersions(
      db,
      orgIds,
      rows.map((row) => row.id),
    );
    const stale = rows.filter((row) => {
      const at = held.get(row.id);
      return !at || at.getTime() < row.updatedAt.getTime();
    });
    for (const row of stale) {
      const done = await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(crmTasks)
          .where(inArray(crmTasks.id, [row.id]))
          .for("update");
        return current ? putTask(tx, await calendarRowOf(tx, current)) : null;
      });
      if (done?.status === "ok") copied++;
    }
    if (rows.length < batch) break;
  }
  return { copied };
}

/**
 * A member is leaving: the `crm_tasks` rows that became their private tasks go too, so the copy
 * job does not bring back, for someone else, what left with them. Safe to run twice.
 */
export async function releaseCrmTasks(db: Db, input: { orgId: string; memberId: string }) {
  if (await isSoleOwner(db, input.orgId, input.memberId)) return;
  await db
    .delete(crmTasks)
    .where(
      and(
        eq(crmTasks.orgId, input.orgId),
        isNull(crmTasks.companyId),
        isNull(crmTasks.personId),
        isNull(crmTasks.dealId),
        or(
          eq(crmTasks.assigneeMemberId, input.memberId),
          and(isNull(crmTasks.assigneeMemberId), eq(crmTasks.createdByMemberId, input.memberId)),
        ),
      ),
    );
}
