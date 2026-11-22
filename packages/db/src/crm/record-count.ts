import { companyFromAddress, parseAddress } from "@omni/mail-core/addresses";
import { and, count, eq, sql } from "drizzle-orm";
import type { Ex } from "./core.ts";
import {
  crmCompanies,
  crmCompanyDomains,
  crmDeals,
  crmPeople,
  crmPersonEmails,
} from "../schema/crm.ts";

/** People, companies and deals in `orgId`, archived ones included: archiving is not deleting. */
export async function crmRecordCount(db: Pick<Ex, "select">, orgId: string) {
  const counts = await Promise.all(
    [crmPeople, crmCompanies, crmDeals].map(async (table) => {
      const [row] = await db.select({ n: count() }).from(table).where(eq(table.orgId, orgId));
      return row?.n ?? 0;
    }),
  );
  return counts.reduce((a, b) => a + b, 0);
}

/**
 * How many records adding the person at `rawAddress` would create in `orgId`, as `addPerson`
 * would add it: none when the address already has a person, two when no `companyId` is given
 * and no company yet holds the address's domain (the company is made too), else one.
 */
export async function personAddRecords(
  db: Pick<Ex, "select">,
  orgId: string,
  input: { address: string; companyId?: string | null },
) {
  const address = parseAddress(input.address);
  if (!address) return 0;
  const [known] = await db
    .select({ personId: crmPersonEmails.personId })
    .from(crmPersonEmails)
    .where(and(eq(crmPersonEmails.orgId, orgId), eq(crmPersonEmails.address, address)));
  if (known) return 0;
  if (input.companyId !== undefined) return 1;
  const guess = companyFromAddress(address);
  if (!guess.domain || !guess.company) return 1;
  const [held] = await db
    .select({ companyId: crmCompanyDomains.companyId })
    .from(crmCompanyDomains)
    .where(and(eq(crmCompanyDomains.orgId, orgId), eq(crmCompanyDomains.domain, guess.domain)));
  return held ? 1 : 2;
}

/** Adding records would take `orgId` past `max`, its plan's CRM records. */
export class CrmRecordLimitError extends Error {
  override name = "CrmRecordLimitError";
  readonly max: number;
  readonly held: number;
  constructor(max: number, held: number) {
    super(`this workspace's plan holds ${max} CRM records; move to a bigger plan for more`);
    this.max = max;
    this.held = held;
  }
}

/**
 * Inside the transaction that adds `adding` records: waits for any other add in `orgId` to
 * finish, then throws `CrmRecordLimitError` when they would pass `max`. So two adds at once
 * cannot both take the last place. No `max`: nothing to hold.
 */
export async function holdCrmRecords(tx: Ex, orgId: string, max: number | null, adding: number) {
  if (max === null || adding === 0) return;
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`crm-records:${orgId}`}, 0))`,
  );
  const held = await crmRecordCount(tx, orgId);
  if (held + adding > max) throw new CrmRecordLimitError(max, held);
}
