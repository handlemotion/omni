// The record shapes the door answers with, and the loaders every operation shares. Every loader
// takes the member's org and finds nothing outside it.
import { parseAddress } from "@omni/mail-core/addresses";
import { and, asc, eq, inArray, isNull, sql, type AnyColumn } from "drizzle-orm";
import {
  crmCompanies,
  crmCompanyDomains,
  crmDealPeople,
  crmDeals,
  crmPeople,
  crmPersonEmails,
  crmStages,
} from "../schema/crm.ts";
import type { Ex } from "./core.ts";
import type { StageKind } from "./stage-transition.ts";

export interface CrmCompany {
  id: string;
  name: string;
  description: string | null;
  folderNodeId: string | null;
  createdByMemberId: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CrmPersonAddress {
  address: string;
  isPrimary: boolean;
}

export interface CrmPerson {
  id: string;
  name: string;
  companyId: string | null;
  jobTitle: string | null;
  phone: string | null;
  createdByMemberId: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** Primary first, then by address. */
  addresses: CrmPersonAddress[];
}

export interface CrmDeal {
  id: string;
  name: string;
  companyId: string | null;
  stageId: string;
  /** The kind of the stage it is in. */
  stageKind: StageKind;
  stageEnteredAt: Date;
  ownerMemberId: string | null;
  valueMinor: number | null;
  valueCurrency: string | null;
  wonAt: Date | null;
  closedAt: Date | null;
  folderNodeId: string | null;
  createdByMemberId: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const companyColumns = {
  id: crmCompanies.id,
  name: crmCompanies.name,
  description: crmCompanies.description,
  folderNodeId: crmCompanies.folderNodeId,
  createdByMemberId: crmCompanies.createdByMemberId,
  archivedAt: crmCompanies.archivedAt,
  createdAt: crmCompanies.createdAt,
  updatedAt: crmCompanies.updatedAt,
};

export const personColumns = {
  id: crmPeople.id,
  name: crmPeople.name,
  companyId: crmPeople.companyId,
  jobTitle: crmPeople.jobTitle,
  phone: crmPeople.phone,
  createdByMemberId: crmPeople.createdByMemberId,
  archivedAt: crmPeople.archivedAt,
  createdAt: crmPeople.createdAt,
  updatedAt: crmPeople.updatedAt,
};

/** Select from `crm_deals` inner-joined to `crm_stages`. */
export const dealColumns = {
  id: crmDeals.id,
  name: crmDeals.name,
  companyId: crmDeals.companyId,
  stageId: crmDeals.stageId,
  stageKind: crmStages.kind,
  stageEnteredAt: crmDeals.stageEnteredAt,
  ownerMemberId: crmDeals.ownerMemberId,
  valueMinor: crmDeals.valueMinor,
  valueCurrency: crmDeals.valueCurrency,
  wonAt: crmDeals.wonAt,
  closedAt: crmDeals.closedAt,
  folderNodeId: crmDeals.folderNodeId,
  createdByMemberId: crmDeals.createdByMemberId,
  archivedAt: crmDeals.archivedAt,
  createdAt: crmDeals.createdAt,
  updatedAt: crmDeals.updatedAt,
};

/** Hidden unless asked for: archived rows of `table`. */
export const live = (archivedAt: AnyColumn, includeArchived?: boolean) =>
  includeArchived ? undefined : isNull(archivedAt);

export async function loadCompany(ex: Ex, orgId: string, id: string, lock = false) {
  const query = ex
    .select(companyColumns)
    .from(crmCompanies)
    .where(and(eq(crmCompanies.orgId, orgId), eq(crmCompanies.id, id)));
  const [row] = lock ? await query.for("update") : await query;
  return row ?? null;
}

export async function domainsOf(ex: Ex, companyId: string) {
  const rows = await ex
    .select({ domain: crmCompanyDomains.domain })
    .from(crmCompanyDomains)
    .where(eq(crmCompanyDomains.companyId, companyId))
    .orderBy(asc(crmCompanyDomains.domain));
  return rows.map((row) => row.domain);
}

/** The people's addresses, primary first. */
export async function withAddresses(
  ex: Ex,
  rows: Omit<CrmPerson, "addresses">[],
): Promise<CrmPerson[]> {
  if (rows.length === 0) return [];
  const emails = await ex
    .select({
      personId: crmPersonEmails.personId,
      address: crmPersonEmails.address,
      isPrimary: crmPersonEmails.isPrimary,
    })
    .from(crmPersonEmails)
    .where(
      inArray(
        crmPersonEmails.personId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(sql`${crmPersonEmails.isPrimary} desc`, asc(crmPersonEmails.address));
  return rows.map((row) => ({
    ...row,
    addresses: emails
      .filter((email) => email.personId === row.id)
      .map(({ address, isPrimary }) => ({ address, isPrimary })),
  }));
}

export async function loadPerson(ex: Ex, orgId: string, id: string, lock = false) {
  const query = ex
    .select(personColumns)
    .from(crmPeople)
    .where(and(eq(crmPeople.orgId, orgId), eq(crmPeople.id, id)));
  const [row] = lock ? await query.for("update") : await query;
  return row ? (await withAddresses(ex, [row]))[0]! : null;
}

export async function loadDeal(ex: Ex, orgId: string, id: string, lock = false) {
  if (lock) {
    // Locked on its own first, so the read below sees the row as the last writer left it.
    const locked = await ex
      .select({ id: crmDeals.id })
      .from(crmDeals)
      .where(and(eq(crmDeals.orgId, orgId), eq(crmDeals.id, id)))
      .for("update");
    if (locked.length === 0) return null;
  }
  const [row] = await ex
    .select(dealColumns)
    .from(crmDeals)
    .innerJoin(crmStages, eq(crmStages.id, crmDeals.stageId))
    .where(and(eq(crmDeals.orgId, orgId), eq(crmDeals.id, id)));
  return row ?? null;
}

/** The ids of a deal's people. */
export async function dealPersonIds(ex: Ex, dealId: string) {
  const rows = await ex
    .select({ personId: crmDealPeople.personId })
    .from(crmDealPeople)
    .where(eq(crmDealPeople.dealId, dealId));
  return rows.map((row) => row.personId).toSorted();
}

/** Which of `ids` are people of the workspace. */
export async function existingPeople(ex: Ex, orgId: string, ids: string[]) {
  if (ids.length === 0) return [];
  const rows = await ex
    .select({ id: crmPeople.id })
    .from(crmPeople)
    .where(and(eq(crmPeople.orgId, orgId), inArray(crmPeople.id, ids)));
  return rows.map((row) => row.id);
}

/** A domain as stored (lowercase, no trailing dot), or null when it is not one. */
export function normalizeDomain(input: string): string | null {
  const address = parseAddress(`x@${input.trim().replace(/^@/, "")}`);
  return address ? address.slice(2) : null;
}

/** A name as stored, or null when empty or too long. */
export function cleanName(input: string): string | null {
  const name = input.trim();
  return name.length > 0 && name.length <= 200 ? name : null;
}
