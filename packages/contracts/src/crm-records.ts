import { z } from "zod";

/** A company, person or deal, by the one key that names both its kind and its id. */
export type CrmRecordKey = { companyId: string } | { personId: string } | { dealId: string };

/** A body's or query's record ids: a schema lets through at most one of them. */
export type CrmRecordIds = {
  companyId?: string | null;
  personId?: string | null;
  dealId?: string | null;
};

/** How many records `ids` names. */
export const crmRecordsNamed = (ids: CrmRecordIds) =>
  [ids.companyId, ids.personId, ids.dealId].filter(Boolean).length;

/** The record `ids` names, or null for none; a schema has checked it names at most one. */
export function crmRecordKeyOf(ids: CrmRecordIds) {
  let key: CrmRecordKey | null = null;
  if (ids.companyId) key = { companyId: ids.companyId };
  else if (ids.personId) key = { personId: ids.personId };
  else if (ids.dealId) key = { dealId: ids.dealId };
  return key;
}

/** The key of the one record `ids` names; else an issue on `ctx`, so the body is refused. */
export function crmOneRecordKey(ids: CrmRecordIds, ctx: z.RefinementCtx) {
  const key = crmRecordsNamed(ids) === 1 ? crmRecordKeyOf(ids) : null;
  if (key) return key;
  ctx.addIssue({ code: "custom", message: "give exactly one of companyId, personId and dealId" });
  return z.NEVER;
}
