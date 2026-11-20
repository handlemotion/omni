import { and, eq, inArray, or } from "drizzle-orm";
import { crmDeals, crmNotes, crmStages } from "../schema/crm.ts";
import { crmDeliverables, crmMilestones } from "../schema/crm/projects.ts";
import { crmTasks } from "../schema/crm/tasks.ts";
import type { CrmRecordRef, Ex, Freelancer, Gate } from "./core.ts";
import { dealColumns } from "./records.ts";
import { searchCrm, lookupCrm } from "./search.ts";
import { listTasks, type ListTasksInput, type TaskPatch } from "./tasks.ts";

/**
 * What a freelancer reaches (`docs/spec/crm.md`, "Project access"): the deals they were added to,
 * with each one's plan, notes, tasks, files and contracts. Every gate answers from the database,
 * not from what the caller says about the record.
 */
export const onProject = (dealId: string | null | undefined) =>
  ((member) => Boolean(dealId) && member.projects.includes(dealId!)) satisfies Gate;

export const onProjectRecord = (record: CrmRecordRef | null | undefined) =>
  (record && "dealId" in record ? onProject(record.dealId) : () => false) satisfies Gate;

const dealOfRow = (
  table: typeof crmMilestones | typeof crmDeliverables | typeof crmNotes,
  id: string,
) =>
  (async (member: Freelancer, ex: Ex) => {
    const [row] = await ex
      .select({ dealId: table.dealId })
      .from(table)
      .where(and(eq(table.orgId, member.orgId), eq(table.id, id)));
    return Boolean(row?.dealId && member.projects.includes(row.dealId));
  }) satisfies Gate;

export const milestoneOnProject = (id: string) => dealOfRow(crmMilestones, id);
export const deliverableOnProject = (id: string) => dealOfRow(crmDeliverables, id);
export const noteOnProject = (id: string) => dealOfRow(crmNotes, id);

/** A task on one of their projects, or one assigned to them. */
export const taskOnProject = (id: string) =>
  (async (member: Freelancer, ex: Ex) => {
    const [row] = await ex
      .select({ id: crmTasks.id })
      .from(crmTasks)
      .where(
        and(
          eq(crmTasks.orgId, member.orgId),
          eq(crmTasks.id, id),
          or(
            eq(crmTasks.assigneeMemberId, member.id),
            member.projects.length ? inArray(crmTasks.dealId, member.projects) : undefined,
          ),
        ),
      );
    return Boolean(row);
  }) satisfies Gate;

/** Changing a task: theirs to see, and moved, if at all, only onto one of their projects. */
export const taskChangeOnProject = (id: string, patch: TaskPatch) =>
  (async (member: Freelancer, ex: Ex) =>
    (await taskOnProject(id)(member, ex)) &&
    (patch.record === undefined || onProjectRecord(patch.record)(member))) satisfies Gate;

/** Their projects, by name, as one page. */
export async function projectDeals(ex: Ex, member: Freelancer) {
  if (member.projects.length === 0) return { status: "ok" as const, deals: [], nextCursor: null };
  const deals = await ex
    .select(dealColumns)
    .from(crmDeals)
    .innerJoin(crmStages, eq(crmStages.id, crmDeals.stageId))
    .where(and(eq(crmDeals.orgId, member.orgId), inArray(crmDeals.id, member.projects)))
    .orderBy(crmDeals.name, crmDeals.id);
  return { status: "ok" as const, deals, nextCursor: null };
}

/** A freelancer's tasks: one project's, or else those assigned to them. */
export function freelancerTasks(ex: Ex, member: Freelancer, input: ListTasksInput) {
  if (input.record) {
    const onIt = "dealId" in input.record && member.projects.includes(input.record.dealId);
    return onIt
      ? listTasks(ex, member, input)
      : Promise.resolve({ status: "ok" as const, tasks: [], nextCursor: null });
  }
  return listTasks(ex, member, { ...input, assigneeMemberId: member.id });
}

const onlyProjects = <R extends { deals: { id: string }[] }>(member: Freelancer, found: R) => ({
  ...found,
  people: [],
  companies: [],
  deals: found.deals.filter((deal) => member.projects.includes(deal.id)),
});

/** Search, for a freelancer: their projects whose name matches, and no people or companies. */
export async function freelancerSearch(ex: Ex, member: Freelancer, input: { q: string }) {
  const found = await searchCrm(ex, member, { ...input, limit: 50 });
  return found.status === "ok" ? onlyProjects(member, found) : found;
}

/** A thread's addresses, for a freelancer: their projects with those people, nothing else. */
export async function freelancerLookup(ex: Ex, member: Freelancer, input: { addresses: string[] }) {
  const found = await lookupCrm(ex, member, input);
  return found.status === "ok" ? onlyProjects(member, found) : found;
}
