import { and, asc, desc, eq, ilike, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { members } from "../schema/auth.ts";
import { crmCompanies, crmDeals, crmPeople } from "../schema/crm.ts";
import { crmTasks } from "../schema/crm/tasks.ts";
import { NOT_FOUND, pageSize, type CrmMember, type CrmRecordRef, type Ex } from "./core.ts";
import { recordExists } from "./notes.ts";

/** A task, with the name of the record it is on. */
export interface CrmTask {
  id: string;
  title: string;
  body: string | null;
  companyId: string | null;
  personId: string | null;
  dealId: string | null;
  /** The company's, person's or deal's name; null on a task on no record. */
  recordName: string | null;
  assigneeMemberId: string | null;
  dueAt: Date | null;
  completedAt: Date | null;
  completedByMemberId: string | null;
  createdByMemberId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A list's position: the last task's due time (open) or completion time (done), and its id. */
export interface CrmTaskCursor {
  at: Date | null;
  id: string;
}

export interface ListTasksInput {
  /** `open` (the default) or `done`. */
  status?: "open" | "done";
  /** A member's id, or null for unassigned. Absent: anyone's. */
  assigneeMemberId?: string | null;
  /** Open tasks only: due before now, due from now on, or with no due time. */
  due?: "overdue" | "upcoming" | "none";
  record?: CrmRecordRef;
  /** Words the title contains. */
  q?: string;
  cursor?: CrmTaskCursor | null;
  limit?: number;
}

export interface TaskInput {
  title: string;
  body?: string | null;
  /** Absent: the creator. Null: unassigned. */
  assigneeMemberId?: string | null;
  dueAt?: Date | null;
  record?: CrmRecordRef | null;
}

export interface TaskPatch {
  title?: string;
  body?: string | null;
  assigneeMemberId?: string | null;
  dueAt?: Date | null;
  done?: boolean;
  /** Moves the task to this record; null takes it off its record. */
  record?: CrmRecordRef | null;
}

export type InvalidTitle = { status: "invalid_title" };
export type InvalidAssignee = { status: "invalid_assignee" };
export type TaskResult =
  | { status: "ok"; task: CrmTask }
  | typeof NOT_FOUND
  | InvalidTitle
  | InvalidAssignee;

export const CRM_TASK_TITLE_MAX = 500;
export const CRM_TASK_BODY_MAX = 20_000;

const taskColumns = {
  id: crmTasks.id,
  title: crmTasks.title,
  body: crmTasks.body,
  companyId: crmTasks.companyId,
  personId: crmTasks.personId,
  dealId: crmTasks.dealId,
  recordName: sql<
    string | null
  >`coalesce(${crmCompanies.name}, ${crmPeople.name}, ${crmDeals.name})`.as("record_name"),
  assigneeMemberId: crmTasks.assigneeMemberId,
  dueAt: crmTasks.dueAt,
  completedAt: crmTasks.completedAt,
  completedByMemberId: crmTasks.completedByMemberId,
  createdByMemberId: crmTasks.createdByMemberId,
  createdAt: crmTasks.createdAt,
  updatedAt: crmTasks.updatedAt,
};

const selectTasks = (ex: Ex) =>
  ex
    .select(taskColumns)
    .from(crmTasks)
    .leftJoin(crmCompanies, eq(crmCompanies.id, crmTasks.companyId))
    .leftJoin(crmPeople, eq(crmPeople.id, crmTasks.personId))
    .leftJoin(crmDeals, eq(crmDeals.id, crmTasks.dealId));

const cleanTitle = (title: string) => {
  const text = title.trim().replaceAll(/\s+/g, " ");
  return text.length > 0 && text.length <= CRM_TASK_TITLE_MAX ? text : null;
};

const cleanBody = (body: string | null | undefined) => {
  const text = body?.trim() ?? "";
  return text.length > 0 ? text.slice(0, CRM_TASK_BODY_MAX) : null;
};

const target = (record: CrmRecordRef | null | undefined) => ({
  companyId: record && "companyId" in record ? record.companyId : null,
  personId: record && "personId" in record ? record.personId : null,
  dealId: record && "dealId" in record ? record.dealId : null,
});

function recordWhere(record: CrmRecordRef) {
  if ("companyId" in record) return eq(crmTasks.companyId, record.companyId);
  if ("personId" in record) return eq(crmTasks.personId, record.personId);
  return eq(crmTasks.dealId, record.dealId);
}

async function isMemberOf(ex: Ex, orgId: string, memberId: string) {
  const [row] = await ex
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.id, memberId), eq(members.organizationId, orgId)));
  return Boolean(row);
}

