import { BULK_MAX, type CrmBulkAction } from "@omni/db";
import { z } from "zod";
import { crmOf, refusalText, type CrmWorkspace } from "../crm.ts";
import type { ToolContext } from "../server.ts";
import { stageId } from "./deal.ts";
import { ownerId, type Written } from "./shared.ts";

const RECORDS = {
  person: "people",
  company: "companies",
  deal: "deals",
} as const;

export const bulkSchema = z
  .object({
    kind: z.enum(["person", "company", "deal"]),
    ids: z.array(z.string().min(1)).min(1).max(BULK_MAX),
    archived: z.boolean().optional().describe("true archives them all, false restores them."),
    owner: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe('Give them all to "me" or a teammate\'s email; null for no owner.'),
    stage: z.string().min(1).optional().describe("Deals: move them all to this stage."),
  })
  .describe(
    `One change to up to ${BULK_MAX} records of one kind: give exactly one of \`archived\`, \`owner\` or \`stage\`. Each record changes on its own; refused ones are listed.`,
  );

type BulkInput = z.infer<typeof bulkSchema>;

async function actionOf(context: ToolContext, workspace: CrmWorkspace, input: BulkInput) {
  const given = (["archived", "owner", "stage"] as const).filter((k) => input[k] !== undefined);
  if (given.length !== 1) return { error: "Give exactly one of `archived`, `owner` or `stage`." };
  if (input.archived !== undefined)
    return { action: input.archived ? "archive" : "restore" } satisfies CrmBulkAction;
  if (input.stage !== undefined) {
    if (input.kind !== "deal") return { error: "Only deals have a stage." };
    const stage = await stageId(context, workspace, input.stage);
    return "error" in stage
      ? stage
      : ({ action: "stage", stageId: stage.id } satisfies CrmBulkAction);
  }
  const owner = await ownerId(context, workspace, input.owner);
  if ("error" in owner) return owner;
  return { action: "owner", ownerMemberId: owner.id ?? null } satisfies CrmBulkAction;
}

export async function writeBulk(context: ToolContext, workspace: CrmWorkspace, input: BulkInput) {
  const action = await actionOf(context, workspace, input);
  if ("error" in action) return action;
  const ids = [...new Set(input.ids)];
  const ran = await crmOf(context, workspace).bulk(RECORDS[input.kind], ids, action);
  if (ran.status !== "ok") return { error: refusalText(ran) };
  return {
    output: {
      result: "changed",
      bulk: {
        done: ran.done,
        refused: ran.refused.map(({ id, status }) => ({
          id,
          reason: refusalText({ status }),
        })),
      },
    },
    kind: input.kind,
    ids: ran.done,
  } satisfies Written;
}
