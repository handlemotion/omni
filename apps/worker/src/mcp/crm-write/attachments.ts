import { z } from "zod";
import { crmOf, type CrmWorkspace } from "../crm.ts";
import { contractRow, fileRow } from "../crm-attachments.ts";
import type { ToolContext } from "../server.ts";
import { refusal, type Written } from "./shared.ts";

const companyOrDeal = z.object({ kind: z.enum(["company", "deal"]), id: z.string().min(1) });
const nodeIds = z.array(z.string().min(1)).max(50);

export const filesSchema = z
  .object({
    record: companyOrDeal,
    link: nodeIds.optional().describe("Drive file or folder ids to link where they are."),
    unlink: nodeIds.optional().describe("Ids to unlink; the files stay in Drive."),
  })
  .describe(
    "Link Drive files to a company or deal, or unlink them. Nothing moves or copies. Ids come from `drive_search` or `drive_list`.",
  );

export const contractSchema = z
  .object({
    id: z.string().min(1).optional().describe("Change this contract. Leave out to add a draft."),
    title: z.string().min(1).max(200).optional(),
    company_id: z.string().min(1).optional().describe("Adding: the company it is with."),
    deal_id: z.string().min(1).optional().describe("Adding: the deal it is for."),
    document_node_id: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe("Its document: a file in the Shared drive."),
    effective_on: z.iso.date().nullable().optional(),
    expires_on: z.iso.date().nullable().optional(),
  })
  .describe(
    "Add a draft contract on a company or deal, or change a contract's title, document or dates. Sending it for signature, voiding and marking it signed stay with a person in Omni.",
  );

type FilesInput = z.infer<typeof filesSchema>;
type ContractInput = z.infer<typeof contractSchema>;

const fileRecord = (record: FilesInput["record"]) =>
  record.kind === "company" ? { companyId: record.id } : { dealId: record.id };

export const writeFiles: (
  context: ToolContext,
  workspace: CrmWorkspace,
  input: FilesInput,
) => Promise<Written> = async (context, workspace, input) => {
  if (!input.link?.length && !input.unlink?.length) {
    return { error: "Give file ids to `link` or `unlink`." };
  }
  const crm = crmOf(context, workspace);
  const record = fileRecord(input.record);
  if (input.link?.length) {
    const linked = await crm.linkFiles(record, input.link);
    if (linked.status === "not_found") {
      return {
        error:
          "That record, or one of those files, is not one you can see. Files in Trash cannot be linked.",
      };
    }
    if (linked.status !== "ok") return refusal(linked);
  }
  for (const nodeId of input.unlink ?? []) {
    const unlinked = await crm.unlinkFile(record, nodeId);
    if (unlinked.status !== "ok") return refusal(unlinked);
  }
  const links = await crm.fileLinks(record);
  if (links.status !== "ok") return refusal(links);
  return {
    output: {
      result: "changed",
      files: links.links.map((link) => fileRow(context.webAppURL, workspace, link)),
    },
    kind: input.record.kind,
    ids: [input.record.id],
  } satisfies Written;
};

export const writeContract: (
  context: ToolContext,
  workspace: CrmWorkspace,
  input: ContractInput,
) => Promise<Written> = async (context, workspace, input) => {
  const crm = crmOf(context, workspace);
  const fields = {
    documentNodeId: input.document_node_id,
    effectiveOn: input.effective_on,
    expiresOn: input.expires_on,
  };
  if (input.id === undefined) {
    if (input.title === undefined) return { error: "Adding a contract needs `title`." };
    if (!input.company_id && !input.deal_id) {
      return { error: "A contract is on a company or a deal: give `company_id` or `deal_id`." };
    }
    const made = await crm.createContract({
      title: input.title,
      companyId: input.company_id,
      dealId: input.deal_id,
      ...fields,
    });
    if (made.status !== "ok") return refusal(made);
    return {
      output: { result: "added", contract: contractRow(made.contract) },
      kind: "contract",
      ids: [made.contract.id],
    } satisfies Written;
  }
  if (input.company_id || input.deal_id) {
    return { error: "A contract stays on its company or deal; add a new one to move it." };
  }
  const changed = await crm.updateContract(input.id, { title: input.title, ...fields });
  if (changed.status !== "ok") return refusal(changed);
  return {
    output: { result: "changed", contract: contractRow(changed.contract) },
    kind: "contract",
    ids: [changed.contract.id],
  } satisfies Written;
};
