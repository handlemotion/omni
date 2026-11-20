import type { McpServer } from "@modelcontextprotocol/server";
import { schema } from "@omni/db";
import { z } from "zod";
import { inGoodStanding } from "../../billing.ts";
import { announce, crmWorkspace, type CrmWorkspace } from "../crm.ts";
import {
  contractSchema,
  filesSchema,
  writeContract,
  writeFiles,
} from "../crm-write/attachments.ts";
import { bulkSchema, writeBulk } from "../crm-write/bulk.ts";
import { dealSchema, writeDeal } from "../crm-write/deal.ts";
import { noteSchema, writeNote } from "../crm-write/note.ts";
import {
  deliverableSchema,
  milestoneSchema,
  writeDeliverable,
  writeMilestone,
} from "../crm-write/plan.ts";
import { companySchema, personSchema, writeCompany, writePerson } from "../crm-write/records.ts";
import { outputSchema } from "../crm-write/shared.ts";
import { taskSchema, writeTask } from "../crm-write/task.ts";
import { result, toolError } from "../format.ts";
import { guarded, type ToolContext } from "../server.ts";

const inputSchema = z.object({
  person: personSchema.optional(),
  company: companySchema.optional(),
  deal: dealSchema.optional(),
  note: noteSchema.optional(),
  bulk: bulkSchema.optional(),
  task: taskSchema.optional(),
  files: filesSchema.optional(),
  contract: contractSchema.optional(),
  milestone: milestoneSchema.optional(),
  deliverable: deliverableSchema.optional(),
  workspace: z
    .string()
    .min(1)
    .optional()
    .describe("The workspace id to write in, when you are in several."),
});

type Input = z.infer<typeof inputSchema>;

const WRITES = [
  "person",
  "company",
  "deal",
  "note",
  "bulk",
  "task",
  "files",
  "contract",
  "milestone",
  "deliverable",
] as const;

function run(context: ToolContext, workspace: CrmWorkspace, input: Input) {
  if (input.person) return writePerson(context, workspace, input.person);
  if (input.company) return writeCompany(context, workspace, input.company);
  if (input.deal) return writeDeal(context, workspace, input.deal);
  if (input.note) return writeNote(context, workspace, input.note);
  if (input.bulk) return writeBulk(context, workspace, input.bulk);
  if (input.task) return writeTask(context, workspace, input.task);
  if (input.files) return writeFiles(context, workspace, input.files);
  if (input.contract) return writeContract(context, workspace, input.contract);
  if (input.milestone) return writeMilestone(context, workspace, input.milestone);
  if (input.deliverable) return writeDeliverable(context, workspace, input.deliverable);
  return Promise.resolve({ error: "Nothing to write." });
}

async function write(context: ToolContext, input: Input) {
  const given = WRITES.filter((k) => input[k]);
  if (given.length !== 1) {
    return toolError(
      "Give exactly one of `person`, `company`, `deal`, `note`, `bulk`, `task`, `files`, `contract`, `milestone` or `deliverable` per call.",
    );
  }
  const wait = await context.rateLimit("actions", input.bulk ? 5 : 1);
  if (wait) return toolError(`Too many changes. Try again in ${wait} seconds.`);
  const workspace = await crmWorkspace(context, input.workspace);
  if ("error" in workspace) return toolError(workspace.error);
  if (!(await inGoodStanding(context.db, context.config, workspace.orgId))) {
    return toolError("This workspace is read-only until its plan is paid.");
  }
  const written = await run(context, workspace, input);
  if ("error" in written) return toolError(written.error);
  await announce(context, workspace, written.kind, written.ids);
  if (written.ids.length) {
    await context.db.insert(schema.auditEvents).values(
      written.ids.map((subject) => ({
        orgId: workspace.orgId,
        actorMemberId: workspace.memberId,
        action: "mcp.crm_write",
        subject,
        data: {
          via: "mcp",
          clientId: context.caller.clientId,
          kind: written.kind,
          write: given[0],
          result: written.output.result,
        },
      })),
    );
  }
  return result(written.output);
}

export function registerCrmWrite(server: McpServer, context: ToolContext) {
  server.registerTool(
    "crm_write",
    {
      title: "Change the CRM",
      description:
        "Add or change CRM records, or add a note. Give exactly one of `person`, `company`, `deal`, `note`, `bulk`, `task`, `files`, `contract`, `milestone` or `deliverable`. With `id` it changes that record, only the fields given; without, it adds one (adding a person whose address is already known returns that person). A deal's `stage` moves it; a won deal is a running project. `owner` sets who owns a record. `archived: true` archives a record and `false` restores it; nothing is ever deleted. `bulk` makes one change (archive, restore, owner or stage) to many records of one kind. `task` adds, changes or completes (`done: true`) a task, on a record or none. `files` links Drive files to a company or deal where they are, or unlinks them. `contract` adds a draft contract or edits its title, document and dates; sending for signature stays with a person in the app. `milestone` and `deliverable` plan a project: milestones in order with a target day, deliverables under them with a Drive file, a status, and whether the client sees them on their portal. Address edits (`add_emails`, `remove_emails`, `primary_email`) need `id`. Records come back with their `url` to cite.",
      inputSchema,
      outputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    (input) => guarded(context, "crm_write", () => write(context, input)),
  );
}
