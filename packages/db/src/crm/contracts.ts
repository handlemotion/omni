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
  fileContract,
  involves,
  setPeople,
  shareContract,
  withPeople,
  type InvalidPeople,
} from "./contract-people.ts";
import { withSigning, type CrmContractSigning } from "./contract-progress.ts";
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
  /**
   * A file in the workspace's drives, wherever it lives; null when none was attached, or its draft
   * file was purged from Trash.
   */
  documentNodeId: string | null;
  signedAt: Date | null;
  /** The Storage signature request it went out with from Omni; null when sent by hand. */
  signatureRequestId: string | null;
  /** The signed copy: sealed by Omni with its certificate, or uploaded when signed elsewhere. */
  signedNodeId: string | null;
  /** Who signed, entered by hand when it was signed elsewhere; null otherwise. */
  signedBy: ContractSignedBy[] | null;
  /** `YYYY-MM-DD`. */
  effectiveOn: string | null;
  expiresOn: string | null;
  createdByMemberId: string | null;
  createdAt: Date;
  updatedAt: Date;
  signing: CrmContractSigning | null;
  /** Who on the workspace it involves; a freelancer sees only contracts that involve them. */
  memberIds: string[];
}

/** One signer of a contract signed outside Omni, as a member entered them. */
export interface ContractSignedBy {
  name: string;
  email: string | null;
}

/** A contract row, before its signing progress is read from Storage. */
export type CrmContractRow = Omit<CrmContract, "signing" | "memberIds">;

/** Out for signature from Omni: void the request instead of changing it by hand. */
export type SignatureOpen = { status: "signature_open" };

export interface ContractInput {
  title: string;
  companyId?: string | null;
  /** Without `companyId`, the contract is also on the deal's company. */
  dealId?: string | null;
  documentNodeId?: string | null;
  effectiveOn?: string | null;
  expiresOn?: string | null;
  /** Members of the workspace it involves. */
  memberIds?: string[];
}

export interface ContractPatch {
  title?: string;
  status?: ContractStatus;
  documentNodeId?: string | null;
  signedAt?: Date;
  effectiveOn?: string | null;
  expiresOn?: string | null;
  /** Replaces who it involves. */
  memberIds?: string[];
}

export type ContractResult =
  | { status: "ok"; contract: CrmContract }
  | NotFound
  | ContractSigned
  | InvalidTransition
  | InvalidContract
  | InvalidPeople
  | SignatureOpen;

export type ListContractsInput = ({ companyId: string } | { dealId: string }) & {
  cursor?: CrmTimelineCursor | null;
  limit?: number;
  /** Only those involving this member. */
  involving?: string;
};

export type ContractListResult =
  | { status: "ok"; contracts: CrmContract[]; nextCursor: CrmTimelineCursor | null }
  | NotFound;

export const contractColumns = {
  id: crmContracts.id,
  companyId: crmContracts.companyId,
  dealId: crmContracts.dealId,
  title: crmContracts.title,
  status: crmContracts.status,
  documentNodeId: crmContracts.documentNodeId,
  signedAt: crmContracts.signedAt,
  signatureRequestId: crmContracts.signatureRequestId,
  signedNodeId: crmContracts.signedNodeId,
  signedBy: crmContracts.signedBy,
  effectiveOn: crmContracts.effectiveOn,
  expiresOn: crmContracts.expiresOn,
  createdByMemberId: crmContracts.createdByMemberId,
  createdAt: crmContracts.createdAt,
  updatedAt: crmContracts.updatedAt,
};

const invalid = (param: string) =>
  ({ status: "invalid_contract", param }) satisfies InvalidContract;

const isDay = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

function datesRefusal(effectiveOn: string | null, expiresOn: string | null) {
  if (effectiveOn !== null && !isDay(effectiveOn)) return invalid("effectiveOn");
  if (expiresOn !== null && !isDay(expiresOn)) return invalid("expiresOn");
  if (effectiveOn && expiresOn && expiresOn < effectiveOn) return invalid("expiresOn");
  return null;
}

/**
 * The team's, not someone's own: a file in one of the workspace's drives, wherever it sits there,
 * never in a member's My files (`docs/spec/contracts.md`, "In the CRM").
 */
export const teamDrive = (node: { space: string }) => node.space !== "personal";

/** A file the member opens in one of the workspace's drives, out of Trash. */
export async function usableDocument(tx: Ex, member: CrmMember, nodeId: string) {
  const found = await memberStorage(tx as Db, member.id).node(nodeId);
  return Boolean(
    found && found.node.kind === "file" && teamDrive(found.node) && !found.node.trashedAt,
  );
}

const eventRecord = (contract: { dealId: string | null; companyId: string | null }) => {
  const result: CrmRecordRef = contract.dealId
    ? { dealId: contract.dealId }
    : { companyId: contract.companyId! };
  return result;
};

