import type { Db } from "../client.ts";
import {
  storageSignatureRequestsById,
  type StorageSignatureRequest,
  type StorageSignatureStatus,
} from "../storage.ts";
import type { Ex } from "./core.ts";

/** One signer's progress on a contract sent from Omni. */
export interface CrmContractSigner {
  email: string;
  name: string;
  /** When they first opened the document; null until they do. */
  viewedAt: Date | null;
  signedAt: Date | null;
}

/** Where a contract sent from Omni is with its signers (ADR 0037), read from Storage's request. */
export interface CrmContractSigning {
  requestId: string;
  status: StorageSignatureStatus;
  sentAt: Date;
  completedAt: Date | null;
  voidedAt: Date | null;
  /** The sealed copy once Storage wrote it; the contract records it as `signedNodeId` soon after. */
  sealedNodeId: string | null;
  signers: CrmContractSigner[];
}

function progressOf(request: StorageSignatureRequest) {
  const firstViewed = new Map<string, Date>();
  for (const event of request.events) {
    if (event.kind === "viewed" && !firstViewed.has(event.email)) {
      firstViewed.set(event.email, event.createdAt);
    }
  }
  return {
    requestId: request.id,
    status: request.status,
    sentAt: request.createdAt,
    completedAt: request.completedAt,
    voidedAt: request.voidedAt,
    sealedNodeId: request.sealedNodeId,
    signers: request.signers.map((signer) => ({
      email: signer.email,
      name: signer.name,
      viewedAt: firstViewed.get(signer.email) ?? signer.signedAt,
      signedAt: signer.signedAt,
    })),
  } satisfies CrmContractSigning;
}

/** Each contract with its signing progress, or `signing: null` when it was never sent from Omni. */
export async function withSigning<T extends { signatureRequestId: string | null }>(
  ex: Ex,
  orgId: string,
  contracts: T[],
) {
  const ids = contracts.flatMap((c) => (c.signatureRequestId ? [c.signatureRequestId] : []));
  const requests = await storageSignatureRequestsById(ex as Db, orgId, ids);
  const byId = new Map(requests.map((request) => [request.id, progressOf(request)]));
  return contracts.map((contract) => ({
    ...contract,
    signing: (contract.signatureRequestId && byId.get(contract.signatureRequestId)) || null,
  }));
}
