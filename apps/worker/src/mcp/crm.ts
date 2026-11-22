import type { CrmChangedKind } from "@omni/contracts";
import {
  forMember,
  type MemberCrm,
  isCompany,
  schema,
  type CrmCompany,
  type CrmDeal,
  type CrmPerson,
  type CrmStage,
} from "@omni/db";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { ToolContext } from "./server.ts";

/** One company workspace a call reaches, and the token user's member there. */
export interface CrmWorkspace {
  orgId: string;
  name: string;
  /** Where its pages live on the web app: `/<slug>/crm/...`. */
  slug: string;
  memberId: string;
}

const NO_CRM =
  "There is no CRM here: only company workspaces have one, and a Personal space does not.";

/**
 * The company workspaces the call reaches: the grant's one workspace, or the one `workspace`
 * names, or every company the user belongs to. Membership is read live on every call.
 */
export const crmWorkspaces: (
  context: ToolContext,
  workspace: string | undefined,
) => Promise<{ workspaces: CrmWorkspace[] } | { error: string }> = async (context, workspace) => {
  const granted = context.caller.workspace;
  if (granted !== null && workspace !== undefined && workspace !== granted) {
    return {
      error: "This connection only reaches one workspace. Leave `workspace` out to use it.",
    };
  }
  const target = granted ?? (workspace || null);
  const { db } = context;
  const rows = await db
    .select({
      orgId: schema.organizations.id,
      name: schema.organizations.name,
      slug: schema.organizations.slug,
      memberId: schema.members.id,
    })
    .from(schema.members)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.members.organizationId))
    .where(
      and(
        eq(schema.members.userId, context.caller.userId),
        target ? eq(schema.members.organizationId, target) : undefined,
        isCompany(db, schema.organizations.id),
      ),
    )
    .orderBy(schema.members.createdAt, schema.organizations.id);
  return rows.length ? { workspaces: rows } : { error: NO_CRM };
};

/** The one workspace a write goes to; several reachable workspaces need `workspace` named. */
export async function crmWorkspace(context: ToolContext, workspace: string | undefined) {
  const found = await crmWorkspaces(context, workspace);
  if ("error" in found) return found;
  const [only, ...others] = found.workspaces;
  if (only && !others.length) return only;
  const names = found.workspaces.map((w) => `${w.orgId} (${w.name})`).join(", ");
  return {
    error: `Name the workspace to write in with \`workspace\`: one of ${names}.`,
  };
}

export const crmOf: (context: ToolContext, workspace: CrmWorkspace) => MemberCrm = (
  context,
  workspace,
) => forMember(context.db, workspace.memberId).crm;

export type RecordKind = "person" | "company" | "deal";

const personNameSchema = z.object({
  name: z.string().nullable(),
  address: z.string(),
});

const common = {
  id: z.string(),
  name: z.string(),
  workspace: z.string().describe("The workspace id it is in."),
  archived: z.boolean(),
  url: z.string().describe("Where it opens in the web app: cite it."),
  owner: personNameSchema.nullable().describe("The teammate who owns it."),
};

const RECORD_PATH = {
  person: "people",
  company: "companies",
  deal: "deals",
} as const;

/** `/<slug>/crm/people/<id>`, `…/companies/<id>` or `…/deals/<id>` on the web app. */
export function recordUrl(row: RowContext, kind: RecordKind, id: string) {
  const path = `/${encodeURIComponent(row.slug)}/crm/${RECORD_PATH[kind]}/${encodeURIComponent(id)}`;
  return new URL(path, row.webAppURL).toString();
}

export const personRowSchema = z.object({
  kind: z.literal("person"),
  ...common,
  email: z.string().nullable().describe("The primary address."),
  emails: z.array(z.string()),
  job_title: z.string().nullable(),
  phone: z.string().nullable(),
  company_id: z.string().nullable(),
});

export const companyRowSchema = z.object({
  kind: z.literal("company"),
  ...common,
  description: z.string().nullable(),
});

export const dealRowSchema = z.object({
  kind: z.literal("deal"),
  ...common,
  company_id: z.string().nullable(),
  stage: z.object({
    id: z.string(),
    name: z.string(),
    kind: z.enum(["open", "won", "done", "lost"]),
  }),
  value: z
    .object({ amount_minor: z.number(), currency: z.string().nullable() })
    .nullable()
    .describe("In minor units (cents)."),
  expected_close_on: z.string().nullable().describe("When it should close, YYYY-MM-DD."),
  won_at: z.string().nullable(),
  closed_at: z.string().nullable(),
});

export type PersonRow = z.infer<typeof personRowSchema>;
export type CompanyRow = z.infer<typeof companyRowSchema>;
export type DealRow = z.infer<typeof dealRowSchema>;

/** What rows need beside the record: the workspace, its stages and its owners' names. */
export interface RowContext {
  workspace: string;
  slug: string;
  webAppURL: string;
  stages: CrmStage[];
  owners: Map<string, { name: string | null; address: string }>;
}

const ownerOf = (record: { ownerMemberId: string | null }, row: RowContext) =>
  record.ownerMemberId ? (row.owners.get(record.ownerMemberId) ?? null) : null;

export function personRow(person: CrmPerson, row: RowContext) {
  return {
    kind: "person",
    id: person.id,
    name: person.name,
    workspace: row.workspace,
    archived: person.archivedAt !== null,
    url: recordUrl(row, "person", person.id),
    owner: ownerOf(person, row),
    email: person.addresses.find((a) => a.isPrimary)?.address ?? null,
    emails: person.addresses.map((a) => a.address),
    job_title: person.jobTitle,
    phone: person.phone,
    company_id: person.companyId,
  } satisfies PersonRow;
}

