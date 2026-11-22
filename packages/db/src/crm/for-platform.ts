import { sql, type SQL } from "drizzle-orm";
import { crmCompanies, crmDeals, crmPeople } from "../schema/index.ts";

/** A SQL condition: the org whose id is `orgId` has at least one person, company or deal. */
export function orgHoldsCrmRecords(orgId: SQL | string) {
  return sql`(exists (select 1 from ${crmPeople} cp where cp.org_id = ${orgId})
    or exists (select 1 from ${crmCompanies} cc where cc.org_id = ${orgId})
    or exists (select 1 from ${crmDeals} cd where cd.org_id = ${orgId}))`;
}