async function checkReferences(
  ex: Ex,
  member: CrmMember,
  input: { assigneeMemberId?: string | null; record?: CrmRecordRef | null },
) {
  if (input.assigneeMemberId && !(await isMemberOf(ex, member.orgId, input.assigneeMemberId))) {
    return { status: "invalid_assignee" } as const;
  }
  if (input.record && !(await recordExists(ex, member.orgId, input.record))) return NOT_FOUND;
  return null;
}

async function readTask(ex: Ex, orgId: string, id: string) {
  const [task] = await selectTasks(ex).where(and(eq(crmTasks.orgId, orgId), eq(crmTasks.id, id)));
  return task;
}

export const getTask: (ex: Ex, member: CrmMember, id: string) => Promise<TaskResult> = async (
  ex,
  member,
  id,
) => {
  const task = await readTask(ex, member.orgId, id);
  return task ? { status: "ok", task } : NOT_FOUND;
};

function afterDue(cursor: CrmTaskCursor) {
  if (!cursor.at) return and(isNull(crmTasks.dueAt), sql`${crmTasks.id} > ${cursor.id}`);
  const at = cursor.at.toISOString();
  return sql`(${crmTasks.dueAt} > ${at}::timestamptz or (${crmTasks.dueAt} = ${at}::timestamptz and ${crmTasks.id} > ${cursor.id}) or ${crmTasks.dueAt} is null)`;
}

function afterCompleted(cursor: CrmTaskCursor) {
  const at = (cursor.at ?? new Date(0)).toISOString();
  return sql`(${crmTasks.completedAt}, ${crmTasks.id}) < (${at}::timestamptz, ${cursor.id})`;
}

function dueWhere(due: ListTasksInput["due"]) {
  if (due === "overdue") return sql`${crmTasks.dueAt} < now()`;
  if (due === "upcoming") return sql`${crmTasks.dueAt} >= now()`;
  if (due === "none") return isNull(crmTasks.dueAt);
  return undefined;
}

function titleMatches(q: string | undefined) {
  const words = (q ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 8);
  const escape = (word: string) => word.replaceAll(/[\\%_]/g, (c) => `\\${c}`);
  return words.length
    ? and(...words.map((w) => ilike(crmTasks.title, `%${escape(w)}%`)))
    : undefined;
}

/**
 * The workspace's tasks: open ones soonest due first and undated last, done ones most recently
 * completed first.
 */
export async function listTasks(ex: Ex, member: CrmMember, input: ListTasksInput) {
  const done = input.status === "done";
  const limit = pageSize(input.limit);
  const assignee =
    input.assigneeMemberId === undefined
      ? undefined
      : input.assigneeMemberId === null
        ? isNull(crmTasks.assigneeMemberId)
        : eq(crmTasks.assigneeMemberId, input.assigneeMemberId);
  const where: (SQL | undefined)[] = [
    eq(crmTasks.orgId, member.orgId),
    done ? isNotNull(crmTasks.completedAt) : isNull(crmTasks.completedAt),
    assignee,
    done ? undefined : dueWhere(input.due),
    input.record ? recordWhere(input.record) : undefined,
    titleMatches(input.q),
    input.cursor ? (done ? afterCompleted(input.cursor) : afterDue(input.cursor)) : undefined,
  ];
  const rows = await selectTasks(ex)
    .where(and(...where))
    .orderBy(
      ...(done
        ? [desc(crmTasks.completedAt), desc(crmTasks.id)]
        : [sql`${crmTasks.dueAt} asc nulls last`, asc(crmTasks.id)]),
    )
    .limit(limit + 1);
  const tasks = rows.slice(0, limit);
  const last = tasks.at(-1);
  const nextCursor: CrmTaskCursor | null =
    rows.length > limit && last ? { at: done ? last.completedAt : last.dueAt, id: last.id } : null;
  return { status: "ok" as const, tasks, nextCursor };
}

