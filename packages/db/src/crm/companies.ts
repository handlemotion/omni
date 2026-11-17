import { isWebmailDomain } from "@omni/mail-core/addresses";
import { and, asc, eq, sql, type AnyColumn } from "drizzle-orm";
import { crmCompanies, crmCompanyDomains, crmDeals, crmPeople, crmStages } from "../schema/crm.ts";
import { CONTRACT_SIGNED, type ContractSigned } from "./contract-status.ts";
import { holdsSignedContract } from "./contracts.ts";
import {
  afterName,
  appendEvent,
  FORBIDDEN,
  likePrefix,
  namePage,
  NOT_FOUND,
  pageSize,
  refuse,
  wordsOf,
  type CrmMember,
  type CrmNameCursor,
  type Ex,
  type Forbidden,
  type NotFound,
} from "./core.ts";
import {
  cleanName,
  companyColumns,
  dealColumns,
  domainsOf,
  live,
  loadCompany,
  normalizeDomain,
  personColumns,
  withAddresses,
  type CrmCompany,
  type CrmDeal,
  type CrmPerson,
} from "./records.ts";

export type InvalidName = { status: "invalid_name" };
export type DomainRefusal =
  | { status: "invalid_domain" }
  | { status: "webmail_domain" }
  | { status: "domain_taken"; companyId: string };

export interface ListCompaniesInput {
  /** Words the name, or one of its words, starts with. */
  q?: string;
  cursor?: CrmNameCursor | null;
  limit?: number;
  includeArchived?: boolean;
}

export type CompanyResult = { status: "ok"; company: CrmCompany } | NotFound;
export type CompanyDetailResult =
  | {
      status: "ok";
      company: CrmCompany;
      domains: string[];
      people: CrmPerson[];
      deals: CrmDeal[];
    }
  | NotFound;
export type CreateCompanyResult =
  | { status: "ok"; company: CrmCompany }
  | InvalidName
  | DomainRefusal;
export type UpdateCompanyResult = CompanyResult | InvalidName;
/** `contract_signed`: the record holds a signed contract, which must outlive it. */
export type DeleteResult = { status: "ok" } | NotFound | Forbidden | ContractSigned;
export type DomainResult = { status: "ok"; domains: string[] } | NotFound | DomainRefusal;

/** Each word must start the name or one of its words. */
export function nameMatches(name: AnyColumn, q?: string) {
  const words = wordsOf(q ?? "");
  if (words.length === 0) return undefined;
  return and(
    ...words.map(
      (word) =>
        sql`(lower(${name}) like ${likePrefix(word)} or lower(${name}) like ${`% ${likePrefix(word)}`})`,
    ),
  );
}

export async function listCompanies(ex: Ex, member: CrmMember, input: ListCompaniesInput) {
  const limit = pageSize(input.limit);
  const rows = await ex
    .select({
      ...companyColumns,
      domain: sql<string | null>`(select ${crmCompanyDomains.domain} from ${crmCompanyDomains}
        where ${crmCompanyDomains.orgId} = ${crmCompanies.orgId}
          and ${crmCompanyDomains.companyId} = ${crmCompanies.id}
        order by ${crmCompanyDomains.domain} limit 1)`,
    })
    .from(crmCompanies)
    .where(
      and(
        eq(crmCompanies.orgId, member.orgId),
        live(crmCompanies.archivedAt, input.includeArchived),
        nameMatches(crmCompanies.name, input.q),
        afterName(crmCompanies.name, crmCompanies.id, input.cursor),
      ),
    )
    .orderBy(sql`lower(${crmCompanies.name})`, asc(crmCompanies.id))
    .limit(limit + 1);
  const page = namePage(rows, limit);
  return { status: "ok" as const, companies: page.items, nextCursor: page.nextCursor };
}