export function companyRow(company: CrmCompany, row: RowContext) {
  return {
    kind: "company",
    id: company.id,
    name: company.name,
    workspace: row.workspace,
    archived: company.archivedAt !== null,
    url: recordUrl(row, "company", company.id),
    owner: ownerOf(company, row),
    description: company.description,
  } satisfies CompanyRow;
}

export function dealRow(deal: CrmDeal, row: RowContext) {
  const stage = row.stages.find((s) => s.id === deal.stageId);
  return {
    kind: "deal",
    id: deal.id,
    name: deal.name,
    workspace: row.workspace,
    archived: deal.archivedAt !== null,
    url: recordUrl(row, "deal", deal.id),
    owner: ownerOf(deal, row),
    company_id: deal.companyId,
    stage: {
      id: deal.stageId,
      name: stage?.name ?? deal.stageKind,
      kind: deal.stageKind,
    },
    value:
      deal.valueMinor === null
        ? null
        : { amount_minor: deal.valueMinor, currency: deal.valueCurrency },
    expected_close_on: deal.expectedCloseOn,
    won_at: deal.wonAt?.toISOString() ?? null,
    closed_at: deal.closedAt?.toISOString() ?? null,
  } satisfies DealRow;
}

/** Names and addresses of the members `ids` names (deal owners, note authors). */
export async function memberPeople(context: ToolContext, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!wanted.length) return new Map<string, { name: string | null; address: string }>();
  const rows = await context.db
    .select({
      id: schema.members.id,
      name: schema.users.name,
      email: schema.users.email,
    })
    .from(schema.members)
    .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
    .where(inArray(schema.members.id, wanted));
  return new Map(rows.map((r) => [r.id, { name: r.name || null, address: r.email }]));
}

/** The records a row context is for: any of them a deal, the workspace's stages are read. */
type Owned = CrmPerson | CrmCompany | CrmDeal;

/** The row context for `records` in `workspace`: its stages and the owners' names. */
export async function rowContext(context: ToolContext, workspace: CrmWorkspace, records: Owned[]) {
  const [stages, owners] = await Promise.all([
    records.some((r) => "stageId" in r) ? crmOf(context, workspace).stages() : null,
    memberPeople(
      context,
      records.map((r) => r.ownerMemberId),
    ),
  ]);
  return {
    workspace: workspace.orgId,
    slug: workspace.slug,
    webAppURL: context.webAppURL,
    stages: stages?.status === "ok" ? stages.stages : [],
    owners,
  } satisfies RowContext;
}

/** A teammate named as `"me"` or by their email: their member id in the workspace. */
export async function teammate(context: ToolContext, workspace: CrmWorkspace, who: string) {
  if (who.toLowerCase() === "me") return workspace.memberId;
  const [row] = await context.db
    .select({ id: schema.members.id })
    .from(schema.members)
    .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
    .where(
      and(
        eq(schema.members.organizationId, workspace.orgId),
        eq(schema.users.email, who.trim().toLowerCase()),
      ),
    );
  return row?.id ?? null;
}

const REFUSALS: Record<string, string> = {
  no_crm: NO_CRM,
  not_found: "No record with that id here. Ids come from `crm_search`.",
  forbidden: "You may not do this here: it is for the note's author, or for an owner or admin.",
  invalid_name: "That name cannot be used: give 1 to 200 characters.",
  invalid_address: "That is not an email address.",
  invalid_domain: "That is not a domain.",
  webmail_domain: "A webmail domain (gmail.com and the like) is nobody's company.",
  domain_taken: "Another company already has that domain. Find it with `crm_search`.",
  address_taken: "Another person already has that address. Find them with `crm_search`.",
  invalid_currency:
    "Give `currency` as a three-letter ISO code like USD or MXN; a value without one needs the workspace to have a default currency.",
  invalid_value: "The value must be a whole number of minor units (cents).",
  invalid_body: "A note needs some text, up to 20,000 characters.",
  invalid_title: "A task needs a title of 1 to 500 characters.",
  invalid_assignee: "That assignee is not in this workspace, or cannot open the task's record.",
  private_task:
    "A task on no record is its owner's alone; put it on a company, person or deal to assign it.",
  invalid_contract:
    "That contract change is not valid: a document is a file in Shared, dates are YYYY-MM-DD, and it cannot expire before it starts.",
  invalid_transition:
    "That contract can no longer change that way: a signed contract keeps its document and terms.",
  contract_signed:
    "That contract can no longer change that way: a signed contract keeps its document and terms.",
  signature_open: "It is out for signature: a person voids the request in Omni before it changes.",
  invalid_action: "That change does not apply to this kind of record.",
};

/** One sentence for each refusal the CRM door can answer. */
export function refusalText(refusal: { status: string }) {
  return REFUSALS[refusal.status] ?? `Omni could not make that change (${refusal.status}).`;
}

/**
 * Tells the workspace's members what changed (`crm.changed`, ids only), as the HTTP routes do:
 * the audience is read now, so a member removed after connecting hears nothing. Sent after the
 * answer.
 */
export async function announce(
  context: ToolContext,
  workspace: CrmWorkspace,
  kind: CrmChangedKind,
  ids: (string | null)[],
) {
  const changed = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!changed.length) return;
  const audience = await crmOf(context, workspace).audience();
  if (audience.status !== "ok" || audience.memberIds.length === 0) return;
  const stub = context.env.REALTIME.get(context.env.REALTIME.idFromName(workspace.orgId));
  context.waitUntil(
    stub
      .broadcast(audience.memberIds, {
        type: "crm.changed",
        kind,
        ids: changed,
      })
      .catch((error: unknown) => context.log.warn("crm.announce_failed", { error })),
  );
}
