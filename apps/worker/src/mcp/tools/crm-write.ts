// `crm_write`: add or change one CRM record, or add a note (ADR 0036 decision 7). It never
// deletes and never archives. Writes go through the member door as the token's user in one
// company workspace, pass the same read-only gate as the app, announce `crm.changed` to the
// workspace's open apps and leave an audit row naming the agent.
import type { McpServer } from "@modelcontextprotocol/server";
import { schema, type CrmCompany, type CrmDeal, type CrmPerson } from "@omni/db";
import { z } from "zod";
import { inGoodStanding } from "../../billing.ts";
import {
  announce,
  companyRow,
  companyRowSchema,
  crmOf,
  crmWorkspace,
  dealRow,
  dealRowSchema,
  personRow,
  personRowSchema,
  refusalText,
  rowContext,
  teammate,
  type CrmWorkspace,
  type RecordKind,
} from "../crm.ts";
import { result, toolError } from "../format.ts";
import { guarded, type ToolContext } from "../server.ts";

const emails = z.array(z.string().min(1).max(320)).max(20);

const personSchema = z
  .object({
    id: z.string().min(1).optional().describe("Change this person. Leave out to add one."),
    name: z.string().max(200).optional(),
    email: z
      .string()
      .min(1)
      .max(320)
      .optional()
      .describe("Adding: their address. Someone who has it already is returned unchanged."),
    company_id: z.string().min(1).nullable().optional().describe("Null: no company."),
    job_title: z.string().max(200).nullable().optional(),
    phone: z.string().max(50).nullable().optional(),
    add_emails: emails.optional(),
    remove_emails: emails.optional(),
    primary_email: z.string().min(1).max(320).optional(),
  })
  .describe("Add or change a person. Adding needs `name` and `email`.");

const companySchema = z
  .object({
    id: z.string().min(1).optional().describe("Change this company. Leave out to add one."),
    name: z.string().max(200).optional(),
    description: z.string().max(5_000).nullable().optional(),
    domains: z.array(z.string().min(1)).max(10).optional().describe("Adding only: its domains."),
  })
  .describe("Add or change a company. Adding needs `name`.");

const dealSchema = z
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
    value_minor: z.number().int().nullable().optional().describe("In minor units (cents)."),
    currency: z.string().length(3).nullable().optional().describe("ISO 4217, like USD."),
    person_ids: z.array(z.string().min(1)).max(50).optional().describe("Its people, all of them."),
  })
  .describe("Add or change a deal, or move its stage. Adding needs `name`.");

const noteSchema = z
  .object({
    record: z.object({ kind: z.enum(["person", "company", "deal"]), id: z.string().min(1) }),
    text: z.string().min(1).max(20_000),
  })
  .describe("Add a note on a record.");

const inputSchema = z.object({
  person: personSchema.optional(),
  company: companySchema.optional(),
  deal: dealSchema.optional(),
  note: noteSchema.optional(),
  workspace: z
    .string()
    .min(1)
    .optional()
    .describe("The workspace id to write in, when you are in several."),
});

type Input = z.infer<typeof inputSchema>;

const outputSchema = z.object({
  result: z
    .enum(["added", "changed", "already_there"])
    .describe("already_there: a person with that address existed and is returned unchanged."),
  person: personRowSchema.optional(),
  company: companyRowSchema.optional(),
  deal: dealRowSchema.optional(),
  note: z
    .object({
      id: z.string(),
      record: z.object({ kind: z.enum(["person", "company", "deal"]), id: z.string() }),
      at: z.string(),
    })
    .optional(),
});

type Output = z.infer<typeof outputSchema>;
type Written = { output: Output; kind: RecordKind | "note"; id: string } | { error: string };

const refusal = (r: { status: string }) => ({ error: refusalText(r) });

const writePerson: (
  context: ToolContext,
  workspace: CrmWorkspace,
  input: NonNullable<Input["person"]>,
) => Promise<Written> = async (context, workspace, input) => {
  const crm = crmOf(context, workspace);
  let person: CrmPerson;
  let outcome: Output["result"];
  if (input.id === undefined) {
    if (input.name === undefined || input.email === undefined) {
      return { error: "Adding a person needs `name` and `email`." };
    }
    if (input.add_emails || input.remove_emails || input.primary_email) {
      return {
        error:
          "Address edits need the person's `id`. Add the person with `email` first, then change their addresses.",
      };
    }
    const added = await crm.addPerson({
      name: input.name,
      address: input.email,
      // Null is no company; left out, the company comes from the email's domain.
      companyId: input.company_id,
      jobTitle: input.job_title,
      phone: input.phone,
    });
    if (added.status !== "ok") return refusal(added);
    person = added.person;
    outcome = added.created ? "added" : "already_there";
  } else {
    const changed = await crm.updatePerson(input.id, {
      name: input.name,
      companyId: input.company_id,
      jobTitle: input.job_title,
      phone: input.phone,
      addresses:
        input.add_emails || input.remove_emails || input.primary_email
          ? { add: input.add_emails, remove: input.remove_emails, primary: input.primary_email }
          : undefined,
    });
    if (changed.status !== "ok") return refusal(changed);
    person = changed.person;
    outcome = "changed";
  }
  const rows = await rowContext(context, workspace, []);
  return {
    output: { result: outcome, person: personRow(person, rows) },
    kind: "person",
    id: person.id,
  };
};

