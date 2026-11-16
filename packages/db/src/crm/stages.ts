// The workspace's one pipeline and its settings row, both made on first use. The settings row is
// the seed's lock: whoever inserts it seeds the stages in the same transaction, and a racing
// first use waits on that insert and then finds the stages committed.
import { and, asc, eq, inArray } from "drizzle-orm";
import { crmDeals, crmSettings, crmStages } from "../schema/crm.ts";
import {
  FORBIDDEN,
  isForeignKeyViolation,
  NOT_FOUND,
  type CrmMember,
  type Ex,
  type Forbidden,
  type NotFound,
} from "./core.ts";
import type { StageKind } from "./stage-transition.ts";

export interface CrmStage {
  id: string;
  name: string;
  kind: StageKind;
  position: number;
}

/** What a new workspace starts with. Each can be renamed; the kinds are what code reads. */
export const STARTING_STAGES: readonly { name: string; kind: StageKind }[] = [
  { name: "Lead", kind: "open" },
  { name: "In progress", kind: "open" },
  { name: "Won", kind: "won" },
  { name: "Delivered", kind: "done" },
  { name: "Lost", kind: "lost" },
];

export const STAGE_KINDS: readonly StageKind[] = ["open", "won", "done", "lost"];

/** Makes the settings row and the starting stages the first time a workspace uses its CRM. */
export async function ensureCrm(ex: Ex, orgId: string) {
  const [existing] = await ex
    .select({ orgId: crmSettings.orgId })
    .from(crmSettings)
    .where(eq(crmSettings.orgId, orgId));
  if (existing) return;
  await ex.transaction(async (tx) => {
    const made = await tx
      .insert(crmSettings)
      .values({ orgId })
      .onConflictDoNothing()
      .returning({ orgId: crmSettings.orgId });
    if (made.length === 0) return;
    await tx
      .insert(crmStages)
      .values(STARTING_STAGES.map((stage, position) => ({ orgId, ...stage, position })));
  });
}

/** The stages in order. */
export async function stagesOf(ex: Ex, orgId: string): Promise<CrmStage[]> {
  await ensureCrm(ex, orgId);
  return ex
    .select({
      id: crmStages.id,
      name: crmStages.name,
      kind: crmStages.kind,
      position: crmStages.position,
    })
    .from(crmStages)
    .where(eq(crmStages.orgId, orgId))
    .orderBy(asc(crmStages.position), asc(crmStages.id));
}

/** One stage of the workspace, or null. */
export async function stageOf(ex: Ex, orgId: string, stageId: string) {
  await ensureCrm(ex, orgId);
  const [stage] = await ex
    .select({ id: crmStages.id, kind: crmStages.kind })
    .from(crmStages)
    .where(and(eq(crmStages.orgId, orgId), eq(crmStages.id, stageId)));
  return stage ?? null;
}

/** The first `open` stage: where a deal starts when none is named. */
export async function firstOpenStage(ex: Ex, orgId: string) {
  const stages = await stagesOf(ex, orgId);
  const stage = stages.find((s) => s.kind === "open") ?? stages[0]!;
  return { id: stage.id, kind: stage.kind };
}

/**
 * One entry of the new list, in order. An existing stage keeps its kind (what its deals mean
 * does not change under them) and may be renamed; a new one names its kind.
 */
export type StageInput = { id: string; name: string } | { name: string; kind: StageKind };

export type ReplaceStagesResult =
  | { status: "ok"; stages: CrmStage[] }
  | NotFound
  | Forbidden
  | { status: "invalid_name" }
  /** A stage left out of the list still holds deals (archived ones too). */
  | { status: "stage_in_use"; stageIds: string[] }
  /** The list leaves a kind with no stage. */
  | { status: "stage_kind_required"; kinds: StageKind[] };

/** Replaces the pipeline: rename, add, reorder and remove. Owners and admins only. */
export async function replaceStages(
  tx: Ex,
  member: CrmMember,
  input: StageInput[],
): Promise<ReplaceStagesResult> {
  if (!member.admin) return FORBIDDEN;
  await ensureCrm(tx, member.orgId);
  // Serializes replaces of one workspace's pipeline.
  await tx
    .select({ orgId: crmSettings.orgId })
    .from(crmSettings)
    .where(eq(crmSettings.orgId, member.orgId))
    .for("update");
  const current = await stagesOf(tx, member.orgId);
  const byId = new Map(current.map((stage) => [stage.id, stage]));
  const names = input.map((stage) => stage.name.trim());
  if (names.some((name) => name.length === 0 || name.length > 100))
    return { status: "invalid_name" };
  const kinds = input.map((stage) => ("id" in stage ? byId.get(stage.id)?.kind : stage.kind));
  if (kinds.some((kind) => kind === undefined)) return NOT_FOUND;
  const missing = STAGE_KINDS.filter((kind) => !kinds.includes(kind));
  if (missing.length > 0) return { status: "stage_kind_required", kinds: missing };

  const keptIds = input.flatMap((stage) => ("id" in stage ? [stage.id] : []));
  const kept = new Set(keptIds);
  if (kept.size !== keptIds.length) return NOT_FOUND;
  const removed = current.filter((stage) => !kept.has(stage.id)).map((stage) => stage.id);
  if (removed.length > 0) {
    const inUse = await tx
      .selectDistinct({ stageId: crmDeals.stageId })
      .from(crmDeals)
      .where(and(eq(crmDeals.orgId, member.orgId), inArray(crmDeals.stageId, removed)));
    if (inUse.length > 0) return { status: "stage_in_use", stageIds: inUse.map((r) => r.stageId) };
    try {
      // In a savepoint, so the refusal leaves the transaction usable.
      await tx.transaction((sp) => sp.delete(crmStages).where(inArray(crmStages.id, removed)));
    } catch (error) {
      // A deal moved into a removed stage after the check above.
      if (isForeignKeyViolation(error)) return { status: "stage_in_use", stageIds: removed };
      throw error;
    }
  }
  for (const [position, stage] of input.entries()) {
    const name = names[position]!;
    if ("id" in stage) {
      await tx
        .update(crmStages)
        .set({ name, position })
        .where(and(eq(crmStages.id, stage.id), eq(crmStages.orgId, member.orgId)));
    } else {
      await tx.insert(crmStages).values({ orgId: member.orgId, name, kind: stage.kind, position });
    }
  }
  return { status: "ok", stages: await stagesOf(tx, member.orgId) };
}
