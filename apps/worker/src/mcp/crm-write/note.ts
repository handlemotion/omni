import { z } from "zod";
import { announce, crmOf, type CrmWorkspace } from "../crm.ts";
import type { ToolContext } from "../server.ts";
import { refusal, type Written } from "./shared.ts";

export const noteSchema = z
  .object({
    record: z.object({
      kind: z.enum(["person", "company", "deal"]),
      id: z.string().min(1),
    }),
    text: z.string().min(1).max(20_000),
  })
  .describe("Add a note on a record.");

export async function writeNote(
  context: ToolContext,
  workspace: CrmWorkspace,
  input: z.infer<typeof noteSchema>,
) {
  const { kind, id } = input.record;
  const record =
    kind === "person" ? { personId: id } : kind === "company" ? { companyId: id } : { dealId: id };
  const made = await crmOf(context, workspace).createNote({
    record,
    body: input.text,
  });
  if (made.status !== "ok") return refusal(made);
  await announce(context, workspace, kind, [id]);
  return {
    output: {
      result: "added",
      note: {
        id: made.note.id,
        record: { kind, id },
        at: made.note.createdAt.toISOString(),
      },
    },
    kind: "note",
    ids: [made.note.id],
  } satisfies Written;
}
