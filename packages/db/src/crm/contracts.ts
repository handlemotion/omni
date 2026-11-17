// Contracts on a deal or a company (ADR 0036 decision 6): a title, a status, three dates and one
// file. The status rules are `changeContract`; marking a contract signed locks its file through
// Storage's member door opened on this transaction (ADR 0035 decision 4), so the two land
// together or not at all. Storage tables are never read here: a document is checked and locked
// only through the door.
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { crmContracts } from "../schema/crm.ts";
import { memberStorage } from "../storage.ts";
import {
  CONTRACT_SIGNED,
  changeContract,
  wasSigned,
  type ContractSigned,
  type ContractStatus,
  type InvalidContract,
  type InvalidTransition,
} from "./contract-status.ts";
import {
  appendEvent,
  NOT_FOUND,
  pageSize,
  refuse,
  type CrmEventKind,
  type CrmMember,
  type CrmRecordRef,
  type Ex,
  type NotFound,
} from "./core.ts";
import type { CrmTimelineCursor } from "./notes.ts";
import { cleanName, loadCompany, loadDeal } from "./records.ts";

export interface CrmContract {
  id: string;
  companyId: string | null;
  dealId: string | null;
  title: string;
  status: ContractStatus;
  /** A file in Shared; null when none was attached, or its draft file was purged from Trash. */
  documentNodeId: string | null;
  signedAt: Date | null;
  /** `YYYY-MM-DD`. */
  effectiveOn: string | null;
  expiresOn: string | null;
  createdByMemberId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContractInput {
  title: string;
  companyId?: string | null;
  /** Without `companyId`, the contract is also on the deal's company. */
  dealId?: string | null;
  documentNodeId?: string | null;
  effectiveOn?: string | null;
  expiresOn?: string | null;
}

export interface ContractPatch {
  title?: string;
  status?: ContractStatus;
  documentNodeId?: string | null;
  signedAt?: Date;
  effectiveOn?: string | null;
  expiresOn?: string | null;
}

export type ContractResult =
  | { status: "ok"; contract: CrmContract }
  | NotFound
  | ContractSigned
  | InvalidTransition
  | InvalidContract;

export type ListContractsInput = ({ companyId: string } | { dealId: string }) & {
  cursor?: CrmTimelineCursor | null;
  limit?: number;
};

export type ContractListResult =
  | { status: "ok"; contracts: CrmContract[]; nextCursor: CrmTimelineCursor | null }
  | NotFound;

const contractColumns = {
  id: crmContracts.id,
  companyId: crmContracts.companyId,
  dealId: crmContracts.dealId,
  title: crmContracts.title,
  status: crmContracts.status,
  documentNodeId: crmContracts.documentNodeId,
  signedAt: crmContracts.signedAt,
  effectiveOn: crmContracts.effectiveOn,
  expiresOn: crmContracts.expiresOn,
  createdByMemberId: crmContracts.createdByMemberId,
  createdAt: crmContracts.createdAt,
  updatedAt: crmContracts.updatedAt,
};

const invalid = (param: string) =>
  ({ status: "invalid_contract", param }) satisfies InvalidContract;

/** A calendar day as Postgres's `date` takes it, or false. */
const isDay = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/** Why the dates cannot be stored, or null. */
function datesRefusal(effectiveOn: string | null, expiresOn: string | null) {
  if (effectiveOn !== null && !isDay(effectiveOn)) return invalid("effectiveOn");
  if (expiresOn !== null && !isDay(expiresOn)) return invalid("expiresOn");
  if (effectiveOn && expiresOn && expiresOn < effectiveOn) return invalid("expiresOn");
  return null;
}

/** A live file in Shared the member reaches through Storage's door. */
async function usableDocument(tx: Ex, member: CrmMember, nodeId: string) {
  const found = await memberStorage(tx as Db, member.id).node(nodeId);
  return Boolean(
    found && found.node.kind === "file" && found.node.space === "shared" && !found.node.trashedAt,
  );
}

/** The record a contract's events are written on: its deal, else its company. */
const eventRecord = (contract: { dealId: string | null; companyId: string | null }) => {
  const result: CrmRecordRef = contract.dealId
    ? { dealId: contract.dealId }
    : { companyId: contract.companyId! };
  return result;
};

async function contractEvent(
  tx: Ex,
  member: CrmMember,
  contract: CrmContract,
  kind: CrmEventKind,
  data: Record<string, unknown> = {},
) {
  await appendEvent(tx, member, eventRecord(contract), kind, {
    contractId: contract.id,
    title: contract.title,
    status: contract.status,
    ...data,
  });
}

async function loadContract(ex: Ex, orgId: string, id: string, lock = false) {
  const query = ex
    .select(contractColumns)
    .from(crmContracts)
    .where(and(eq(crmContracts.orgId, orgId), eq(crmContracts.id, id)));
  const [row] = lock ? await query.for("update") : await query;
  return row ?? null;
}

/**
 * Locks the records a contract is on, company then deal, always in that order. Signing, creating
 * and a record's delete for good all take these first, so a contract cannot be made or signed
 * between a delete's check for signed contracts and its cascade. False when one is gone.
 */
export async function lockRecords(
  tx: Ex,
  orgId: string,
  records: { companyId: string | null; dealId: string | null },
) {
  if (records.companyId && !(await loadCompany(tx, orgId, records.companyId, true))) return false;
  if (records.dealId && !(await loadDeal(tx, orgId, records.dealId, true))) return false;
  return true;
}

/** The record's contracts, newest first. A company's include those on its deals. */
export const listContracts: (
  ex: Ex,
  member: CrmMember,
  input: ListContractsInput,
) => Promise<ContractListResult> = async (ex, member, input) => {
  const record =
    "dealId" in input
      ? await loadDeal(ex, member.orgId, input.dealId)
      : await loadCompany(ex, member.orgId, input.companyId);
  if (!record) return NOT_FOUND;
  const limit = pageSize(input.limit);
  const column =
    "dealId" in input
      ? eq(crmContracts.dealId, input.dealId)
      : eq(crmContracts.companyId, input.companyId);
  const older = input.cursor
    ? sql`(${crmContracts.createdAt}, ${crmContracts.id}) < (${input.cursor.createdAt.toISOString()}::timestamptz, ${input.cursor.id})`
    : undefined;
  const rows = await ex
    .select(contractColumns)
    .from(crmContracts)
    .where(and(eq(crmContracts.orgId, member.orgId), column, older))
    .orderBy(desc(crmContracts.createdAt), desc(crmContracts.id))
    .limit(limit + 1);
  const contracts = rows.slice(0, limit);
  const last = contracts.at(-1);
  return {
    status: "ok",
    contracts,
    nextCursor: rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null,
  };
};

/** The company and deal a new contract is on, or why not. */
async function recordsOf(tx: Ex, member: CrmMember, input: ContractInput) {
  let companyId = input.companyId ?? null;
  const dealId = input.dealId ?? null;
  if (dealId) {
    const deal = await loadDeal(tx, member.orgId, dealId);
    if (!deal) return NOT_FOUND;
    companyId ??= deal.companyId;
  }
  if (!companyId && !dealId) return invalid("dealId");
  if (!(await lockRecords(tx, member.orgId, { companyId, dealId }))) return NOT_FOUND;
  return { status: "ok" as const, companyId, dealId };
}

/** A draft on a deal or a company. */
export const createContract: (
  tx: Ex,
  member: CrmMember,
  input: ContractInput,
) => Promise<ContractResult> = async (tx, member, input) => {
  const title = cleanName(input.title);
  if (!title) return invalid("title");
  const effectiveOn = input.effectiveOn ?? null;
  const expiresOn = input.expiresOn ?? null;
  const dates = datesRefusal(effectiveOn, expiresOn);
  if (dates) return dates;
  const on = await recordsOf(tx, member, input);
  if (on.status !== "ok") return on;
  const documentNodeId = input.documentNodeId ?? null;
  if (documentNodeId && !(await usableDocument(tx, member, documentNodeId))) {
    return invalid("documentNodeId");
  }
  const [contract] = await tx
    .insert(crmContracts)
    .values({
      orgId: member.orgId,
      companyId: on.companyId,
      dealId: on.dealId,
      title,
      documentNodeId,
      effectiveOn,
      expiresOn,
      createdByMemberId: member.id,
    })
    .returning(contractColumns);
  await contractEvent(tx, member, contract!, "contract_created", { documentNodeId });
  return { status: "ok", contract: contract! };
};

/** The title and dates a patch leaves, or why not. */
function fieldsOf(current: CrmContract, patch: ContractPatch) {
  const title = patch.title === undefined ? current.title : cleanName(patch.title);
  if (!title) return invalid("title");
  const effectiveOn = patch.effectiveOn === undefined ? current.effectiveOn : patch.effectiveOn;
  const expiresOn = patch.expiresOn === undefined ? current.expiresOn : patch.expiresOn;
  return (
    datesRefusal(effectiveOn, expiresOn) ?? { status: "ok" as const, title, effectiveOn, expiresOn }
  );
}

/**
 * Changes title, dates, status or document. Marking it signed locks its file in this
 * transaction; when Storage refuses the lock, the whole change rolls back.
 */
export const updateContract: (
  tx: Ex,
  member: CrmMember,
  id: string,
  patch: ContractPatch,
) => Promise<ContractResult> = async (tx, member, id, patch) => {
  // Its records first, then the contract, in the order a delete for good takes them.
  const seen = await loadContract(tx, member.orgId, id);
  if (!seen || !(await lockRecords(tx, member.orgId, seen))) return NOT_FOUND;
  const current = await loadContract(tx, member.orgId, id, true);
  if (!current) return NOT_FOUND;
  const fields = fieldsOf(current, patch);
  if (fields.status !== "ok") return fields;
  const move = changeContract(current, patch, new Date());
  if (move.status !== "ok") return move;
  const { state } = move;
  if (move.documentChanged && state.documentNodeId) {
    if (!(await usableDocument(tx, member, state.documentNodeId))) return invalid("documentNodeId");
  }
  const [contract] = await tx
    .update(crmContracts)
    .set({
      ...state,
      title: fields.title,
      effectiveOn: fields.effectiveOn,
      expiresOn: fields.expiresOn,
    })
    .where(eq(crmContracts.id, id))
    .returning(contractColumns);
  if (move.lock) {
    const locked = await memberStorage(tx as Db, member.id).lock(move.lock);
    // Gone, in Trash, out of reach, a folder, or moved out of Shared since it was attached (the
    // node is read under Storage's tree lock, so no move lands between): nothing is kept.
    if (locked.status !== "ok" || locked.node.space !== "shared") {
      refuse(invalid("documentNodeId"));
    }
  }
  if (move.documentChanged) {
    await contractEvent(tx, member, contract!, "contract_document_changed", {
      from: current.documentNodeId,
      to: state.documentNodeId,
    });
  }
  if (move.statusChanged) {
    await contractEvent(tx, member, contract!, "contract_status_changed", {
      from: current.status,
      to: state.status,
    });
  }
  return { status: "ok", contract: contract! };
};

/** Deletes a contract that was never signed. */
export const deleteContract: (
  tx: Ex,
  member: CrmMember,
  id: string,
) => Promise<{ status: "ok" } | NotFound | ContractSigned> = async (tx, member, id) => {
  const current = await loadContract(tx, member.orgId, id, true);
  if (!current) return NOT_FOUND;
  if (wasSigned(current.status)) return CONTRACT_SIGNED;
  await tx.delete(crmContracts).where(eq(crmContracts.id, id));
  await contractEvent(tx, member, current, "contract_deleted");
  return { status: "ok" };
};

/**
 * Whether the record holds a signed (or ended) contract, which outlives it: deleting the record
 * for good would cascade to it. The record's row is locked first, as signing and creating a
 * contract lock it (`lockRecords`), so a contract made or signed meanwhile is seen here or waits
 * for the delete; its contracts stay locked until the transaction ends.
 */
export async function holdsSignedContract(
  tx: Ex,
  orgId: string,
  record: { companyId: string } | { dealId: string },
) {
  await lockRecords(
    tx,
    orgId,
    "dealId" in record
      ? { companyId: null, dealId: record.dealId }
      : { companyId: record.companyId, dealId: null },
  );
  const column =
    "dealId" in record
      ? eq(crmContracts.dealId, record.dealId)
      : eq(crmContracts.companyId, record.companyId);
  const rows = await tx
    .select({ status: crmContracts.status })
    .from(crmContracts)
    .where(and(eq(crmContracts.orgId, orgId), column))
    .for("update");
  return rows.some((row) => wasSigned(row.status));
}
