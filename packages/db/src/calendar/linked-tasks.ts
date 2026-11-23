import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { calendarTasks } from "../schema/calendar.ts";
import type { Ex } from "./core.ts";
import { pageTasks, type TaskQuery, type TaskRecord, type TaskRecordKind } from "./tasks.ts";

/** Which linked tasks the CRM lists, after it checked who may see what. */
export interface LinkedTaskFilter {
  /** A member's id, or null for unassigned. Absent: anyone's. */
  assigneeMemberId?: string | null;
  record?: TaskRecord;
  /** A freelancer's view: tasks on these deals, or assigned to `orAssignedTo`. */
  dealIds?: string[];
  orAssignedTo?: string;
  /** Words the title contains. */
  q?: string;
}

function titleMatches(q: string | undefined) {
  const words = (q ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 8);
  const escape = (word: string) => word.replaceAll(/[\\%_]/g, (c) => `\\${c}`);
  return words.length
    ? and(...words.map((w) => sql`${calendarTasks.title} ilike ${`%${escape(w)}%`}`))
    : undefined;
}

function assigneeWhere(assignee: string | null | undefined) {
  if (assignee === undefined) return undefined;
  return assignee === null
    ? isNull(calendarTasks.assigneeMemberId)
    : eq(calendarTasks.assigneeMemberId, assignee);
}

function narrowedTo(filter: LinkedTaskFilter) {
  if (!filter.dealIds) return undefined;
  const onDeals = filter.dealIds.length
    ? and(eq(calendarTasks.recordKind, "deal"), inArray(calendarTasks.recordId, filter.dealIds))
    : undefined;
  const assigned = filter.orAssignedTo
    ? eq(calendarTasks.assigneeMemberId, filter.orAssignedTo)
    : undefined;
  return or(onDeals, assigned) ?? sql`false`;
}

/** The workspace's tasks on CRM records: never a private one. */
export function linkedTasks(ex: Ex, orgId: string, filter: LinkedTaskFilter, query: TaskQuery) {
  const where = and(
    eq(calendarTasks.orgId, orgId),
    isNotNull(calendarTasks.recordKind),
    assigneeWhere(filter.assigneeMemberId),
    filter.record
      ? and(
          eq(calendarTasks.recordKind, filter.record.kind),
          eq(calendarTasks.recordId, filter.record.id),
        )
      : undefined,
    narrowedTo(filter),
    titleMatches(filter.q),
  );
  return pageTasks(ex, where, query);
}

/** Open linked tasks: the member's, the member's overdue, everyone's and everyone's overdue. */
export async function countLinkedTasks(ex: Ex, orgId: string, memberId: string) {
  const assigned = sql`${calendarTasks.assigneeMemberId} = ${memberId}`;
  const overdue = sql`${calendarTasks.dueAt} < now()`;
  const [row] = await ex
    .select({
      mine: sql<number>`count(*) filter (where ${assigned})::int`,
      mineOverdue: sql<number>`count(*) filter (where ${assigned} and ${overdue})::int`,
      open: sql<number>`count(*)::int`,
      overdue: sql<number>`count(*) filter (where ${overdue})::int`,
    })
    .from(calendarTasks)
    .where(
      and(
        eq(calendarTasks.orgId, orgId),
        isNotNull(calendarTasks.recordKind),
        isNull(calendarTasks.completedAt),
      ),
    );
  return row ?? { mine: 0, mineOverdue: 0, open: 0, overdue: 0 };
}

/** Deletes the tasks on these records: the CRM deleted them. */
export async function dropTasksOn(tx: Ex, orgId: string, kind: TaskRecordKind, ids: string[]) {
  if (ids.length === 0) return;
  await tx
    .delete(calendarTasks)
    .where(
      and(
        eq(calendarTasks.orgId, orgId),
        eq(calendarTasks.recordKind, kind),
        inArray(calendarTasks.recordId, ids),
      ),
    );
}
