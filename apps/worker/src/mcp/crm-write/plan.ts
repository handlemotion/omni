import { z } from "zod";
import { crmOf, type CrmWorkspace } from "../crm.ts";
import { deliverableRow, milestoneRow } from "../crm-plan.ts";
import type { ToolContext } from "../server.ts";
import { refusal, type Written } from "./shared.ts";

const day = z.iso.date().nullable().optional().describe("YYYY-MM-DD; null for none.");
const description = z.string().max(20_000).nullable().optional();

export const milestoneSchema = z
  .object({
    id: z.string().min(1).optional().describe("Change this milestone. Leave out to add one."),
    deal: z.string().min(1).optional().describe("Adding: the deal (project) it is on."),
    title: z.string().min(1).max(300).optional(),
    description,
    target_on: day,
    status: z.enum(["planned", "in_progress", "done"]).optional(),
    position: z.number().int().min(0).max(1000).optional().describe("Move it to here, from 0."),
  })
  .describe("Add or change a milestone on a project. Adding needs `deal` and `title`.");

export const deliverableSchema = z
  .object({
    id: z.string().min(1).optional().describe("Change this deliverable. Leave out to add one."),
    deal: z.string().min(1).optional().describe("Adding: the deal (project) it is on."),
    title: z.string().min(1).max(300).optional(),
    description,
    milestone: z.string().min(1).nullable().optional().describe("A milestone of the same deal."),
    file: z.string().min(1).nullable().optional().describe("A Drive file id you can open."),
    due_on: day,
    status: z.enum(["draft", "in_review", "approved", "changes_requested"]).optional(),
    client_visible: z.boolean().optional().describe("Show it to the client on their portal."),
  })
  .describe("Add or change a deliverable on a project. Adding needs `deal` and `title`.");

const planRefusal = (r: { status: string }) => {
  if (r.status === "invalid_title") return { error: "Give a title of 1 to 300 characters." };
  if (r.status === "invalid_milestone") return { error: "That milestone is not on this deal." };
  if (r.status === "invalid_file") return { error: "That is not a Drive file you can open." };
  return refusal(r);
};

export const writeMilestone: (
  context: ToolContext,
  workspace: CrmWorkspace,
  input: z.infer<typeof milestoneSchema>,
) => Promise<Written> = async (context, workspace, input) => {
  const crm = crmOf(context, workspace);
  const fields = {
    description: input.description,
    targetOn: input.target_on,
    status: input.status,
  };
  if (input.id === undefined) {
    if (!input.deal || !input.title)
      return { error: "Adding a milestone needs `deal` and `title`." };
    const made = await crm.createMilestone(input.deal, { title: input.title, ...fields });
    if (made.status !== "ok") return planRefusal(made);
    return {
      output: { result: "added", milestone: milestoneRow(made.milestone) },
      kind: "deal",
      ids: [made.milestone.dealId],
    };
  }
  const changed = await crm.updateMilestone(input.id, {
    title: input.title,
    position: input.position,
    ...fields,
  });
  if (changed.status !== "ok") return planRefusal(changed);
  return {
    output: { result: "changed", milestone: milestoneRow(changed.milestone) },
    kind: "deal",
    ids: [changed.milestone.dealId],
  };
};

export const writeDeliverable: (
  context: ToolContext,
  workspace: CrmWorkspace,
  input: z.infer<typeof deliverableSchema>,
) => Promise<Written> = async (context, workspace, input) => {
  const crm = crmOf(context, workspace);
  const fields = {
    description: input.description,
    milestoneId: input.milestone,
    nodeId: input.file,
    dueOn: input.due_on,
    status: input.status,
    clientVisible: input.client_visible,
  };
  const done = input.id
    ? await crm.updateDeliverable(input.id, { title: input.title, ...fields })
    : input.deal && input.title
      ? await crm.createDeliverable(input.deal, { title: input.title, ...fields })
      : null;
  if (!done) return { error: "Adding a deliverable needs `deal` and `title`." };
  if (done.status !== "ok") return planRefusal(done);
  return {
    output: {
      result: input.id ? "changed" : "added",
      deliverable: deliverableRow(done.deliverable),
    },
    kind: "deal",
    ids: [done.deliverable.dealId],
  };
};
