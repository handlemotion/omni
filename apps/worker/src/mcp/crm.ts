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
  return { error: `Name the workspace to write in with \`workspace\`: one of ${names}.` };
}

export const crmOf: (context: ToolContext, workspace: CrmWorkspace) => MemberCrm = (
  context,
  workspace,
) => forMember(context.db, workspace.memberId).crm;

export type RecordKind = "person" | "company" | "deal";

const personNameSchema = z.object({ name: z.string().nullable(), address: z.string() });

const common = {
  id: z.string(),
  name: z.string(),
  workspace: z.string().describe("The workspace id it is in."),
  archived: z.boolean(),
  url: z.string().describe("Where it opens in the web app: cite it."),
};

const RECORD_PATH = { person: "people", company: "companies", deal: "deals" } as const;

/** `/crm/people/<id>`, `/crm/companies/<id>` or `/crm/deals/<id>` on the web app. */
export function recordUrl(webAppURL: string, kind: RecordKind, id: string) {
  return new URL(`/crm/${RECORD_PATH[kind]}/${encodeURIComponent(id)}`, webAppURL).toString();
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
  owner: personNameSchema.nullable().describe("The teammate who owns it."),
  value: z
    .object({ amount_minor: z.number(), currency: z.string().nullable() })
    .nullable()
    .describe("In minor units (cents)."),
  won_at: z.string().nullable(),
  closed_at: z.string().nullable(),
});

export type PersonRow = z.infer<typeof personRowSchema>;
export type CompanyRow = z.infer<typeof companyRowSchema>;
export type DealRow = z.infer<typeof dealRowSchema>;

/** What rows need beside the record: the workspace, its stages and its owners' names. */
export interface RowContext {
  workspace: string;
  webAppURL: string;
  stages: CrmStage[];
  owners: Map<string, { name: string | null; address: string }>;
}

export function personRow(person: CrmPerson, row: RowContext) {
  return {
    kind: "person",
    id: person.id,
    name: person.name,
    workspace: row.workspace,
    archived: person.archivedAt !== null,
    url: recordUrl(row.webAppURL, "person", person.id),
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
    url: recordUrl(row.webAppURL, "company", company.id),
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
    url: recordUrl(row.webAppURL, "deal", deal.id),
    company_id: deal.companyId,
    stage: { id: deal.stageId, name: stage?.name ?? deal.stageKind, kind: deal.stageKind },
    owner: deal.ownerMemberId ? (row.owners.get(deal.ownerMemberId) ?? null) : null,
    value:
      deal.valueMinor === null
        ? null
        : { amount_minor: deal.valueMinor, currency: deal.valueCurrency },
    won_at: deal.wonAt?.toISOString() ?? null,
    closed_at: deal.closedAt?.toISOString() ?? null,
  } satisfies DealRow;
}

/** Names and addresses of the members `ids` names (deal owners, note authors). */
export async function memberPeople(context: ToolContext, ids: (string | null)[]) {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!wanted.length) return new Map<string, { name: string | null; address: string }>();
  const rows = await context.db
    .select({ id: schema.members.id, name: schema.users.name, email: schema.users.email })
    .from(schema.members)
    .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
    .where(inArray(schema.members.id, wanted));
  return new Map(rows.map((r) => [r.id, { name: r.name || null, address: r.email }]));
}

/** The row context for `deals` in `workspace`: its stages and the owners' names. */
export async function rowContext(context: ToolContext, workspace: CrmWorkspace, deals: CrmDeal[]) {
  const [stages, owners] = await Promise.all([
    deals.length ? crmOf(context, workspace).stages() : null,
    memberPeople(
      context,
      deals.map((d) => d.ownerMemberId),
    ),
  ]);
  return {
    workspace: workspace.orgId,
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

/** One sentence for each refusal the CRM door can answer. */
export function refusalText(refusal: { status: string }) {
  switch (refusal.status) {
    case "no_crm":
      return NO_CRM;
    case "not_found":
      return "No record with that id here. Ids come from `crm_search`.";
    case "forbidden":
      return "Only the note's author or an owner or admin can do this.";
    case "invalid_name":
      return "That name cannot be used: give 1 to 200 characters.";
    case "invalid_address":
      return "That is not an email address.";
    case "invalid_domain":
      return "That is not a domain.";
    case "webmail_domain":
      return "A webmail domain (gmail.com and the like) is nobody's company.";
    case "domain_taken":
      return "Another company already has that domain. Find it with `crm_search`.";
    case "address_taken":
      return "Another person already has that address. Find them with `crm_search`.";
    case "invalid_currency":
      return "That is not a currency: use a three-letter ISO code like USD.";
    case "invalid_value":
      return "The value must be a whole number of minor units (cents).";
    case "invalid_body":
      return "A note needs some text, up to 20,000 characters.";
    default:
      return "Omni could not make that change.";
  }
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
      .broadcast(audience.memberIds, { type: "crm.changed", kind, ids: changed })
      .catch((error: unknown) => context.log.warn("crm.announce_failed", { error })),
  );
}
