import { and, eq, inArray, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import {
  calendarTask,
  countLinkedTasks,
  linkedTasks,
  putTask,
  removeTask,
  type CalendarTask,
  type LinkedTaskFilter,
  type TaskRecord,
  type TaskRow,
} from "../calendar.ts";
import { crmCompanies, crmCompanyDomains, crmDeals, crmPeople } from "../schema/crm.ts";
import { loadCrmMember, NOT_FOUND, type CrmMember, type CrmRecordRef, type Ex } from "./core.ts";
import { recordExists } from "./notes.ts";
import { dropCrmTask, writeCrmTask } from "./task-mirror.ts";

/** A step of a task's checklist. */
export interface CrmSubtask {
  id: string;
  title: string;
  done: boolean;
}

/**
 * A task as the CRM shows it: one on a company, person or deal (`docs/spec/calendar.md`,
 * "Tasks"). The CRM lists and reads no private one; it answers its owner with one it made or
 * took off its record, record fields null.
 */
export interface CrmTask {
  id: string;
  title: string;
  body: string | null;
  subtasks: CrmSubtask[];
  companyId: string | null;
  personId: string | null;
  dealId: string | null;
  /** The company's, person's or deal's name; null on a private task. */
  recordName: string | null;
  /** A company's first domain, for its icon; null on any other task. */
  recordDomain: string | null;
  ownerMemberId: string | null;
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
  /** Absent: the creator. Null: unassigned. Someone else only on a task on a record. */
  assigneeMemberId?: string | null;
  dueAt?: Date | null;
  /** Absent or null: a private task, the creator's. */
  record?: CrmRecordRef | null;
}

export interface TaskPatch {
  title?: string;
  body?: string | null;
  /** The whole checklist, replacing the one it has. */
  subtasks?: CrmSubtask[];
  assigneeMemberId?: string | null;
  dueAt?: Date | null;
  done?: boolean;
  /** Moves the task to this record; null takes it off its record, back to being private. */
  record?: CrmRecordRef | null;
}

export type InvalidTitle = { status: "invalid_title" };
/** The assignee is not in the workspace, or cannot open the task's record. */
export type InvalidAssignee = { status: "invalid_assignee" };
/** A task on no record is its owner's alone: it cannot be assigned to anyone else. */
export type PrivateTask = { status: "private_task" };
export type TaskResult =
  | { status: "ok"; task: CrmTask }
  | typeof NOT_FOUND
  | InvalidTitle
  | InvalidAssignee
  | PrivateTask;

export const CRM_TASK_TITLE_MAX = 500;
export const CRM_TASK_BODY_MAX = 20_000;
export const CRM_SUBTASKS_MAX = 100;

const KINDS = { companyId: "company", personId: "person", dealId: "deal" } as const;

/** A CRM record as the calendar keeps it on a task. */
export const taskRecordOf = (record: CrmRecordRef) => {
  const [key, id] = Object.entries(record)[0] as [keyof typeof KINDS, string];
  const task: TaskRecord = { kind: KINDS[key], id };
  return task;
};

const cleanTitle = (title: string) => {
  const text = title.trim().replaceAll(/\s+/g, " ");
  return text.length > 0 && text.length <= CRM_TASK_TITLE_MAX ? text : null;
};

const cleanBody = (body: string | null | undefined) => {
  const text = body?.trim() ?? "";
  return text.length > 0 ? text.slice(0, CRM_TASK_BODY_MAX) : null;
};

const cleanSubtasks = (subtasks: CrmSubtask[]) =>
  subtasks.slice(0, CRM_SUBTASKS_MAX).flatMap((step) => {
    const title = step.title.trim().replaceAll(/\s+/g, " ").slice(0, CRM_TASK_TITLE_MAX);
    return title ? [{ id: step.id, title, done: step.done }] : [];
  });

async function namesOf(ex: Ex, orgId: string, tasks: CalendarTask[]) {
  const ids = (kind: TaskRecord["kind"]) =>
    tasks.flatMap((t) => (t.record?.kind === kind ? [t.record.id] : []));
  const [companies, people, deals] = [ids("company"), ids("person"), ids("deal")];
  const names = new Map<string, { name: string; domain: string | null }>();
  if (companies.length) {
    const rows = await ex
      .select({
        id: crmCompanies.id,
        name: crmCompanies.name,
        domain: sql<string | null>`(select ${crmCompanyDomains.domain} from ${crmCompanyDomains}
          where ${crmCompanyDomains.orgId} = ${crmCompanies.orgId}
            and ${crmCompanyDomains.companyId} = ${crmCompanies.id}
          order by ${crmCompanyDomains.domain} limit 1)`,
      })
      .from(crmCompanies)
      .where(and(eq(crmCompanies.orgId, orgId), inArray(crmCompanies.id, companies)));
    for (const row of rows) names.set(`company:${row.id}`, row);
  }
  for (const [kind, table, list] of [
    ["person", crmPeople, people],
    ["deal", crmDeals, deals],
  ] as const) {
    if (!list.length) continue;
    const rows = await ex
      .select({ id: table.id, name: table.name })
      .from(table)
      .where(and(eq(table.orgId, orgId), inArray(table.id, list)));
    for (const row of rows) names.set(`${kind}:${row.id}`, { name: row.name, domain: null });
  }
  return names;
}

function viewOf(task: CalendarTask, names: Map<string, { name: string; domain: string | null }>) {
  const record = task.record;
  const named = record && names.get(`${record.kind}:${record.id}`);
  const view: CrmTask = {
    id: task.id,
    title: task.title,
    body: task.body,
    subtasks: task.subtasks,
    companyId: record?.kind === "company" ? record.id : null,
    personId: record?.kind === "person" ? record.id : null,
    dealId: record?.kind === "deal" ? record.id : null,
    recordName: named?.name ?? null,
    recordDomain: named?.domain ?? null,
    ownerMemberId: task.ownerMemberId,
    assigneeMemberId: task.assigneeMemberId,
    dueAt: task.dueAt,
    completedAt: task.completedAt,
    completedByMemberId: task.completedByMemberId,
    createdByMemberId: task.createdByMemberId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
  return view;
}

async function viewsOf(ex: Ex, orgId: string, tasks: CalendarTask[]) {
  const names = await namesOf(ex, orgId, tasks);
  return tasks.map((task) => viewOf(task, names));
}

/** Whether this member of the workspace can open the record: a teammate any, a freelancer their projects. */
export async function canOpenRecord(ex: Ex, orgId: string, memberId: string, record: TaskRecord) {
  const member = await loadCrmMember(ex, memberId);
  if (!member || member.orgId !== orgId) return false;
  if (member.projects === null) return true;
  return record.kind === "deal" && member.projects.includes(record.id);
}

async function reaches(ex: Ex, member: CrmMember, task: CalendarTask) {
  if (!task.record) return false;
  if (task.ownerMemberId === member.id || task.assigneeMemberId === member.id) return true;
  return canOpenRecord(ex, member.orgId, member.id, task.record);
}

async function readView(ex: Ex, member: CrmMember, id: string) {
  const task = await calendarTask(ex, member.orgId, id);
  if (!task || !(await reaches(ex, member, task))) return null;
  return (await viewsOf(ex, member.orgId, [task]))[0]!;
}

export const getTask: (ex: Ex, member: CrmMember, id: string) => Promise<TaskResult> = async (
  ex,
  member,
  id,
) => {
  const task = await readView(ex, member, id);
  return task ? { status: "ok", task } : NOT_FOUND;
};

/**
 * The workspace's tasks on records: open ones soonest due first and undated last, done ones most
 * recently completed first. `narrow` is a freelancer's view.
 */
export async function listTasks(
  ex: Ex,
  member: CrmMember,
  input: ListTasksInput,
  narrow: Pick<LinkedTaskFilter, "dealIds" | "orAssignedTo"> = {},
) {
  const listed = await linkedTasks(
    ex,
    member.orgId,
    {
      assigneeMemberId: input.assigneeMemberId,
      record: input.record ? taskRecordOf(input.record) : undefined,
      q: input.q,
      ...narrow,
    },
    { status: input.status, due: input.due, cursor: input.cursor, limit: input.limit },
  );
  return {
    status: "ok" as const,
    tasks: await viewsOf(ex, member.orgId, listed.tasks),
    nextCursor: listed.nextCursor,
  };
}

/** Open tasks on records: the member's, the member's overdue, everyone's and everyone's overdue. */
export async function countTasks(ex: Ex, member: CrmMember) {
  return { status: "ok" as const, counts: await countLinkedTasks(ex, member.orgId, member.id) };
}

async function refusedAssignee(
  ex: Ex,
  member: CrmMember,
  assignee: string | null,
  owner: string | null,
  record: TaskRecord | null,
) {
  if (!record) return assignee === owner ? null : ({ status: "private_task" } as const);
  if (assignee === null) return null;
  return (await canOpenRecord(ex, member.orgId, assignee, record))
    ? null
    : ({ status: "invalid_assignee" } as const);
}

async function save(tx: Ex, member: CrmMember, row: TaskRow) {
  await putTask(tx, row);
  const task = (await calendarTask(tx, member.orgId, row.id))!;
  if (task.record) await writeCrmTask(tx, task);
  else await dropCrmTask(tx, member.orgId, task.id);
  return task;
}

/**
 * On a record, the workspace's: assigned to its creator unless the input says otherwise, and only
 * to a member who can open the record. On none, the creator's own.
 */
export const createTask: (
  tx: Ex,
  member: CrmMember,
  input: TaskInput,
) => Promise<TaskResult> = async (tx, member, input) => {
  const title = cleanTitle(input.title);
  if (!title) return { status: "invalid_title" };
  if (input.record && !(await recordExists(tx, member.orgId, input.record))) return NOT_FOUND;
  const record = input.record ? taskRecordOf(input.record) : null;
  const assignee = input.assigneeMemberId === undefined ? member.id : input.assigneeMemberId;
  const refused = await refusedAssignee(tx, member, assignee, member.id, record);
  if (refused) return refused;
  const now = new Date();
  const task = await save(tx, member, {
    id: uuidv7(),
    orgId: member.orgId,
    ownerMemberId: member.id,
    title,
    body: cleanBody(input.body),
    subtasks: [],
    dueAt: input.dueAt ?? null,
    completedAt: null,
    completedByMemberId: null,
    assigneeMemberId: assignee,
    record,
    createdByMemberId: member.id,
    createdAt: now,
    updatedAt: now,
  });
  return { status: "ok", task: (await viewsOf(tx, member.orgId, [task]))[0]! };
};

function nextRow(member: CrmMember, current: CalendarTask, patch: TaskPatch, title?: string) {
  const record =
    patch.record === undefined ? current.record : patch.record && taskRecordOf(patch.record);
  const unlinked = current.record && !record;
  const owner = unlinked
    ? (current.assigneeMemberId ?? current.ownerMemberId ?? member.id)
    : current.ownerMemberId;
  const done = patch.done === undefined ? Boolean(current.completedAt) : patch.done;
  const completedAt = done ? (current.completedAt ?? new Date()) : null;
  const row: TaskRow = {
    ...current,
    ownerMemberId: owner,
    title: title ?? current.title,
    body: patch.body === undefined ? current.body : cleanBody(patch.body),
    subtasks: patch.subtasks === undefined ? current.subtasks : cleanSubtasks(patch.subtasks),
    dueAt: patch.dueAt === undefined ? current.dueAt : patch.dueAt,
    completedAt,
    completedByMemberId: done ? (current.completedByMemberId ?? member.id) : null,
    assigneeMemberId:
      patch.assigneeMemberId === undefined
        ? record
          ? current.assigneeMemberId
          : owner
        : patch.assigneeMemberId,
    record,
    updatedAt: new Date(),
  };
  return row;
}

/**
 * Changes a task on a record, by anyone who can open it or its owner or assignee; its owner may
 * also put a private one on a record ("Add to CRM"). Taken off its record, a task is private to
 * its assignee, else its owner. Completing a done task, or reopening an open one, changes nothing.
 */
export const updateTask: (
  tx: Ex,
  member: CrmMember,
  id: string,
  patch: TaskPatch,
) => Promise<TaskResult> = async (tx, member, id, patch) => {
  const title = patch.title === undefined ? undefined : cleanTitle(patch.title);
  if (title === null) return { status: "invalid_title" };
  const current = await calendarTask(tx, member.orgId, id);
  const owns = current?.ownerMemberId === member.id;
  if (!current || !(owns || (await reaches(tx, member, current)))) return NOT_FOUND;
  if (patch.record && !(await recordExists(tx, member.orgId, patch.record))) return NOT_FOUND;
  const row = nextRow(member, current, patch, title);
  const assigning = patch.assigneeMemberId !== undefined || patch.record !== undefined;
  const refused =
    assigning &&
    (await refusedAssignee(tx, member, row.assigneeMemberId, row.ownerMemberId, row.record));
  if (refused) return refused;
  const task = await save(tx, member, row);
  return { status: "ok", task: (await viewsOf(tx, member.orgId, [task]))[0]! };
};

export const deleteTask: (
  tx: Ex,
  member: CrmMember,
  id: string,
) => Promise<{ status: "ok"; task: CrmTask } | typeof NOT_FOUND> = async (tx, member, id) => {
  const task = await readView(tx, member, id);
  if (!task) return NOT_FOUND;
  await removeTask(tx, member.orgId, id);
  await dropCrmTask(tx, member.orgId, id);
  return { status: "ok", task };
};
