import { and, desc, eq } from "drizzle-orm";
import { calendarTaskActivity } from "../schema/calendar.ts";
import type { Ex } from "./core.ts";
import type { CalendarTask, TaskPriority, TaskRecord, TaskStatus } from "./tasks.ts";

/** A record as an activity item keeps it: with its name as it was then, which the CRM gives. */
export interface ActivityRecord extends TaskRecord {
  name: string | null;
}

/** A field that changed, with its value before and after. */
export type TaskActivity =
  | { kind: "status"; from: TaskStatus; to: TaskStatus }
  | { kind: "priority"; from: TaskPriority | null; to: TaskPriority | null }
  | { kind: "assignee"; from: string | null; to: string | null }
  | { kind: "due"; from: Date | null; to: Date | null }
  | { kind: "record"; from: ActivityRecord | null; to: ActivityRecord | null };

export type TaskActivityItem = TaskActivity & {
  id: string;
  actorMemberId: string | null;
  at: Date;
};

/** The names of the records a change moved a task between, for its activity. */
export type RecordNames = (record: TaskRecord) => string | null;

const ITEMS_MAX = 200;

const sameRecord = (a: TaskRecord | null, b: TaskRecord | null) =>
  a?.kind === b?.kind && a?.id === b?.id;

const named = (record: TaskRecord | null, names?: RecordNames) =>
  record && { kind: record.kind, id: record.id, name: names?.(record) ?? null };

/** What changed between `before` and `after` that a task's activity shows. */
export function changesOf(before: CalendarTask, after: CalendarTask, names?: RecordNames) {
  const changes: TaskActivity[] = [];
  if (before.status !== after.status) {
    changes.push({ kind: "status", from: before.status, to: after.status });
  }
  if (before.priority !== after.priority) {
    changes.push({ kind: "priority", from: before.priority, to: after.priority });
  }
  if (!sameRecord(before.record, after.record)) {
    const from = named(before.record, names);
    changes.push({ kind: "record", from, to: named(after.record, names) });
  }
  if (before.assigneeMemberId !== after.assigneeMemberId) {
    changes.push({ kind: "assignee", from: before.assigneeMemberId, to: after.assigneeMemberId });
  }
  if (before.dueAt?.getTime() !== after.dueAt?.getTime()) {
    changes.push({ kind: "due", from: before.dueAt, to: after.dueAt });
  }
  return changes;
}

const stored = (value: unknown) => (value instanceof Date ? value.toISOString() : value);

/** Writes what `memberId` changed on the task, one item per field, in the same transaction. */
export async function logTaskChanges(
  tx: Ex,
  memberId: string,
  before: CalendarTask,
  after: CalendarTask,
  names?: RecordNames,
) {
  const changes = changesOf(before, after, names);
  if (changes.length === 0) return;
  await tx.insert(calendarTaskActivity).values(
    changes.map((change) => ({
      orgId: after.orgId,
      taskId: after.id,
      actorMemberId: memberId,
      kind: change.kind,
      change: { from: stored(change.from), to: stored(change.to) },
    })),
  );
}

type Row = typeof calendarTaskActivity.$inferSelect;

const dateOrNull = (value: unknown) => (typeof value === "string" ? new Date(value) : null);

function itemOf(row: Row) {
  const base = { id: row.id, actorMemberId: row.actorMemberId, at: row.createdAt };
  const { change } = row;
  if (row.kind === "due") {
    return { ...base, kind: row.kind, from: dateOrNull(change.from), to: dateOrNull(change.to) };
  }
  return { ...base, kind: row.kind, from: change.from, to: change.to } as TaskActivityItem;
}

/** The task's latest items, oldest first. The caller has checked the member may read the task. */
export async function readTaskActivity(ex: Ex, orgId: string, taskId: string) {
  const rows = await ex
    .select()
    .from(calendarTaskActivity)
    .where(and(eq(calendarTaskActivity.orgId, orgId), eq(calendarTaskActivity.taskId, taskId)))
    .orderBy(desc(calendarTaskActivity.createdAt), desc(calendarTaskActivity.id))
    .limit(ITEMS_MAX);
  return rows.reverse().map(itemOf);
}
