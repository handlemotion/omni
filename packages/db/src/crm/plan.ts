import { and, asc, eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { crmDeliverables, crmMilestones } from "../schema/crm/projects.ts";
import { memberStorage } from "../storage.ts";
import { NOT_FOUND, type CrmMember, type Ex } from "./core.ts";
import { loadDeal } from "./records.ts";

/**
 * A project's plan (`docs/spec/crm.md`, "Plan a project"): milestones in the team's order, and the
 * deliverables under them or under none.
 */
export type MilestoneStatus = "planned" | "in_progress" | "done";
export type DeliverableStatus = "draft" | "in_review" | "approved" | "changes_requested";

export interface CrmMilestone {
  id: string;
  dealId: string;
  title: string;
  description: string | null;
  /** `YYYY-MM-DD`. */
  targetOn: string | null;
  status: MilestoneStatus;
  position: number;
  completedAt: Date | null;
  createdByMemberId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CrmDeliverable {
  id: string;
  dealId: string;
  milestoneId: string | null;
  title: string;
  description: string | null;
  nodeId: string | null;
  dueOn: string | null;
  status: DeliverableStatus;
  clientVisible: boolean;
  reviewNote: string | null;
  reviewedAt: Date | null;
  reviewedByEmail: string | null;
  createdByMemberId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CrmPlan {
  milestones: CrmMilestone[];
  deliverables: CrmDeliverable[];
}

export interface MilestoneInput {
  title: string;
  description?: string | null;
  targetOn?: string | null;
  status?: MilestoneStatus;
}

export interface MilestonePatch extends Partial<MilestoneInput> {
  /** The new place, from 0; the others shift to make room. */
  position?: number;
}

export interface DeliverableInput {
  title: string;
  description?: string | null;
  milestoneId?: string | null;
  nodeId?: string | null;
  dueOn?: string | null;
  status?: DeliverableStatus;
  clientVisible?: boolean;
}

export type DeliverablePatch = Partial<DeliverableInput>;

export type InvalidPlanTitle = { status: "invalid_title" };
export type InvalidMilestone = { status: "invalid_milestone" };
export type InvalidFile = { status: "invalid_file" };
export type PlanFull = { status: "plan_full" };

export type MilestoneResult =
  | { status: "ok"; milestone: CrmMilestone }
  | typeof NOT_FOUND
  | InvalidPlanTitle
  | PlanFull;
export type DeliverableResult =
  | { status: "ok"; deliverable: CrmDeliverable }
  | typeof NOT_FOUND
  | InvalidPlanTitle
  | InvalidMilestone
  | InvalidFile
  | PlanFull;

export const CRM_PLAN_TITLE_MAX = 300;
export const CRM_PLAN_DESCRIPTION_MAX = 20_000;
/** A project holds at most this many of each, so the plan is always read whole. */
export const CRM_PLAN_MAX = 200;

const milestoneColumns = {
  id: crmMilestones.id,
  dealId: crmMilestones.dealId,
  title: crmMilestones.title,
  description: crmMilestones.description,
  targetOn: crmMilestones.targetOn,
  status: crmMilestones.status,
  position: crmMilestones.position,
  completedAt: crmMilestones.completedAt,
  createdByMemberId: crmMilestones.createdByMemberId,
  createdAt: crmMilestones.createdAt,
  updatedAt: crmMilestones.updatedAt,
};

const deliverableColumns = {
  id: crmDeliverables.id,
  dealId: crmDeliverables.dealId,
  milestoneId: crmDeliverables.milestoneId,
  title: crmDeliverables.title,
  description: crmDeliverables.description,
  nodeId: crmDeliverables.nodeId,
  dueOn: crmDeliverables.dueOn,
  status: crmDeliverables.status,
  clientVisible: crmDeliverables.clientVisible,
  reviewNote: crmDeliverables.reviewNote,
  reviewedAt: crmDeliverables.reviewedAt,
  reviewedByEmail: crmDeliverables.reviewedByEmail,
  createdByMemberId: crmDeliverables.createdByMemberId,
  createdAt: crmDeliverables.createdAt,
  updatedAt: crmDeliverables.updatedAt,
};

export const cleanPlanTitle = (title: string) => {
  const text = title.trim().replaceAll(/\s+/g, " ");
  return text.length > 0 && text.length <= CRM_PLAN_TITLE_MAX ? text : null;
};

export const cleanPlanText = (text: string | null | undefined) => {
  if (text === undefined) return undefined;
  const trimmed = text?.trim() ?? "";
  return trimmed.length > 0 ? trimmed.slice(0, CRM_PLAN_DESCRIPTION_MAX) : null;
};

/** The plan of one deal, for whoever the caller already let in. */
export async function planOf(ex: Ex, orgId: string, dealId: string) {
  const [milestones, deliverables] = await Promise.all([
    ex
      .select(milestoneColumns)
      .from(crmMilestones)
      .where(and(eq(crmMilestones.orgId, orgId), eq(crmMilestones.dealId, dealId)))
      .orderBy(asc(crmMilestones.position), asc(crmMilestones.id))
      .limit(CRM_PLAN_MAX),
    ex
      .select(deliverableColumns)
      .from(crmDeliverables)
      .where(and(eq(crmDeliverables.orgId, orgId), eq(crmDeliverables.dealId, dealId)))
      .orderBy(asc(crmDeliverables.createdAt), asc(crmDeliverables.id))
      .limit(CRM_PLAN_MAX),
  ]);
  return { milestones, deliverables } satisfies CrmPlan;
}

export async function getPlan(ex: Ex, member: CrmMember, dealId: string) {
  if (!(await loadDeal(ex, member.orgId, dealId))) return NOT_FOUND;
  return { status: "ok" as const, plan: await planOf(ex, member.orgId, dealId) };
}

const loadMilestone = async (ex: Ex, orgId: string, id: string, lock = true) => {
  const query = ex
    .select(milestoneColumns)
    .from(crmMilestones)
    .where(and(eq(crmMilestones.orgId, orgId), eq(crmMilestones.id, id)));
  const [row] = lock ? await query.for("update") : await query;
  return row ?? null;
};

const planFull = async (
  tx: Ex,
  table: typeof crmMilestones | typeof crmDeliverables,
  dealId: string,
) => {
  const [{ count }] = (await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(table)
    .where(eq(table.dealId, dealId))) as [{ count: number }];
  return count >= CRM_PLAN_MAX;
};

export const loadDeliverable = async (ex: Ex, orgId: string, id: string) => {
  const [row] = await ex
    .select(deliverableColumns)
    .from(crmDeliverables)
    .where(and(eq(crmDeliverables.orgId, orgId), eq(crmDeliverables.id, id)));
  return row ?? null;
};

const doneAt = (status: MilestoneStatus | undefined, current: Date | null) => {
  if (status === undefined) return undefined;
  if (status !== "done") return null;
  return current ?? new Date();
};

export async function createMilestone(
  tx: Ex,
  member: CrmMember,
  dealId: string,
  input: MilestoneInput,
) {
  const title = cleanPlanTitle(input.title);
  if (!title) return { status: "invalid_title" } as const;
  if (!(await loadDeal(tx, member.orgId, dealId, true))) return NOT_FOUND;
  if (await planFull(tx, crmMilestones, dealId)) return { status: "plan_full" } as const;
  const [{ next }] = (await tx
    .select({ next: sql<number>`coalesce(max(${crmMilestones.position}) + 1, 0)::int` })
    .from(crmMilestones)
    .where(eq(crmMilestones.dealId, dealId))) as [{ next: number }];
  const [milestone] = await tx
    .insert(crmMilestones)
    .values({
      orgId: member.orgId,
      dealId,
      title,
      description: cleanPlanText(input.description) ?? null,
      targetOn: input.targetOn ?? null,
      status: input.status ?? "planned",
      completedAt: doneAt(input.status, null) ?? null,
      position: next,
      createdByMemberId: member.id,
    })
    .returning(milestoneColumns);
  return { status: "ok", milestone: milestone! } satisfies MilestoneResult;
}

async function reorder(tx: Ex, dealId: string, id: string, position: number) {
  const rows = await tx
    .select({ id: crmMilestones.id })
    .from(crmMilestones)
    .where(eq(crmMilestones.dealId, dealId))
    .orderBy(asc(crmMilestones.position), asc(crmMilestones.id));
  const ids = rows.map((row) => row.id).filter((other) => other !== id);
  ids.splice(Math.max(0, Math.min(position, ids.length)), 0, id);
  for (const [index, other] of ids.entries()) {
    await tx.update(crmMilestones).set({ position: index }).where(eq(crmMilestones.id, other));
  }
}

export async function updateMilestone(
  tx: Ex,
  member: CrmMember,
  id: string,
  patch: MilestonePatch,
) {
  const title = patch.title === undefined ? undefined : cleanPlanTitle(patch.title);
  if (title === null) return { status: "invalid_title" } as const;
  if (patch.position !== undefined) {
    const peek = await loadMilestone(tx, member.orgId, id, false);
    if (!peek) return NOT_FOUND;
    await loadDeal(tx, member.orgId, peek.dealId, true);
  }
  const current = await loadMilestone(tx, member.orgId, id);
  if (!current) return NOT_FOUND;
  if (patch.position !== undefined) await reorder(tx, current.dealId, id, patch.position);
  const [milestone] = await tx
    .update(crmMilestones)
    .set({
      title,
      description: cleanPlanText(patch.description),
      targetOn: patch.targetOn,
      status: patch.status,
      completedAt: doneAt(patch.status, current.completedAt),
      updatedAt: new Date(),
    })
    .where(eq(crmMilestones.id, id))
    .returning(milestoneColumns);
  return { status: "ok", milestone: milestone! } satisfies MilestoneResult;
}

/** Deletes a milestone; its deliverables stay on the project, under no milestone. */
export async function deleteMilestone(tx: Ex, member: CrmMember, id: string) {
  const current = await loadMilestone(tx, member.orgId, id);
  if (!current) return NOT_FOUND;
  await tx.delete(crmMilestones).where(eq(crmMilestones.id, id));
  return { status: "ok" as const, milestone: current };
}

async function milestoneOnDeal(ex: Ex, orgId: string, dealId: string, id: string) {
  const [row] = await ex
    .select({ id: crmMilestones.id })
    .from(crmMilestones)
    .where(
      and(
        eq(crmMilestones.orgId, orgId),
        eq(crmMilestones.dealId, dealId),
        eq(crmMilestones.id, id),
      ),
    );
  return Boolean(row);
}

async function fileOpenable(ex: Ex, member: CrmMember, nodeId: string) {
  const view = await memberStorage(ex as Db, member.id).node(nodeId);
  return Boolean(
    view && !view.inTrash && view.node.kind === "file" && view.node.orgId === member.orgId,
  );
}

async function checkDeliverable(
  ex: Ex,
  member: CrmMember,
  dealId: string,
  input: DeliverablePatch,
) {
  if (input.milestoneId && !(await milestoneOnDeal(ex, member.orgId, dealId, input.milestoneId))) {
    return { status: "invalid_milestone" } as const;
  }
  if (input.nodeId && !(await fileOpenable(ex, member, input.nodeId))) {
    return { status: "invalid_file" } as const;
  }
  return null;
}

export async function createDeliverable(
  tx: Ex,
  member: CrmMember,
  dealId: string,
  input: DeliverableInput,
) {
  const title = cleanPlanTitle(input.title);
  if (!title) return { status: "invalid_title" } as const;
  if (!(await loadDeal(tx, member.orgId, dealId, true))) return NOT_FOUND;
  const refused = await checkDeliverable(tx, member, dealId, input);
  if (refused) return refused;
  if (await planFull(tx, crmDeliverables, dealId)) return { status: "plan_full" } as const;
  const [deliverable] = await tx
    .insert(crmDeliverables)
    .values({
      orgId: member.orgId,
      dealId,
      milestoneId: input.milestoneId ?? null,
      title,
      description: cleanPlanText(input.description) ?? null,
      nodeId: input.nodeId ?? null,
      dueOn: input.dueOn ?? null,
      status: input.status ?? "draft",
      clientVisible: input.clientVisible ?? false,
      createdByMemberId: member.id,
    })
    .returning(deliverableColumns);
  return { status: "ok", deliverable: deliverable! } satisfies DeliverableResult;
}

export async function updateDeliverable(
  tx: Ex,
  member: CrmMember,
  id: string,
  patch: DeliverablePatch,
) {
  const current = await loadDeliverable(tx, member.orgId, id);
  if (!current) return NOT_FOUND;
  const title = patch.title === undefined ? undefined : cleanPlanTitle(patch.title);
  if (title === null) return { status: "invalid_title" } as const;
  const refused = await checkDeliverable(tx, member, current.dealId, patch);
  if (refused) return refused;
  const [deliverable] = await tx
    .update(crmDeliverables)
    .set({
      title,
      description: cleanPlanText(patch.description),
      milestoneId: patch.milestoneId,
      nodeId: patch.nodeId,
      dueOn: patch.dueOn,
      status: patch.status,
      clientVisible: patch.clientVisible,
      updatedAt: new Date(),
    })
    .where(eq(crmDeliverables.id, id))
    .returning(deliverableColumns);
  return { status: "ok", deliverable: deliverable! } satisfies DeliverableResult;
}

export async function deleteDeliverable(tx: Ex, member: CrmMember, id: string) {
  const current = await loadDeliverable(tx, member.orgId, id);
  if (!current) return NOT_FOUND;
  await tx.delete(crmDeliverables).where(eq(crmDeliverables.id, id));
  return { status: "ok" as const, deliverable: current };
}
