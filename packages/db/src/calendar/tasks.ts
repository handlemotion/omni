import {
  CALENDAR_TASK_BODY_MAX,
  CALENDAR_TASK_STEPS_MAX,
  CALENDAR_TASK_TITLE_MAX,
  type CalendarTaskPriority,
  type CalendarTaskStatus,
} from "@omni/contracts";
import { and, asc, desc, eq, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { loadMemberRow } from "../roles.ts";
import { calendarTasks } from "../schema/calendar.ts";
import { NOT_FOUND, type Ex } from "./core.ts";
import { logTaskChanges } from "./task-activity.ts";

export type TaskStatus = CalendarTaskStatus;
export type TaskPriority = CalendarTaskPriority;

/** A step of a task's checklist. */
export interface TaskStep {
  id: string;
  title: string;
  done: boolean;
}

export type TaskRecordKind = "company" | "person" | "deal";

/** The CRM record a task is on. The calendar keeps its kind and id and never reads it. */
export interface TaskRecord {
  kind: TaskRecordKind;
  id: string;
}

/** A task as the calendar keeps it (`docs/spec/calendar.md`, "Tasks"). */
export interface CalendarTask {
  id: string;
  orgId: string;
  /** Null only on a linked task whose owner left the workspace. */
  ownerMemberId: string | null;
  title: string;
  body: string | null;
  subtasks: TaskStep[];
  dueAt: Date | null;
  completedAt: Date | null;
  completedByMemberId: string | null;
  /** Always agrees with `completedAt`: `done` or `cancelled` only while it is set. */
  status: TaskStatus;
  priority: TaskPriority | null;
  assigneeMemberId: string | null;
  /** Null while it is private. */
  record: TaskRecord | null;
  createdByMemberId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A list's position: the last task's due time (open) or completion time (done), and its id. */
export interface TaskCursor {
  at: Date | null;
  id: string;
}

const TASK_TITLE_MAX = CALENDAR_TASK_TITLE_MAX;
const TASK_BODY_MAX = CALENDAR_TASK_BODY_MAX;
const TASK_STEPS_MAX = CALENDAR_TASK_STEPS_MAX;

export type InvalidTitle = { status: "invalid_title" };
export type CalendarTaskResult = { status: "ok"; task: CalendarTask } | typeof NOT_FOUND;

const columns = {
  id: calendarTasks.id,
  orgId: calendarTasks.orgId,
  ownerMemberId: calendarTasks.ownerMemberId,
  title: calendarTasks.title,
  body: calendarTasks.body,
  subtasks: calendarTasks.subtasks,
  dueAt: calendarTasks.dueAt,
  completedAt: calendarTasks.completedAt,
  completedByMemberId: calendarTasks.completedByMemberId,
  status: calendarTasks.status,
  priority: calendarTasks.priority,
  assigneeMemberId: calendarTasks.assigneeMemberId,
  recordKind: calendarTasks.recordKind,
  recordId: calendarTasks.recordId,
  createdByMemberId: calendarTasks.createdByMemberId,
  createdAt: calendarTasks.createdAt,
  updatedAt: calendarTasks.updatedAt,
};

type Row = { [K in keyof typeof columns]: (typeof columns)[K]["_"]["data"] | null } & {
  id: string;
  orgId: string;
  title: string;
  subtasks: TaskStep[];
  createdAt: Date;
  updatedAt: Date;
};

const isClosed = (status: TaskStatus) => status === "done" || status === "cancelled";

/**
 * The status a task reads: the one it keeps, unless that disagrees with `completed_at` (none
 * kept, or an older Worker completed or reopened it), when it is `done` or `todo`.
 */
export function statusOf(status: TaskStatus | null, completedAt: Date | null) {
  const closed = completedAt !== null;
  if (status && isClosed(status) === closed) return status;
  return closed ? "done" : "todo";
}

function toTask(row: Row) {
  const { recordKind, recordId, ...rest } = row;
  const record: TaskRecord | null =
    recordKind && recordId ? { kind: recordKind, id: recordId } : null;
  return { ...rest, status: statusOf(row.status, row.completedAt), record } as CalendarTask;
}

export const cleanTitle = (title: string) => {
  const text = title.trim().replaceAll(/\s+/g, " ");
  return text.length > 0 && text.length <= TASK_TITLE_MAX ? text : null;
};

export const cleanBody = (body: string | null | undefined) => {
  const text = body?.trim() ?? "";
  return text.length > 0 ? text.slice(0, TASK_BODY_MAX) : null;
};

export const cleanSteps = (steps: TaskStep[]) =>
  steps.slice(0, TASK_STEPS_MAX).flatMap((step) => {
    const title = step.title.trim().replaceAll(/\s+/g, " ").slice(0, TASK_TITLE_MAX);
    return title ? [{ id: step.id, title, done: step.done }] : [];
  });

export async function readTask(ex: Ex, orgId: string, id: string) {
  const [row] = await ex
    .select(columns)
    .from(calendarTasks)
    .where(and(eq(calendarTasks.orgId, orgId), eq(calendarTasks.id, id)));
  return row ? toTask(row as Row) : null;
}

/**
 * The task, locked until the transaction ends, so two changes to it run one after the other and
 * the second builds on the first.
 */
export async function lockTask(tx: Ex, orgId: string, id: string) {
  const [row] = await tx
    .select(columns)
    .from(calendarTasks)
    .where(and(eq(calendarTasks.orgId, orgId), eq(calendarTasks.id, id)))
    .for("update");
  return row ? toTask(row as Row) : null;
}

/** The workspace's member, or null when they are gone. */
export async function taskMember(ex: Ex, memberId: string) {
  const row = await loadMemberRow(ex, memberId);
  return row ? { id: row.id, orgId: row.orgId } : null;
}

export type TaskMember = NonNullable<Awaited<ReturnType<typeof taskMember>>>;

const mine = (member: TaskMember) =>
  and(
    eq(calendarTasks.orgId, member.orgId),
    or(eq(calendarTasks.ownerMemberId, member.id), eq(calendarTasks.assigneeMemberId, member.id)),
  );

function afterDue(cursor: TaskCursor) {
  if (!cursor.at) return and(isNull(calendarTasks.dueAt), sql`${calendarTasks.id} > ${cursor.id}`);
  const at = cursor.at.toISOString();
  return sql`(${calendarTasks.dueAt} > ${at}::timestamptz or (${calendarTasks.dueAt} = ${at}::timestamptz and ${calendarTasks.id} > ${cursor.id}) or ${calendarTasks.dueAt} is null)`;
}

function afterCompleted(cursor: TaskCursor) {
  const at = (cursor.at ?? new Date(0)).toISOString();
  return sql`(${calendarTasks.completedAt}, ${calendarTasks.id}) < (${at}::timestamptz, ${cursor.id})`;
}

export interface TaskQuery {
  /** `open` (the default) or `done`. */
  status?: "open" | "done";
  /** Open tasks only: due before now, due from now on, or with no due time. */
  due?: "overdue" | "upcoming" | "none";
  cursor?: TaskCursor | null;
  limit?: number;
}

function dueWhere(due: TaskQuery["due"]) {
  if (due === "overdue") return sql`${calendarTasks.dueAt} < now()`;
  if (due === "upcoming") return sql`${calendarTasks.dueAt} >= now()`;
  if (due === "none") return isNull(calendarTasks.dueAt);
  return undefined;
}

const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;

/**
 * Tasks matching `where`: open ones soonest due first and undated last, done ones most recently
 * completed first, a page at a time.
 */
export async function pageTasks(ex: Ex, where: SQL | undefined, query: TaskQuery) {
  const done = query.status === "done";
  const limit = Math.min(Math.max(query.limit ?? PAGE_DEFAULT, 1), PAGE_MAX);
  const rows = await ex
    .select(columns)
    .from(calendarTasks)
    .where(
      and(
        where,
        done ? isNotNull(calendarTasks.completedAt) : isNull(calendarTasks.completedAt),
        done ? undefined : dueWhere(query.due),
        query.cursor ? (done ? afterCompleted(query.cursor) : afterDue(query.cursor)) : undefined,
      ),
    )
    .orderBy(
      ...(done
        ? [desc(calendarTasks.completedAt), desc(calendarTasks.id)]
        : [sql`${calendarTasks.dueAt} asc nulls last`, asc(calendarTasks.id)]),
    )
    .limit(limit + 1);
  const tasks = rows.slice(0, limit).map((row) => toTask(row as Row));
  const last = tasks.at(-1);
  const nextCursor: TaskCursor | null =
    rows.length > limit && last ? { at: done ? last.completedAt : last.dueAt, id: last.id } : null;
  return { status: "ok" as const, tasks, nextCursor };
}

/** The member's tasks: the ones they own and the ones assigned to them, linked or not. */
export const ownTasks = (ex: Ex, member: TaskMember, query: TaskQuery) =>
  pageTasks(ex, mine(member), query);

/** One of the member's own tasks, or `not_found`: another member's private task is not there. */
export async function ownTask(ex: Ex, member: TaskMember, id: string) {
  const task = await readTask(ex, member.orgId, id);
  const theirs = task && (task.ownerMemberId === member.id || task.assigneeMemberId === member.id);
  const found: CalendarTaskResult = theirs ? { status: "ok", task } : NOT_FOUND;
  return found;
}

export interface OwnTaskInput {
  /** The id to give it; the CRM passes the id it already has. */
  id?: string;
  title: string;
  body?: string | null;
  subtasks?: TaskStep[];
  dueAt?: Date | null;
  priority?: TaskPriority | null;
}

/** A private task, owned by and assigned to the member. */
export async function createOwnTask(tx: Ex, member: TaskMember, input: OwnTaskInput) {
  const title = cleanTitle(input.title);
  if (!title) return { status: "invalid_title" } as InvalidTitle;
  const [made] = await tx
    .insert(calendarTasks)
    .values({
      ...(input.id ? { id: input.id } : {}),
      orgId: member.orgId,
      ownerMemberId: member.id,
      assigneeMemberId: member.id,
      title,
      body: cleanBody(input.body),
      subtasks: cleanSteps(input.subtasks ?? []),
      dueAt: input.dueAt ?? null,
      status: "todo",
      priority: input.priority ?? null,
      createdByMemberId: member.id,
    })
    .returning({ id: calendarTasks.id });
  return { status: "ok" as const, task: (await readTask(tx, member.orgId, made!.id))! };
}

/** What anyone who may change a task may change. Its record and assignee are the CRM's. */
export interface OwnTaskPatch {
  title?: string;
  body?: string | null;
  /** The whole checklist, replacing the one it has. */
  subtasks?: TaskStep[];
  dueAt?: Date | null;
  done?: boolean;
  /** Moves it; `done` or `cancelled` close it. Wins over `done`. */
  status?: TaskStatus;
  priority?: TaskPriority | null;
}

type TaskSet = Partial<typeof calendarTasks.$inferInsert>;

function nextStatus(current: TaskStatus, change: { done?: boolean; status?: TaskStatus }) {
  if (change.status) return change.status;
  if (change.done === undefined || change.done === isClosed(current)) return current;
  return change.done ? "done" : "todo";
}

/**
 * Where the task stands, and when it was closed and by whom, once `change` is applied by
 * `memberId`: closing a closed task, or reopening an open one, keeps when and by whom (a completer
 * who left stays unknown), and an empty change changes nothing. The calendar's and the CRM's
 * writes both go through it.
 */
export function completionAfter(
  current: Pick<CalendarTask, "status" | "completedAt" | "completedByMemberId">,
  change: { done?: boolean; status?: TaskStatus },
  memberId: string,
) {
  const status = nextStatus(current.status, change);
  const kept = {
    completedAt: current.completedAt,
    completedByMemberId: current.completedByMemberId,
  };
  if (isClosed(status) === Boolean(current.completedAt)) return { status, ...kept };
  return isClosed(status)
    ? { status, completedAt: new Date(), completedByMemberId: memberId }
    : { status, completedAt: null, completedByMemberId: null };
}

function setFor(memberId: string, current: CalendarTask, patch: OwnTaskPatch, title?: string) {
  const set: TaskSet = {};
  if (title !== undefined) set.title = title;
  if (patch.body !== undefined) set.body = cleanBody(patch.body);
  if (patch.subtasks !== undefined) set.subtasks = cleanSteps(patch.subtasks);
  if (patch.dueAt !== undefined) set.dueAt = patch.dueAt;
  if (patch.priority !== undefined) set.priority = patch.priority;
  const after = completionAfter(current, patch, memberId);
  if (after.status !== current.status) set.status = after.status;
  if (after.completedAt !== current.completedAt) Object.assign(set, after);
  return set;
}

/**
 * Changes a task the caller has already been let at (its owner or assignee, or for a linked task
 * anyone the CRM lets open its record). Completing a done task, or reopening an open one, changes
 * nothing.
 */
export async function changeTask(
  tx: Ex,
  orgId: string,
  memberId: string,
  id: string,
  patch: OwnTaskPatch,
) {
  const title = patch.title === undefined ? undefined : cleanTitle(patch.title);
  if (title === null) return { status: "invalid_title" } as InvalidTitle;
  const current = await lockTask(tx, orgId, id);
  if (!current) return NOT_FOUND;
  const set = setFor(memberId, current, patch, title);
  if (Object.keys(set).length > 0) {
    await tx
      .update(calendarTasks)
      .set(set)
      .where(and(eq(calendarTasks.orgId, orgId), eq(calendarTasks.id, id)));
  }
  const task = (await readTask(tx, orgId, id))!;
  await logTaskChanges(tx, memberId, current, task);
  return { status: "ok" as const, task };
}

export async function updateOwnTask(tx: Ex, member: TaskMember, id: string, patch: OwnTaskPatch) {
  const own = await ownTask(tx, member, id);
  if (own.status !== "ok") return own;
  return changeTask(tx, member.orgId, member.id, id, patch);
}

export async function removeTask(tx: Ex, orgId: string, id: string) {
  const task = await readTask(tx, orgId, id);
  if (!task) return NOT_FOUND;
  await tx
    .delete(calendarTasks)
    .where(and(eq(calendarTasks.orgId, orgId), eq(calendarTasks.id, id)));
  return { status: "ok" as const, task };
}

export async function deleteOwnTask(tx: Ex, member: TaskMember, id: string) {
  const own = await ownTask(tx, member, id);
  if (own.status !== "ok") return own;
  return removeTask(tx, member.orgId, id);
}
