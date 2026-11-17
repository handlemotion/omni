// Contracts end on their own (ADR 0039 decision 4): a signed contract whose `expires_on` is
// before today (UTC) is marked `ended` through `changeContract`, with one
// `contract_status_changed` event keyed `contract_ended:<id>`. System work for the CRM's daily
// job, not a member door: there is no actor, and every workspace is swept.
import { and, asc, eq, lt } from "drizzle-orm";
import type { Db } from "../client.ts";
import { members } from "../schema/auth.ts";
import { crmContracts, crmEvents } from "../schema/crm.ts";
import { changeContract } from "./contract-status.ts";
import { lockRecords } from "./contracts.ts";
import type { Ex } from "./core.ts";

/** Contracts one call looks at; the job calls again while `more`. */
export const CONTRACT_EXPIRY_BATCH = 100;

export interface EndedContract {
  orgId: string;
  contractId: string;
}

/** The UTC calendar day of `now`, as Postgres's `date` takes it. */
const dayOf = (now: Date) => now.toISOString().slice(0, 10);

/**
 * Ends one contract in its own short transaction, taking its records then the contract in the
 * order a change or a delete for good takes them. Null when it changed meanwhile (ended by a
 * member, its dates moved, its record deleted) or a concurrent run ended it first.
 */
async function endOne(db: Db, candidate: { id: string; orgId: string }, today: string, now: Date) {
  return db.transaction(async (tx) => {
    const [seen] = await tx
      .select({ companyId: crmContracts.companyId, dealId: crmContracts.dealId })
      .from(crmContracts)
      .where(eq(crmContracts.id, candidate.id));
    if (!seen || !(await lockRecords(tx, candidate.orgId, seen))) return null;
    const [current] = await tx
      .select()
      .from(crmContracts)
      .where(eq(crmContracts.id, candidate.id))
      .for("update");
    if (!current || current.status !== "signed" || !current.expiresOn) return null;
    if (current.expiresOn >= today) return null;
    const move = changeContract(current, { status: "ended" }, now);
    if (move.status !== "ok" || !move.statusChanged) return null;
    await tx
      .update(crmContracts)
      .set({ status: move.state.status })
      .where(eq(crmContracts.id, current.id));
    await appendEndedEvent(tx, current);
    return { orgId: current.orgId, contractId: current.id };
  });
}

async function appendEndedEvent(tx: Ex, contract: typeof crmContracts.$inferSelect) {
  // On the deal when there is one, else the company, as a member's change writes it.
  const record = contract.dealId ? { dealId: contract.dealId } : { companyId: contract.companyId };
  await tx.insert(crmEvents).values({
    orgId: contract.orgId,
    ...record,
    kind: "contract_status_changed",
    actorMemberId: null,
    data: {
      contractId: contract.id,
      title: contract.title,
      status: "ended",
      from: "signed",
      to: "ended",
    },
    dedupeKey: `contract_ended:${contract.id}`,
  });
}

/**
 * Ends up to `limit` expired signed contracts, oldest expiry first. Safe to run twice: a second
 * run finds them `ended` and writes nothing. `now` is for tests.
 */
export const endExpiredContracts: (
  db: Db,
  input?: { now?: Date; limit?: number },
) => Promise<{ ended: EndedContract[]; more: boolean }> = async (db, input = {}) => {
  const now = input.now ?? new Date();
  const today = dayOf(now);
  const limit = input.limit ?? CONTRACT_EXPIRY_BATCH;
  const candidates = await db
    .select({ id: crmContracts.id, orgId: crmContracts.orgId })
    .from(crmContracts)
    .where(and(eq(crmContracts.status, "signed"), lt(crmContracts.expiresOn, today)))
    .orderBy(asc(crmContracts.expiresOn), asc(crmContracts.id))
    .limit(limit);
  const ended: EndedContract[] = [];
  for (const candidate of candidates) {
    const done = await endOne(db, candidate, today, now);
    if (done) ended.push(done);
  }
  return { ended, more: candidates.length === limit };
};

/** Who hears a CRM change in `orgId`: its members now (as `crmAudience` for a member's change). */
export async function crmMembersOf(db: Db, orgId: string) {
  const rows = await db
    .select({ id: members.id })
    .from(members)
    .where(eq(members.organizationId, orgId));
  return rows.map((row) => row.id) satisfies string[];
}
