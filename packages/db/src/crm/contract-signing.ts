import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "../client.ts";
import { crmContracts, crmEvents } from "../schema/crm.ts";
import {
  closedSignatureRequestIds,
  storageSignatureRequestsById,
  type StorageSignatureRequest,
} from "../storage.ts";
import { NOT_FOUND, type CrmMember, type Ex, type NotFound } from "./core.ts";
import {
  contractColumns,
  contractEvent,
  loadContract,
  lockRecords,
  withProgress,
  type CrmContract,
  type CrmContractRow,
  type SignatureOpen,
} from "./contracts.ts";
import type { InvalidContract, InvalidTransition } from "./contract-status.ts";

/** Why a contract cannot go out for signature, or come back from it. */
export type SendRefusal = NotFound | InvalidTransition | InvalidContract | SignatureOpen;

export type ContractToSend =
  | { status: "ok"; contract: CrmContractRow; documentNodeId: string }
  | SendRefusal;

/** Only a draft with a document goes out for signature; the caller sends that document. */
export const contractToSend: (
  ex: Ex,
  member: CrmMember,
  id: string,
) => Promise<ContractToSend> = async (ex, member, id) => {
  const contract = await loadContract(ex, member.orgId, id);
  if (!contract) return NOT_FOUND;
  if (contract.status === "sent" && contract.signatureRequestId)
    return { status: "signature_open" };
  if (contract.status !== "draft") {
    return { status: "invalid_transition", from: contract.status, to: "sent" };
  }
  if (!contract.documentNodeId) return { status: "invalid_contract", param: "documentNodeId" };
  return { status: "ok", contract, documentNodeId: contract.documentNodeId };
};

export type SentResult = { status: "ok"; contract: CrmContract } | SendRefusal;

/**
 * Records that the contract went out with Storage's `request` on its document: `sent`, pointing
 * at the request. Refused when the contract changed since `contractToSend` (the caller then
 * voids the request it made).
 */
export const markContractSent: (
  tx: Ex,
  member: CrmMember,
  id: string,
  request: { id: string; nodeId: string; signers: { email: string; name: string }[] },
) => Promise<SentResult> = async (tx, member, id, request) => {
  const seen = await loadContract(tx, member.orgId, id);
  if (!seen || !(await lockRecords(tx, member.orgId, seen))) return NOT_FOUND;
  const current = await loadContract(tx, member.orgId, id, true);
  if (!current) return NOT_FOUND;
  if (current.status !== "draft") {
    return { status: "invalid_transition", from: current.status, to: "sent" };
  }
  if (current.documentNodeId !== request.nodeId) {
    return { status: "invalid_contract", param: "documentNodeId" };
  }
  const [row] = await tx
    .update(crmContracts)
    .set({ status: "sent", signatureRequestId: request.id })
    .where(eq(crmContracts.id, id))
    .returning(contractColumns);
  await contractEvent(tx, member, row!, "contract_status_changed", {
    from: "draft",
    to: "sent",
    signers: request.signers.map(({ email, name }) => ({ email, name })),
  });
  return { status: "ok", contract: await withProgress(tx, member.orgId, row!) };
};

/** The open request of a contract that is out for signature, to void it. */
export const openRequestOf: (
  ex: Ex,
  member: CrmMember,
  id: string,
) => Promise<{ status: "ok"; requestId: string } | NotFound | InvalidTransition> = async (
  ex,
  member,
  id,
) => {
  const contract = await loadContract(ex, member.orgId, id);
  if (!contract) return NOT_FOUND;
  if (contract.status !== "sent" || !contract.signatureRequestId) {
    return { status: "invalid_transition", from: contract.status, to: "draft" };
  }
  return { status: "ok", requestId: contract.signatureRequestId };
};

/**
 * After `requestId` was voided: back to `draft`, so it can be fixed and sent again. A contract
 * already on another request (settled and resent meanwhile) is left as it is.
 */
export const withdrawContract: (
  tx: Ex,
  member: CrmMember,
  id: string,
  requestId: string,
) => Promise<{ status: "ok"; contract: CrmContract } | NotFound> = async (
  tx,
  member,
  id,
  requestId,
) => {
  const seen = await loadContract(tx, member.orgId, id);
  if (!seen || !(await lockRecords(tx, member.orgId, seen))) return NOT_FOUND;
  const current = await loadContract(tx, member.orgId, id, true);
  if (!current) return NOT_FOUND;
  if (current.status !== "sent" || current.signatureRequestId !== requestId) {
    return { status: "ok", contract: await withProgress(tx, member.orgId, current) };
  }
  const [row] = await tx
    .update(crmContracts)
    .set({ status: "draft", signatureRequestId: null })
    .where(eq(crmContracts.id, id))
    .returning(contractColumns);
  await contractEvent(tx, member, row!, "contract_status_changed", {
    from: "sent",
    to: "draft",
    voided: true,
  });
  return { status: "ok", contract: await withProgress(tx, member.orgId, row!) };
};

