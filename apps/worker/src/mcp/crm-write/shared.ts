import type { CrmChangedKind } from "@omni/contracts";
import { z } from "zod";
import {
  companyRowSchema,
  dealRowSchema,
  personRowSchema,
  refusalText,
  teammate,
  type CrmWorkspace,
} from "../crm.ts";
import { taskRowSchema } from "../crm-tasks.ts";
import type { ToolContext } from "../server.ts";

const recordRefSchema = z.object({
  kind: z.enum(["person", "company", "deal"]),
  id: z.string(),
});

export const outputSchema = z.object({
  result: z
    .enum(["added", "changed", "already_there"])
    .describe("already_there: a person with that address existed and is returned unchanged."),
  person: personRowSchema.optional(),
  company: companyRowSchema.optional(),
  deal: dealRowSchema.optional(),
  task: taskRowSchema.optional(),
  note: z.object({ id: z.string(), record: recordRefSchema, at: z.string() }).optional(),
  bulk: z
    .object({
      done: z.array(z.string()).describe("The ids that changed."),
      refused: z.array(z.object({ id: z.string(), reason: z.string() })),
    })
    .optional(),
});

export type Output = z.infer<typeof outputSchema>;

/** What a write made: the answer, and what to announce and audit. */
export type Written = { output: Output; kind: CrmChangedKind; ids: string[] } | { error: string };

export const refusal = (r: { status: string }) => ({ error: refusalText(r) });

export const ownerSchema = z
  .string()
  .min(1)
  .nullable()
  .optional()
  .describe('"me", a teammate\'s email, or null for no owner.');

export const archivedSchema = z
  .boolean()
  .optional()
  .describe("Changing only: true archives it, false restores it. Archiving never deletes.");

/** The member id an `owner` names: undefined leaves it, null clears it. */
export const ownerId: (
  context: ToolContext,
  workspace: CrmWorkspace,
  owner: string | null | undefined,
) => Promise<{ id: string | null | undefined } | { error: string }> = async (
  context,
  workspace,
  owner,
) => {
  if (owner === undefined || owner === null) return { id: owner };
  const id = await teammate(context, workspace, owner);
  return id === null ? { error: `${owner} is not in this workspace.` } : { id };
};

/** True when `input` names a field beyond `id` and `archived`. */
export function changesFields(input: Record<string, unknown>) {
  return Object.entries(input).some(
    ([key, value]) => key !== "id" && key !== "archived" && value !== undefined,
  );
}
