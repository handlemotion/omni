import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { members } from "../schema/auth.ts";
import { crmEvents, crmNotes } from "../schema/crm.ts";
import { crmDeliverables, crmMilestones } from "../schema/crm/projects.ts";
import { calendarTask } from "../calendar.ts";
import { FREELANCER_ROLE, type CrmRecordRef, type Ex, type Freelancer, type Gate } from "./core.ts";
import { getDeal, listDeals, type ListDealsInput } from "./deals.ts";
import type { TimelineNarrowing } from "./notes.ts";
import type { CrmDeal } from "./records.ts";
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

/** A task on one of their projects, or one they own or are assigned. */
export const taskOnProject = (id: string) =>
  (async (member: Freelancer, ex: Ex) => {
    const task = await calendarTask(ex, member.orgId, id);
    if (!task?.record) return false;
    if (task.assigneeMemberId === member.id || task.ownerMemberId === member.id) return true;
    return task.record.kind === "deal" && member.projects.includes(task.record.id);
  }) satisfies Gate;

/** Changing a task: theirs to see, and moved, if at all, only onto one of their projects. */
export const taskChangeOnProject = (id: string, patch: TaskPatch) =>
  (async (member: Freelancer, ex: Ex) =>
    (await taskOnProject(id)(member, ex)) &&
    (patch.record === undefined || onProjectRecord(patch.record)(member))) satisfies Gate;

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

/**
 * What we charge stays with the team (`docs/spec/crm.md`, "What a freelancer does not see"): a
 * freelancer's deal carries no value or currency.
 */
export const withoutValue = (deal: CrmDeal) =>
  ({ ...deal, valueMinor: null, valueCurrency: null }) satisfies CrmDeal;

/**
 * A freelancer's deals, without their values. Filtering or sorting by value would tell the value
 * as surely as showing it, so both are dropped and the list comes back by name.
 */
export async function freelancerDeals(ex: Ex, member: Freelancer, input: ListDealsInput) {
  const { minValue: _min, maxValue: _max, ...rest } = input;
  const byValue = input.sort?.key === "value";
  const listed = await listDeals(ex, member, {
    ...rest,
    sort: byValue ? undefined : input.sort,
  });
  return { ...listed, deals: listed.deals.map(withoutValue) };
}

/** One of their projects, without its value. */
export async function freelancerDeal(ex: Ex, member: Freelancer, id: string) {
  const found = await getDeal(ex, member, id);
  return found.status === "ok" ? { ...found, deal: withoutValue(found.deal) } : found;
}

/** Events about money and contracts: what was charged and what was signed for it. */
export const TEAM_EVENTS = [
  "value_changed",
  "contract_created",
  "contract_status_changed",
  "contract_document_changed",
  "contract_deleted",
] as const;

/** A freelancer's timeline events: none about money or contracts. */
export const freelancerEvents: TimelineNarrowing = () =>
  notInArray(crmEvents.kind, [...TEAM_EVENTS]);

/**
 * A freelancer's notes: those written by freelancers. A teammate's note is the team's own record
 * (what the client said about budget, what we think of them) and stays with the team.
 */
export const freelancerNotes: TimelineNarrowing = (orgId) =>
  inArray(
    crmNotes.authorMemberId,
    sql`(select ${members.id} from ${members} where ${members.organizationId} = ${orgId}
      and ${FREELANCER_ROLE} = any(string_to_array(replace(${members.role}, ' ', ''), ',')))`,
  );

const onlyProjects = <R extends { deals: CrmDeal[] }>(found: R) => ({
  ...found,
  deals: found.deals.map(withoutValue),
  people: [],
  companies: [],
});

/** Search, for a freelancer: their projects whose name matches, and no people or companies. */
export async function freelancerSearch(ex: Ex, member: Freelancer, input: { q: string }) {
  const found = await searchCrm(ex, member, input);
  return found.status === "ok" ? onlyProjects(found) : found;
}

/** A thread's addresses, for a freelancer: their projects with those people, nothing else. */
export async function freelancerLookup(ex: Ex, member: Freelancer, input: { addresses: string[] }) {
  const found = await lookupCrm(ex, member, input);
  return found.status === "ok" ? onlyProjects(found) : found;
}