const writeCompany: (
  context: ToolContext,
  workspace: CrmWorkspace,
  input: NonNullable<Input["company"]>,
) => Promise<Written> = async (context, workspace, input) => {
  const crm = crmOf(context, workspace);
  let company: CrmCompany;
  if (input.id === undefined) {
    if (input.name === undefined) return { error: "Adding a company needs `name`." };
    const added = await crm.createCompany({
      name: input.name,
      description: input.description,
      domains: input.domains,
    });
    if (added.status !== "ok") return refusal(added);
    company = added.company;
  } else {
    if (input.domains) return { error: "`domains` are set when a company is added." };
    const changed = await crm.updateCompany(input.id, {
      name: input.name,
      description: input.description,
    });
    if (changed.status !== "ok") return refusal(changed);
    company = changed.company;
  }
  const rows = await rowContext(context, workspace, []);
  return {
    output: { result: input.id ? "changed" : "added", company: companyRow(company, rows) },
    kind: "company",
    id: company.id,
  };
};

/** A stage named by id or by name, in any letter case. */
const stageId: (
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
  // A workspace that has never used its CRM has its starting stages from its first deal.
  if (!stages.stages.length) return { error: "Add the deal first; it starts in the first stage." };
  return {
    error: `No stage "${wanted}". Stages: ${stages.stages.map((s) => s.name).join(", ")}.`,
  };
};

async function writeDeal(
  context: ToolContext,
  workspace: CrmWorkspace,
  input: NonNullable<Input["deal"]>,
) {
  const crm = crmOf(context, workspace);
  const stage =
    input.stage === undefined ? undefined : await stageId(context, workspace, input.stage);
  if (stage && "error" in stage) {
    const value: Written = stage;
    return value;
  }
  let ownerMemberId: string | null | undefined = input.owner === null ? null : undefined;
  if (input.owner) {
    ownerMemberId = await teammate(context, workspace, input.owner);
    if (ownerMemberId === null) {
      const value: Written = { error: `${input.owner} is not in this workspace.` };
      return value;
    }
  }
  const fields = {
    companyId: input.company_id,
    stageId: stage?.id,
    ownerMemberId,
    valueMinor: input.value_minor,
    currency: input.currency?.toUpperCase() ?? input.currency,
    personIds: input.person_ids,
  };
  let deal: CrmDeal;
  if (input.id === undefined) {
    if (input.name === undefined) {
      const value: Written = { error: "Adding a deal needs `name`." };
      return value;
    }
    const added = await crm.createDeal({ name: input.name, ...fields });
    if (added.status !== "ok") {
      const value: Written = refusal(added);
      return value;
    }
    deal = added.deal;
  } else {
    const changed = await crm.updateDeal(input.id, { name: input.name, ...fields });
    if (changed.status !== "ok") {
      const value: Written = refusal(changed);
      return value;
    }
    deal = changed.deal;
  }
  const rows = await rowContext(context, workspace, [deal]);
  const value: Written = {
    output: { result: input.id ? "changed" : "added", deal: dealRow(deal, rows) },
    kind: "deal",
    id: deal.id,
  };
  return value;
}

const writeNote: (
  context: ToolContext,
  workspace: CrmWorkspace,
  input: NonNullable<Input["note"]>,
) => Promise<Written> = async (context, workspace, input) => {
  const { kind, id } = input.record;
  const record =
    kind === "person" ? { personId: id } : kind === "company" ? { companyId: id } : { dealId: id };
  const made = await crmOf(context, workspace).createNote({ record, body: input.text });
  if (made.status !== "ok") return refusal(made);
  // The record's timeline has the note too.
  await announce(context, workspace, kind, [id]);
  return {
    output: {
      result: "added",
      note: { id: made.note.id, record: { kind, id }, at: made.note.createdAt.toISOString() },
    },
    kind: "note",
    id: made.note.id,
  };
};

async function write(context: ToolContext, input: Input) {
  const given = (["person", "company", "deal", "note"] as const).filter((k) => input[k]);
  if (given.length !== 1) {
    return toolError("Give exactly one of `person`, `company`, `deal` or `note` per call.");
  }
  const wait = await context.rateLimit("actions");
  if (wait) return toolError(`Too many changes. Try again in ${wait} seconds.`);
  const workspace = await crmWorkspace(context, input.workspace);
  if ("error" in workspace) return toolError(workspace.error);
  if (!(await inGoodStanding(context.db, context.config, workspace.orgId))) {
    return toolError("This workspace is read-only until its plan is paid.");
  }
  const written = input.person
    ? await writePerson(context, workspace, input.person)
    : input.company
      ? await writeCompany(context, workspace, input.company)
      : input.deal
        ? await writeDeal(context, workspace, input.deal)
        : input.note
          ? await writeNote(context, workspace, input.note)
          : { error: "Nothing to write." };
  if ("error" in written) return toolError(written.error);
  await announce(context, workspace, written.kind, [written.id]);
  await context.db.insert(schema.auditEvents).values({
    orgId: workspace.orgId,
    actorMemberId: workspace.memberId,
    action: "mcp.crm_write",
    subject: written.id,
    data: {
      via: "mcp",
      clientId: context.caller.clientId,
      kind: written.kind,
      result: written.output.result,
    },
  });
  return result(written.output);
}

export function registerCrmWrite(server: McpServer, context: ToolContext) {
  server.registerTool(
    "crm_write",
    {
      title: "Change the CRM",
      description:
        "Add or change one record in the CRM, or add a note. Give exactly one of `person`, `company`, `deal` or `note`. With `id` it changes that record, only the fields given; without, it adds one (adding a person whose address is already known returns that person). A deal's `stage` moves it. Nothing is ever deleted or archived. Address edits (`add_emails`, `remove_emails`, `primary_email`) need `id`. The record comes back with its `url` to cite.",
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