/** Open tasks: the member's, the member's overdue, everyone's and everyone's overdue. */
export async function countTasks(ex: Ex, member: CrmMember) {
  const mine = sql`${crmTasks.assigneeMemberId} = ${member.id}`;
  const overdue = sql`${crmTasks.dueAt} < now()`;
  const [row] = await ex
    .select({
      mine: sql<number>`count(*) filter (where ${mine})::int`,
      mineOverdue: sql<number>`count(*) filter (where ${mine} and ${overdue})::int`,
      open: sql<number>`count(*)::int`,
      overdue: sql<number>`count(*) filter (where ${overdue})::int`,
    })
    .from(crmTasks)
    .where(and(eq(crmTasks.orgId, member.orgId), isNull(crmTasks.completedAt)));
  return { status: "ok" as const, counts: row ?? { mine: 0, mineOverdue: 0, open: 0, overdue: 0 } };
}

export const createTask: (
  tx: Ex,
  member: CrmMember,
  input: TaskInput,
) => Promise<TaskResult> = async (tx, member, input) => {
  const title = cleanTitle(input.title);
  if (!title) return { status: "invalid_title" };
  const refused = await checkReferences(tx, member, input);
  if (refused) return refused;
  const [made] = await tx
    .insert(crmTasks)
    .values({
      orgId: member.orgId,
      title,
      body: cleanBody(input.body),
      ...target(input.record),
      assigneeMemberId: input.assigneeMemberId === undefined ? member.id : input.assigneeMemberId,
      dueAt: input.dueAt ?? null,
      createdByMemberId: member.id,
    })
    .returning({ id: crmTasks.id });
  return { status: "ok", task: (await readTask(tx, member.orgId, made!.id))! };
};

type TaskSet = Partial<typeof crmTasks.$inferInsert>;

function setFor(
  member: CrmMember,
  current: { completedAt: Date | null },
  patch: TaskPatch,
  title: string | undefined,
) {
  const set: TaskSet = {};
  if (title !== undefined) set.title = title;
  if (patch.body !== undefined) set.body = cleanBody(patch.body);
  if (patch.assigneeMemberId !== undefined) set.assigneeMemberId = patch.assigneeMemberId;
  if (patch.dueAt !== undefined) set.dueAt = patch.dueAt;
  if (patch.record !== undefined) Object.assign(set, target(patch.record));
  if (patch.done === true && !current.completedAt) {
    set.completedAt = new Date();
    set.completedByMemberId = member.id;
  }
  if (patch.done === false && current.completedAt) {
    set.completedAt = null;
    set.completedByMemberId = null;
  }
  return set;
}

/** Any member changes any task. Completing a done task, or reopening an open one, changes nothing. */
export const updateTask: (
  tx: Ex,
  member: CrmMember,
  id: string,
  patch: TaskPatch,
) => Promise<TaskResult> = async (tx, member, id, patch) => {
  const title = patch.title === undefined ? undefined : cleanTitle(patch.title);
  if (title === null) return { status: "invalid_title" };
  const [current] = await tx
    .select({ completedAt: crmTasks.completedAt })
    .from(crmTasks)
    .where(and(eq(crmTasks.orgId, member.orgId), eq(crmTasks.id, id)))
    .for("update");
  if (!current) return NOT_FOUND;
  const refused = await checkReferences(tx, member, patch);
  if (refused) return refused;
  const set = setFor(member, current, patch, title);
  if (Object.keys(set).length > 0) await tx.update(crmTasks).set(set).where(eq(crmTasks.id, id));
  return { status: "ok", task: (await readTask(tx, member.orgId, id))! };
};

export const deleteTask: (
  tx: Ex,
  member: CrmMember,
  id: string,
) => Promise<{ status: "ok"; task: CrmTask } | typeof NOT_FOUND> = async (tx, member, id) => {
  const task = await readTask(tx, member.orgId, id);
  if (!task) return NOT_FOUND;
  await tx.delete(crmTasks).where(eq(crmTasks.id, id));
  return { status: "ok", task };
};