/** Contracts one settle call looks at; the job calls again with `next`. */
export const CONTRACT_SETTLE_BATCH = 100;

export interface SettledContract {
  orgId: string;
  contractId: string;
  status: "signed" | "draft";
}

function outcomeOf(request: StorageSignatureRequest | undefined) {
  if (!request || request.status === "voided") return { status: "draft" as const };
  if (request.status === "completed" && request.sealedNodeId && request.completedAt) {
    return {
      status: "signed" as const,
      signedAt: request.completedAt,
      signedNodeId: request.sealedNodeId,
    };
  }
  return null;
}

async function settleOne(db: Db, candidate: { id: string; orgId: string }) {
  return db.transaction(async (tx) => {
    const seen = await loadContract(tx, candidate.orgId, candidate.id);
    if (!seen || !(await lockRecords(tx, candidate.orgId, seen))) return null;
    const current = await loadContract(tx, candidate.orgId, candidate.id, true);
    if (!current || current.status !== "sent" || !current.signatureRequestId) return null;
    const requestId = current.signatureRequestId;
    const [request] = await storageSignatureRequestsById(tx as Db, candidate.orgId, [requestId]);
    const outcome = outcomeOf(request);
    if (!outcome) return null;
    const set =
      outcome.status === "signed"
        ? { status: outcome.status, signedAt: outcome.signedAt, signedNodeId: outcome.signedNodeId }
        : { status: outcome.status, signatureRequestId: null };
    await tx.update(crmContracts).set(set).where(eq(crmContracts.id, current.id));
    await tx
      .insert(crmEvents)
      .values({
        orgId: candidate.orgId,
        ...(current.dealId ? { dealId: current.dealId } : { companyId: current.companyId }),
        kind: "contract_status_changed",
        actorMemberId: null,
        data: {
          contractId: current.id,
          title: current.title,
          status: outcome.status,
          from: "sent",
          to: outcome.status,
          ...(outcome.status === "signed" ? { signedNodeId: outcome.signedNodeId } : {}),
        },
        dedupeKey: `contract_settled:${current.id}:${requestId}`,
      })
      .onConflictDoNothing();
    return { orgId: candidate.orgId, contractId: current.id, status: outcome.status };
  });
}

/**
 * Brings contracts out for signature in line with their Storage request: `signed`, with the
 * sealed copy, once everyone signed and Storage sealed it; back to `draft` when it was voided in
 * Drive. Looks at up to `limit` contracts after `after` (by id); the job calls again with `next`
 * until it is null. Safe to run twice: a settled contract is no longer `sent`, and its event is
 * keyed.
 */
export const settleSentContracts: (
  db: Db,
  input?: { after?: string | null; limit?: number },
) => Promise<{ settled: SettledContract[]; next: string | null }> = async (db, input = {}) => {
  const limit = input.limit ?? CONTRACT_SETTLE_BATCH;
  const candidates = await db
    .select({
      id: crmContracts.id,
      orgId: crmContracts.orgId,
      requestId: crmContracts.signatureRequestId,
    })
    .from(crmContracts)
    .where(
      and(
        eq(crmContracts.status, "sent"),
        inArray(crmContracts.signatureRequestId, closedSignatureRequestIds(db)),
        input.after ? gt(crmContracts.id, input.after) : undefined,
      ),
    )
    .orderBy(asc(crmContracts.id))
    .limit(limit);
  const byOrg = Map.groupBy(candidates, (candidate) => candidate.orgId);
  const settled: SettledContract[] = [];
  for (const [orgId, inOrg] of byOrg) {
    const ids = inOrg.map((candidate) => candidate.requestId!);
    const requests = await storageSignatureRequestsById(db, orgId, ids);
    const byId = new Map(requests.map((request) => [request.id, request]));
    for (const candidate of inOrg) {
      if (!outcomeOf(byId.get(candidate.requestId!))) continue;
      const done = await settleOne(db, candidate);
      if (done) settled.push(done);
    }
  }
  return {
    settled,
    next: candidates.length === limit ? (candidates.at(-1)?.id ?? null) : null,
  };
};
