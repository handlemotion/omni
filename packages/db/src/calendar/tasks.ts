import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { members } from "../schema/auth.ts";
import { calendarTasks } from "../schema/calendar.ts";
import { NOT_FOUND, type Ex } from "./core.ts";

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

export const TASK_TITLE_MAX = 500;
export const TASK_BODY_MAX = 20_000;
export const TASK_STEPS_MAX = 100;

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

function toTask(row: Row) {
  const { recordKind, recordId, ...rest } = row;
  const record: TaskRecord | null =
    recordKind && recordId ? { kind: recordKind, id: recordId } : null;
  return { ...rest, record } as CalendarTask;
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
  const [row] = await ex
    .select({ id: members.id, orgId: members.organizationId })
    .from(members)
    .where(eq(members.id, memberId));
  return row ?? null;
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
}

/**
 * Keeps another table in step with the calendar's linked tasks while it is still read (the CRM's
 * `crm_tasks`, until T4). It is handed a changed task only while the task is on a record, and
 * every task deleted.
 */
export interface TaskMirror {
  put: (tx: Ex, task: CalendarTask) => Promise<unknown>;
  drop: (tx: Ex, orgId: string, id: string) => Promise<unknown>;
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
}

type TaskSet = Partial<typeof calendarTasks.$inferInsert>;

function setFor(memberId: string, current: CalendarTask, patch: OwnTaskPatch, title?: string) {
  const set: TaskSet = {};
  if (title !== undefined) set.title = title;
  if (patch.body !== undefined) set.body = cleanBody(patch.body);
  if (patch.subtasks !== undefined) set.subtasks = cleanSteps(patch.subtasks);
  if (patch.dueAt !== undefined) set.dueAt = patch.dueAt;
  if (patch.done === true && !current.completedAt) {
    set.completedAt = new Date();
    set.completedByMemberId = memberId;
  }
  if (patch.done === false && current.completedAt) {
    set.completedAt = null;
    set.completedByMemberId = null;
  }
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
  return { status: "ok" as const, task: (await readTask(tx, orgId, id))! };
}

export async function updateOwnTask(
  tx: Ex,
  member: TaskMember,
  id: string,
  patch: OwnTaskPatch,
  mirror?: TaskMirror,
) {
  const own = await ownTask(tx, member, id);
  if (own.status !== "ok") return own;
  const changed = await changeTask(tx, member.orgId, member.id, id, patch);
  if (changed.status === "ok" && changed.task.record) await mirror?.put(tx, changed.task);
  return changed;
}

export async function removeTask(tx: Ex, orgId: string, id: string) {
  const task = await readTask(tx, orgId, id);
  if (!task) return NOT_FOUND;
  await tx
    .delete(calendarTasks)
    .where(and(eq(calendarTasks.orgId, orgId), eq(calendarTasks.id, id)));
  return { status: "ok" as const, task };
}

export async function deleteOwnTask(tx: Ex, member: TaskMember, id: string, mirror?: TaskMirror) {
  const own = await ownTask(tx, member, id);
  if (own.status !== "ok") return own;
  await mirror?.drop(tx, member.orgId, id);
  return removeTask(tx, member.orgId, id);
}

/** A whole task as another module hands it over: the CRM's dual-write and its copy job. */
export interface TaskRow {
  id: string;
  orgId: string;
  ownerMemberId: string | null;
  title: string;
  body: string | null;
  subtasks: TaskStep[];
  dueAt: Date | null;
  completedAt: Date | null;
  completedByMemberId: string | null;
  assigneeMemberId: string | null;
  record: TaskRecord | null;
  createdByMemberId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Writes the task as given, made or replaced by id, and keeps its `updated_at`, so a copy of a
 * row reads the same from both tables. A linked task keeps the owner it has. A private one with
 * no owner to give it is skipped.
 */
export async function putTask(tx: Ex, row: TaskRow) {
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

/** The tasks on a record, open and done, for the CRM to delete or show after its own check. */
export async function tasksOnRecord(ex: Ex, orgId: string, record: TaskRecord) {
  const rows = await ex
    .select(columns)
    .from(calendarTasks)
    .where(
      and(
        eq(calendarTasks.orgId, orgId),
        eq(calendarTasks.recordKind, record.kind),
        eq(calendarTasks.recordId, record.id),
      ),
    );
  return rows.map((row) => toTask(row as Row));
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

/**
 * Whether the member is the workspace's only owner. Better Auth refuses to let them leave or be
 * removed, but the member-removed hooks run before it decides, so nothing may be let go for them.
 */
export async function isSoleOwner(ex: Ex, orgId: string, memberId: string) {
  const rows = await ex
    .select({ id: members.id, role: members.role })
    .from(members)
    .where(eq(members.organizationId, orgId));
  const owners = rows.filter((row) => row.role.split(",").some((role) => role.trim() === "owner"));
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
