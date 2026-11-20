import { archiveCompany, deleteCompany, restoreCompany, updateCompany } from "./companies.ts";
import { writeAsMember, type CrmDoor, type CrmMember, type Ex } from "./core.ts";
import { archiveDeal, deleteDeal, restoreDeal, updateDeal } from "./deals.ts";
import { archivePerson, deletePerson, restorePerson, updatePerson } from "./people.ts";

export const BULK_MAX = 200;

export type CrmBulkRecords = "companies" | "people" | "deals";

/** One action for many records. `stage` is for deals. */
export type CrmBulkAction =
  | { action: "archive" }
  | { action: "restore" }
  | { action: "delete" }
  | { action: "owner"; ownerMemberId: string | null }
  | { action: "stage"; stageId: string };

/** What happened to each id: changed, or refused with the single route's status. */
export interface CrmBulkResult {
  status: "ok";
  done: string[];
  refused: { id: string; status: string }[];
}

type Run = (tx: Ex, member: CrmMember, id: string) => Promise<{ status: string }>;

const RUNS: Record<CrmBulkRecords, (action: CrmBulkAction) => Run | null> = {
  companies: (a) => {
    switch (a.action) {
      case "archive":
        return archiveCompany;
      case "restore":
        return restoreCompany;
      case "delete":
        return deleteCompany;
      case "owner":
        return (tx, m, id) => updateCompany(tx, m, id, { ownerMemberId: a.ownerMemberId });
      case "stage":
        return null;
    }
  },
  people: (a) => {
    switch (a.action) {
      case "archive":
        return archivePerson;
      case "restore":
        return restorePerson;
      case "delete":
        return deletePerson;
      case "owner":
        return (tx, m, id) => updatePerson(tx, m, id, { ownerMemberId: a.ownerMemberId });
      case "stage":
        return null;
    }
  },
  deals: (a) => {
    switch (a.action) {
      case "archive":
        return archiveDeal;
      case "restore":
        return restoreDeal;
      case "delete":
        return deleteDeal;
      case "owner":
        return (tx, m, id) => updateDeal(tx, m, id, { ownerMemberId: a.ownerMemberId });
      case "stage":
        return (tx, m, id) => updateDeal(tx, m, id, { stageId: a.stageId });
    }
  },
};

/**
 * Runs one action on up to `BULK_MAX` records, each through the same door function as its single
 * route and in its own transaction, so every rule holds per record and one refusal never undoes
 * the others. `invalid_action`: the action does not apply to these records.
 */
export async function bulkCrm(
  door: CrmDoor,
  records: CrmBulkRecords,
  ids: string[],
  action: CrmBulkAction,
) {
  const run = RUNS[records](action);
  if (!run) return { status: "invalid_action" as const };
  const result: CrmBulkResult = { status: "ok", done: [], refused: [] };
  for (const id of [...new Set(ids)].slice(0, BULK_MAX)) {
    const answer = await writeAsMember(door, (m, tx) => run(tx, m, id));
    if (answer.status === "no_crm") return { status: "no_crm" as const };
    if (answer.status === "ok") result.done.push(id);
    else result.refused.push({ id, status: answer.status });
  }
  return result;
}
