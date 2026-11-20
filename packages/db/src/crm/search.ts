import { domainOf, isWebmailDomain, parseAddress } from "@omni/mail-core/addresses";
import { and, asc, eq, inArray, isNull, or, sql, type AnyColumn } from "drizzle-orm";
import {
  crmCompanies,
  crmCompanyDomains,
  crmDealPeople,
  crmDeals,
  crmPeople,
  crmPersonEmails,
  crmStages,
} from "../schema/crm.ts";
import { likePrefix, projectsOnly, wordsOf, type CrmMember, type Ex } from "./core.ts";
import {
  companyColumns,
  dealColumns,
  personColumns,
  withAddresses,
  type CrmCompany,
  type CrmDeal,
  type CrmPerson,
} from "./records.ts";

export const SEARCH_LIMIT = 20;
export const LOOKUP_MAX_ADDRESSES = 50;

export interface CrmSearchResult {
  status: "ok";
  people: CrmPerson[];
  companies: CrmCompany[];
  deals: CrmDeal[];
}

const nameStarts = (name: AnyColumn, word: string) =>
  sql`(lower(${name}) like ${likePrefix(word)} or lower(${name}) like ${`% ${likePrefix(word)}`})`;

const anyAddressStarts = (word: string) =>
  sql`exists (select 1 from ${crmPersonEmails} where ${crmPersonEmails.personId} = ${crmPeople.id} and ${crmPersonEmails.address} like ${likePrefix(word)})`;

const anyDomainStarts = (word: string) =>
  sql`exists (select 1 from ${crmCompanyDomains} where ${crmCompanyDomains.companyId} = ${crmCompanies.id} and ${crmCompanyDomains.domain} like ${likePrefix(word)})`;

/**
 * People, companies and deals where every word starts the name, one of its words, an address
 * (people) or a domain (companies). Up to `limit` of each, by name.
 */
export const searchCrm: (
  ex: Ex,
  member: CrmMember,
  input: { q: string; limit?: number },
) => Promise<CrmSearchResult> = async (ex, member, input) => {
  const words = wordsOf(input.q);
  if (words.length === 0) return { status: "ok", people: [], companies: [], deals: [] };
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? SEARCH_LIMIT), 1), 50);
  const people = await ex
    .select(personColumns)
    .from(crmPeople)
    .where(
      and(
        eq(crmPeople.orgId, member.orgId),
        isNull(crmPeople.archivedAt),
        ...words.map((word) => or(nameStarts(crmPeople.name, word), anyAddressStarts(word))),
      ),
    )
    .orderBy(sql`lower(${crmPeople.name})`, asc(crmPeople.id))
    .limit(limit);
  const companies = await ex
    .select(companyColumns)
    .from(crmCompanies)
    .where(
      and(
        eq(crmCompanies.orgId, member.orgId),
        isNull(crmCompanies.archivedAt),
        ...words.map((word) => or(nameStarts(crmCompanies.name, word), anyDomainStarts(word))),
      ),
    )
    .orderBy(sql`lower(${crmCompanies.name})`, asc(crmCompanies.id))
    .limit(limit);
  const deals = await ex
    .select(dealColumns)
    .from(crmDeals)
    .innerJoin(crmStages, eq(crmStages.id, crmDeals.stageId))
    .where(
      and(
        eq(crmDeals.orgId, member.orgId),
        projectsOnly(crmDeals.id, member),
        isNull(crmDeals.archivedAt),
        ...words.map((word) => nameStarts(crmDeals.name, word)),
      ),
    )
    .orderBy(sql`lower(${crmDeals.name})`, asc(crmDeals.id))
    .limit(limit);
  return { status: "ok", people: await withAddresses(ex, people), companies, deals };
};

export interface CrmLookupResult {
  status: "ok";
  /** People holding one of the addresses. */
  people: CrmPerson[];
  /** Those people's companies, and companies holding one of the addresses' domains. */
  companies: CrmCompany[];
  /** Live deals (stage kind `open` or `won`) of those people or those companies. */
  deals: CrmDeal[];
}

/**
 * What the CRM knows about a thread's addresses, for the conversation sidebar. Up to
 * `LOOKUP_MAX_ADDRESSES` addresses in any letter case; the rest are ignored. A won deal is the
 * running project, so it is shown beside the open ones; delivered and lost deals are not.
 */
export const lookupCrm: (
  ex: Ex,
  member: CrmMember,
  input: { addresses: string[] },
) => Promise<CrmLookupResult> = async (ex, member, input) => {
  const addresses = [
    ...new Set(input.addresses.map((raw) => parseAddress(raw)).filter((a) => a !== null)),
  ].slice(0, LOOKUP_MAX_ADDRESSES);
  if (addresses.length === 0) return { status: "ok", people: [], companies: [], deals: [] };
  const domains = [...new Set(addresses.flatMap((a) => domainOf(a) ?? []))].filter(
    (d) => !isWebmailDomain(d),
  );

  const people = await ex
    .selectDistinct(personColumns)
    .from(crmPersonEmails)
    .innerJoin(crmPeople, eq(crmPeople.id, crmPersonEmails.personId))
    .where(
      and(
        eq(crmPersonEmails.orgId, member.orgId),
        inArray(crmPersonEmails.address, addresses),
        isNull(crmPeople.archivedAt),
      ),
    )
    .orderBy(asc(crmPeople.name), asc(crmPeople.id));
  const personIds = people.map((person) => person.id);
  const fromPeople = people.flatMap((person) => (person.companyId ? [person.companyId] : []));
  const byDomain =
    domains.length > 0
      ? await ex
          .select({ companyId: crmCompanyDomains.companyId })
          .from(crmCompanyDomains)
          .where(
            and(
              eq(crmCompanyDomains.orgId, member.orgId),
              inArray(crmCompanyDomains.domain, domains),
            ),
          )
      : [];
  const companyIds = [...new Set([...fromPeople, ...byDomain.map((row) => row.companyId)])];
  const companies =
    companyIds.length > 0
      ? await ex
          .select(companyColumns)
          .from(crmCompanies)
          .where(
            and(
              eq(crmCompanies.orgId, member.orgId),
              inArray(crmCompanies.id, companyIds),
              isNull(crmCompanies.archivedAt),
            ),
          )
          .orderBy(asc(crmCompanies.name), asc(crmCompanies.id))
      : [];
  const linked = [
    personIds.length > 0
      ? inArray(
          crmDeals.id,
          ex
            .select({ id: crmDealPeople.dealId })
            .from(crmDealPeople)
            .where(inArray(crmDealPeople.personId, personIds)),
        )
      : undefined,
    companies.length > 0
      ? inArray(
          crmDeals.companyId,
          companies.map((company) => company.id),
        )
      : undefined,
  ].filter((condition) => condition !== undefined);
  const deals =
    linked.length > 0
      ? await ex
          .select(dealColumns)
          .from(crmDeals)
          .innerJoin(crmStages, eq(crmStages.id, crmDeals.stageId))
          .where(
            and(
              eq(crmDeals.orgId, member.orgId),
              projectsOnly(crmDeals.id, member),
              isNull(crmDeals.archivedAt),
              inArray(crmStages.kind, ["open", "won"]),
              or(...linked),
            ),
          )
          .orderBy(asc(crmDeals.name), asc(crmDeals.id))
      : [];
  return { status: "ok", people: await withAddresses(ex, people), companies, deals };
};