/** A company with its domains, its live people and its live deals. Archived ones are readable. */
export const getCompany: (
  ex: Ex,
  member: CrmMember,
  id: string,
) => Promise<CompanyDetailResult> = async (ex, member, id) => {
  const company = await loadCompany(ex, member.orgId, id);
  if (!company) return NOT_FOUND;
  const people = await ex
    .select(personColumns)
    .from(crmPeople)
    .where(and(eq(crmPeople.companyId, id), live(crmPeople.archivedAt)))
    .orderBy(sql`lower(${crmPeople.name})`, asc(crmPeople.id));
  const deals = await ex
    .select(dealColumns)
    .from(crmDeals)
    .innerJoin(crmStages, eq(crmStages.id, crmDeals.stageId))
    .where(and(eq(crmDeals.companyId, id), live(crmDeals.archivedAt)))
    .orderBy(sql`lower(${crmDeals.name})`, asc(crmDeals.id));
  return {
    status: "ok",
    company,
    domains: await domainsOf(ex, id),
    people: await withAddresses(ex, people),
    deals,
  };
};

const checkDomain: (input: string) => { domain: string } | DomainRefusal = (input) => {
  const domain = normalizeDomain(input);
  if (!domain) return { status: "invalid_domain" };
  if (isWebmailDomain(domain)) return { status: "webmail_domain" };
  return { domain };
};

async function claimDomain(tx: Ex, member: CrmMember, companyId: string, domain: string) {
  const made = await tx
    .insert(crmCompanyDomains)
    .values({ orgId: member.orgId, companyId, domain })
    .onConflictDoNothing()
    .returning({ domain: crmCompanyDomains.domain });
  if (made.length > 0) return { status: "ok" as const, added: true };
  const [holder] = await tx
    .select({ companyId: crmCompanyDomains.companyId })
    .from(crmCompanyDomains)
    .where(and(eq(crmCompanyDomains.orgId, member.orgId), eq(crmCompanyDomains.domain, domain)));
  if (!holder || holder.companyId === companyId) return { status: "ok" as const, added: false };
  return { status: "domain_taken" as const, companyId: holder.companyId };
}

export const createCompany: (
  tx: Ex,
  member: CrmMember,
  input: { name: string; description?: string | null; domains?: string[] },
) => Promise<CreateCompanyResult> = async (tx, member, input) => {
  const name = cleanName(input.name);
  if (!name) return { status: "invalid_name" };
  const domains: string[] = [];
  for (const raw of input.domains ?? []) {
    const checked = checkDomain(raw);
    if ("status" in checked) return checked;
    domains.push(checked.domain);
  }
  const [company] = await tx
    .insert(crmCompanies)
    .values({
      orgId: member.orgId,
      name,
      description: input.description ?? null,
      createdByMemberId: member.id,
    })
    .returning(companyColumns);
  for (const domain of new Set(domains)) {
    const claimed = await claimDomain(tx, member, company!.id, domain);
    if (claimed.status !== "ok") refuse(claimed);
  }
  await appendEvent(tx, member, { companyId: company!.id }, "created");
  return { status: "ok", company: company! };
};

/**
 * The company holding `domain`, or a new one named `name` that holds it. Two first adds at once
 * make one company: the loser of the domain's unique key removes its own row and takes the
 * winner's.
 */
export async function companyForDomain(tx: Ex, member: CrmMember, domain: string, name: string) {
  const held = async () => {
    const [row] = await tx
      .select({ companyId: crmCompanyDomains.companyId })
      .from(crmCompanyDomains)
      .where(and(eq(crmCompanyDomains.orgId, member.orgId), eq(crmCompanyDomains.domain, domain)));
    return row?.companyId ?? null;
  };
  const existing = await held();
  if (existing) return existing;
  const [company] = await tx
    .insert(crmCompanies)
    .values({ orgId: member.orgId, name, createdByMemberId: member.id })
    .returning({ id: crmCompanies.id });
  const claimed = await claimDomain(tx, member, company!.id, domain);
  if (claimed.status === "ok") {
    await appendEvent(tx, member, { companyId: company!.id }, "created", { domain });
    return company!.id;
  }
  await tx.delete(crmCompanies).where(eq(crmCompanies.id, company!.id));
  return claimed.companyId;
}