/** Contracts as callers see them, with signing progress and the people they involve. */
export async function asContracts(ex: Ex, orgId: string, rows: CrmContractRow[]) {
  return (await withPeople(ex, await withSigning(ex, orgId, rows))) satisfies CrmContract[];
}

/** The contract as callers see it, with its signing progress. */
export async function withProgress(ex: Ex, orgId: string, row: CrmContractRow) {
  const [contract] = await asContracts(ex, orgId, [row]);
  return contract! satisfies CrmContract;
}

export async function contractEvent(
  tx: Ex,
  member: CrmMember,
  contract: CrmContractRow,
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

export async function loadContract(ex: Ex, orgId: string, id: string, lock = false) {
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
    .where(
      and(
        eq(crmContracts.orgId, member.orgId),
        column,
        older,
        input.involving ? involves(crmContracts.id, input.involving) : undefined,
      ),
    )
    .orderBy(desc(crmContracts.createdAt), desc(crmContracts.id))
    .limit(limit + 1);
  const contracts = await asContracts(ex, member.orgId, rows.slice(0, limit));
  const last = contracts.at(-1);
  return {
    status: "ok",
    contracts,
    nextCursor: rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null,
  };
};

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
  const people = await setPeople(tx, member, contract!.id, input.memberIds ?? []);
  if (people.status !== "ok") refuse(people);
  await fileContract(tx, member, contract!);
  await shareContract(tx, member, contract!);
  await contractEvent(tx, member, contract!, "contract_created", { documentNodeId });
  return { status: "ok", contract: await withProgress(tx, member.orgId, contract!) };
};

function fieldsOf(current: CrmContractRow, patch: ContractPatch) {
  const title = patch.title === undefined ? current.title : cleanName(patch.title);
  if (!title) return invalid("title");
  const effectiveOn = patch.effectiveOn === undefined ? current.effectiveOn : patch.effectiveOn;
  const expiresOn = patch.expiresOn === undefined ? current.expiresOn : patch.expiresOn;
  return (
    datesRefusal(effectiveOn, expiresOn) ?? { status: "ok" as const, title, effectiveOn, expiresOn }
  );
}

async function involveAndFile(
  tx: Ex,
  member: CrmMember,
  before: CrmContractRow,
  after: CrmContractRow,
  memberIds: string[] | undefined,
) {
  const people = memberIds === undefined ? null : await setPeople(tx, member, after.id, memberIds);
  if (people && people.status !== "ok") refuse(people);
  await fileContract(tx, member, after);
  const oldFiles = [before.documentNodeId, before.signedNodeId].filter((n) => n !== null);
  await shareContract(tx, member, after, { gone: people?.gone, oldFiles });
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
  const seen = await loadContract(tx, member.orgId, id);
  if (!seen || !(await lockRecords(tx, member.orgId, seen))) return NOT_FOUND;
  const current = await loadContract(tx, member.orgId, id, true);
  if (!current) return NOT_FOUND;
  const fields = fieldsOf(current, patch);
  if (fields.status !== "ok") return fields;
  const outForSignature = current.status === "sent" && current.signatureRequestId;
  if (outForSignature && patch.status !== undefined && patch.status !== "sent") {
    return { status: "signature_open" };
  }
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
  await involveAndFile(tx, member, current, contract!, patch.memberIds);
  if (move.lock) {
    const locked = await memberStorage(tx as Db, member.id).lock(move.lock);
    if (locked.status !== "ok" || !teamDrive(locked.node)) {
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
  return { status: "ok", contract: await withProgress(tx, member.orgId, contract!) };
};

/** Deletes a contract that was never signed. */
export const deleteContract: (
  tx: Ex,
  member: CrmMember,
  id: string,
) => Promise<{ status: "ok" } | NotFound | ContractSigned | SignatureOpen> = async (
  tx,
  member,
  id,
) => {
  const current = await loadContract(tx, member.orgId, id, true);
  if (!current) return NOT_FOUND;
  if (wasSigned(current.status)) return CONTRACT_SIGNED;
  if (current.status === "sent" && current.signatureRequestId) return { status: "signature_open" };
  await tx.delete(crmContracts).where(eq(crmContracts.id, id));
  await contractEvent(tx, member, current, "contract_deleted");
  return { status: "ok" };
};

/**
 * Whether the record holds a signed (or ended) contract, or one out for signature, which outlives
 * it: deleting the record for good would cascade to it. The record's row is locked first, as signing and creating a
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
    .select({ status: crmContracts.status, requestId: crmContracts.signatureRequestId })
    .from(crmContracts)
    .where(and(eq(crmContracts.orgId, orgId), column))
    .for("update");
  return rows.some((row) => wasSigned(row.status) || (row.status === "sent" && row.requestId));
}
