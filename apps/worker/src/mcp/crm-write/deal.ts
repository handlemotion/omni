import type { CrmDeal } from "@omni/db";
import { z } from "zod";
import { crmOf, dealRow, refusalText, rowContext, type CrmWorkspace } from "../crm.ts";
import type { ToolContext } from "../server.ts";
import { archivedSchema, changesFields, ownerId, refusal, type Written } from "./shared.ts";
import { capRefusal } from "../../billing.ts";
import { withinCrmRecords } from "./record-limit.ts";

export const dealSchema = z
  .object({
    id: z.string().min(1).optional().describe("Change this deal. Leave out to add one."),
    name: z.string().max(200).optional(),
    company_id: z.string().min(1).nullable().optional(),
    stage: z
      .string()
      .min(1)
      .optional()
      .describe("Move it to this stage, by name or id. Adding: the first open stage by default."),
    owner: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe('"me", a teammate\'s email, or null for no owner. Adding: you by default.'),
    value_minor: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe("In minor units (cents): 52,000.00 is 5200000."),
    expected_close_on: z.iso
      .date()
      .nullable()
      .optional()
      .describe("When it should close, YYYY-MM-DD; null for none."),
    currency: z
      .string()
      .length(3)
      .nullable()
      .optional()
      .describe("ISO 4217, like USD or MXN. Default: the workspace's currency."),
    person_ids: z.array(z.string().min(1)).max(50).optional().describe("Its people, all of them."),
    archived: archivedSchema,
  })
  .describe("Add or change a deal, or move its stage. Adding needs `name`.");

type DealInput = z.infer<typeof dealSchema>;

/** The id of the stage `wanted` names, by id or by name in any case. */
export const stageId: (
  context: ToolContext,
  workspace: CrmWorkspace,
  wanted: string,
) => Promise<{ id: string } | { error: string }> = async (context, workspace, wanted) => {
  const stages = await crmOf(context, workspace).stages();
  if (stages.status !== "ok") return { error: refusalText(stages) };
  const match = stages.stages.find(
    (s) => s.id === wanted || s.name.toLowerCase() === wanted.trim().toLowerCase(),
  );
  if (match) return { id: match.id };
  if (!stages.stages.length) return { error: "Add the deal first; it starts in the first stage." };
  return {
    error: `No stage "${wanted}". Stages: ${stages.stages.map((s) => s.name).join(", ")}.`,
  };
};

async function fieldsOf(context: ToolContext, workspace: CrmWorkspace, input: DealInput) {
  const stage =
    input.stage === undefined ? undefined : await stageId(context, workspace, input.stage);
  if (stage && "error" in stage) return stage;
  const owner = await ownerId(context, workspace, input.owner);
  if ("error" in owner) return owner;
  return {
    fields: {
      companyId: input.company_id,
      stageId: stage?.id,
      ownerMemberId: owner.id,
      expectedCloseOn: input.expected_close_on,
      valueMinor: input.value_minor,
      currency: input.currency?.toUpperCase() ?? input.currency,
      personIds: input.person_ids,
    },
  };
}

const changeDeal: (
  context: ToolContext,
  workspace: CrmWorkspace,
  id: string,
  input: DealInput,
) => Promise<{ deal: CrmDeal } | { error: string }> = async (context, workspace, id, input) => {
  const crm = crmOf(context, workspace);
  let deal: CrmDeal | undefined;
  if (changesFields(input)) {
    const made = await fieldsOf(context, workspace, input);
    if ("error" in made) return made;
    const changed = await crm.updateDeal(id, {
      name: input.name,
      ...made.fields,
    });
    if (changed.status !== "ok") return refusal(changed);
    deal = changed.deal;
  }
  if (input.archived !== undefined) {
    const moved = input.archived ? await crm.archiveDeal(id) : await crm.restoreDeal(id);
    if (moved.status !== "ok") return refusal(moved);
    deal = moved.deal;
  }
  return deal ? { deal } : { error: "Give at least one field to change." };
};

const addDeal: (
  context: ToolContext,
  workspace: CrmWorkspace,
  input: DealInput,
) => Promise<{ deal: CrmDeal } | { error: string }> = async (context, workspace, input) => {
  if (input.name === undefined) return { error: "Adding a deal needs `name`." };
  if (input.archived !== undefined) return { error: "`archived` changes a deal: give its `id`." };
  const full = await capRefusal(context.db, context.config, workspace.orgId, "crmRecords");
  if (full) return { error: `${full.message[0]!.toUpperCase()}${full.message.slice(1)}.` };
  const made = await fieldsOf(context, workspace, input);
  if ("error" in made) return made;
  const added = await withinCrmRecords(context, workspace, (max) =>
    crmOf(context, workspace).createDeal({ name: input.name!, ...made.fields }, max),
  );
  if ("error" in added) return added;
  return added.status === "ok" ? { deal: added.deal } : refusal(added);
};

export async function writeDeal(context: ToolContext, workspace: CrmWorkspace, input: DealInput) {
  const done =
    input.id === undefined
      ? await addDeal(context, workspace, input)
      : await changeDeal(context, workspace, input.id, input);
  if ("error" in done) return done;
  const rows = await rowContext(context, workspace, [done.deal]);
  return {
    output: {
      result: input.id ? "changed" : "added",
      deal: dealRow(done.deal, rows),
    },
    kind: "deal",
    ids: [done.deal.id],
  } satisfies Written;
}
