import type { CrmPerson } from "@omni/db";
import { z } from "zod";
import { companyRow, crmOf, personRow, rowContext, type CrmWorkspace } from "../crm.ts";
import type { ToolContext } from "../server.ts";
import {
  archivedSchema,
  changesFields,
  ownerId,
  ownerSchema,
  refusal,
  type Output,
  type Written,
} from "./shared.ts";

const emails = z.array(z.string().min(1).max(320)).max(20);
const domains = z.array(z.string().min(1).max(253)).max(10);

export const personSchema = z
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
    owner: ownerSchema,
    add_emails: emails.optional(),
    remove_emails: emails.optional(),
    primary_email: z.string().min(1).max(320).optional(),
    archived: archivedSchema,
  })
  .describe("Add or change a person. Adding needs `name` and `email`.");

export const companySchema = z
  .object({
    id: z.string().min(1).optional().describe("Change this company. Leave out to add one."),
    name: z.string().max(200).optional(),
    description: z.string().max(5_000).nullable().optional(),
    owner: ownerSchema.describe(
      '"me", a teammate\'s email, or null for no owner. Adding: you by default.',
    ),
    domains: domains.optional().describe("Adding only: its domains."),
    add_domains: domains.optional().describe("Changing: domains to add."),
    remove_domains: domains.optional().describe("Changing: domains to take off."),
    archived: archivedSchema,
  })
  .describe("Add or change a company. Adding needs `name`.");

type PersonInput = z.infer<typeof personSchema>;
type CompanyInput = z.infer<typeof companySchema>;

async function addPerson(context: ToolContext, workspace: CrmWorkspace, input: PersonInput) {
  if (input.name === undefined || input.email === undefined) {
    return { error: "Adding a person needs `name` and `email`." };
  }
  if (input.add_emails || input.remove_emails || input.primary_email) {
    return {
      error:
        "Address edits need the person's `id`. Add the person with `email` first, then change their addresses.",
    };
  }
  const owner = await ownerId(context, workspace, input.owner);
  if ("error" in owner) return owner;
  const added = await crmOf(context, workspace).addPerson({
    name: input.name,
    address: input.email,
    companyId: input.company_id,
    jobTitle: input.job_title,
    phone: input.phone,
    ownerMemberId: owner.id,
  });
  if (added.status !== "ok") return refusal(added);
  const result: Output["result"] = added.created ? "added" : "already_there";
  return { person: added.person, result };
}

async function changePerson(
  context: ToolContext,
  workspace: CrmWorkspace,
  id: string,
  input: PersonInput,
) {
  const crm = crmOf(context, workspace);
  const owner = await ownerId(context, workspace, input.owner);
  if ("error" in owner) return owner;
  let person: CrmPerson | undefined;
  if (changesFields(input)) {
    const changed = await crm.updatePerson(id, {
      name: input.name,
      companyId: input.company_id,
      jobTitle: input.job_title,
      phone: input.phone,
      ownerMemberId: owner.id,
      addresses:
        input.add_emails || input.remove_emails || input.primary_email
          ? {
              add: input.add_emails,
              remove: input.remove_emails,
              primary: input.primary_email,
            }
          : undefined,
    });
    if (changed.status !== "ok") return refusal(changed);
    person = changed.person;
  }
  if (input.archived !== undefined) {
    const moved = input.archived ? await crm.archivePerson(id) : await crm.restorePerson(id);
    if (moved.status !== "ok") return refusal(moved);
    person = moved.person;
  }
  if (!person) return { error: "Give at least one field to change." };
  const result: Output["result"] = "changed";
  return { person, result };
}

export async function writePerson(
  context: ToolContext,
  workspace: CrmWorkspace,
  input: PersonInput,
) {
  if (input.id === undefined && input.archived !== undefined) {
    return { error: "`archived` changes a person: give their `id`." };
  }
  const done =
    input.id === undefined
      ? await addPerson(context, workspace, input)
      : await changePerson(context, workspace, input.id, input);
  if ("error" in done) return done;
  const rows = await rowContext(context, workspace, [done.person]);
  return {
    output: { result: done.result, person: personRow(done.person, rows) },
    kind: "person",
    ids: [done.person.id],
  } satisfies Written;
}

async function addCompany(context: ToolContext, workspace: CrmWorkspace, input: CompanyInput) {
  if (input.name === undefined) return { error: "Adding a company needs `name`." };
  if (input.add_domains || input.remove_domains) {
    return {
      error: "Adding a company takes its `domains`; `add_domains` needs an `id`.",
    };
  }
  const owner = await ownerId(context, workspace, input.owner);
  if ("error" in owner) return owner;
  const added = await crmOf(context, workspace).createCompany({
    name: input.name,
    description: input.description,
    domains: input.domains,
    ownerMemberId: owner.id,
  });
  return added.status === "ok" ? { company: added.company } : refusal(added);
}

async function changeCompany(
  context: ToolContext,
  workspace: CrmWorkspace,
  id: string,
  input: CompanyInput,
) {
  if (input.domains) return { error: "Change domains with `add_domains` and `remove_domains`." };
  const owner = await ownerId(context, workspace, input.owner);
  if ("error" in owner) return owner;
  if (!changesFields(input) && input.archived === undefined) {
    return { error: "Give at least one field to change." };
  }
  const changed = await crmOf(context, workspace).changeCompany(id, {
    patch: { name: input.name, description: input.description, ownerMemberId: owner.id },
    addDomains: input.add_domains,
    removeDomains: input.remove_domains,
    archived: input.archived,
  });
  if (changed.status !== "ok" || !("company" in changed)) return refusal(changed);
  return { company: changed.company };
}

export async function writeCompany(
  context: ToolContext,
  workspace: CrmWorkspace,
  input: CompanyInput,
) {
  if (input.id === undefined && input.archived !== undefined) {
    return { error: "`archived` changes a company: give its `id`." };
  }
  const done =
    input.id === undefined
      ? await addCompany(context, workspace, input)
      : await changeCompany(context, workspace, input.id, input);
  if ("error" in done) return done;
  const rows = await rowContext(context, workspace, [done.company]);
  return {
    output: {
      result: input.id ? "changed" : "added",
      company: companyRow(done.company, rows),
    },
    kind: "company",
    ids: [done.company.id],
  } satisfies Written;
}