export const updateCompany: (
  tx: Ex,
  member: CrmMember,
  id: string,
  patch: { name?: string; description?: string | null },
) => Promise<UpdateCompanyResult> = async (tx, member, id, patch) => {
  const company = await loadCompany(tx, member.orgId, id, true);
  if (!company) return NOT_FOUND;
  const next: { name?: string; description?: string | null } = {};
  if (patch.name !== undefined) {
    const name = cleanName(patch.name);
    if (!name) return { status: "invalid_name" };
    if (name !== company.name) next.name = name;
  }
  if (patch.description !== undefined && patch.description !== company.description) {
    next.description = patch.description;
  }
  const fields = Object.keys(next).toSorted();
  if (fields.length === 0) return { status: "ok", company };
  const [updated] = await tx
    .update(crmCompanies)
    .set(next)
    .where(eq(crmCompanies.id, id))
    .returning(companyColumns);
  await appendEvent(tx, member, { companyId: id }, "updated", { fields });
  return { status: "ok", company: updated! };
};

export const archiveCompany: (
  tx: Ex,
  member: CrmMember,
  id: string,
) => Promise<CompanyResult> = async (tx, member, id) => {
  const company = await loadCompany(tx, member.orgId, id, true);
  if (!company) return NOT_FOUND;
  if (company.archivedAt) return { status: "ok", company };
  const [updated] = await tx
    .update(crmCompanies)
    .set({ archivedAt: new Date() })
    .where(eq(crmCompanies.id, id))
    .returning(companyColumns);
  await appendEvent(tx, member, { companyId: id }, "archived");
  return { status: "ok", company: updated! };
};

/**
 * Deletes for good: its domains, notes, events and contracts go with it; its people and deals
 * stay, with no company; its folder stays in Storage. Owners and admins only.
 */
export const deleteCompany: (
  tx: Ex,
  member: CrmMember,
  id: string,
) => Promise<DeleteResult> = async (tx, member, id) => {
  if (!member.admin) return FORBIDDEN;
  if (await holdsSignedContract(tx, member.orgId, { companyId: id })) return CONTRACT_SIGNED;
  const deleted = await tx
    .delete(crmCompanies)
    .where(and(eq(crmCompanies.orgId, member.orgId), eq(crmCompanies.id, id)))
    .returning({ id: crmCompanies.id });
  return deleted.length > 0 ? { status: "ok" } : NOT_FOUND;
};

export const addCompanyDomain: (
  tx: Ex,
  member: CrmMember,
  id: string,
  input: string,
) => Promise<DomainResult> = async (tx, member, id, input) => {
  const company = await loadCompany(tx, member.orgId, id, true);
  if (!company) return NOT_FOUND;
  const checked = checkDomain(input);
  if ("status" in checked) return checked;
  const claimed = await claimDomain(tx, member, id, checked.domain);
  if (claimed.status !== "ok") return claimed;
  if (claimed.added) {
    await appendEvent(tx, member, { companyId: id }, "domain_added", { domain: checked.domain });
  }
  return { status: "ok", domains: await domainsOf(tx, id) };
};

export const removeCompanyDomain: (
  tx: Ex,
  member: CrmMember,
  id: string,
  input: string,
) => Promise<DomainResult> = async (tx, member, id, input) => {
  const company = await loadCompany(tx, member.orgId, id, true);
  if (!company) return NOT_FOUND;
  const domain = normalizeDomain(input);
  const removed = domain
    ? await tx
        .delete(crmCompanyDomains)
        .where(
          and(
            eq(crmCompanyDomains.orgId, member.orgId),
            eq(crmCompanyDomains.companyId, id),
            eq(crmCompanyDomains.domain, domain),
          ),
        )
        .returning({ domain: crmCompanyDomains.domain })
    : [];
  if (removed.length > 0) {
    await appendEvent(tx, member, { companyId: id }, "domain_removed", { domain });
  }
  return { status: "ok", domains: await domainsOf(tx, id) };
};
