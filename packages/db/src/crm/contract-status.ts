// A contract's status rules (ADR 0036 decision 6) in one place, so a route and an agent cannot
// disagree. Pure: no I/O. The caller writes what it answers and locks `lock` in the same
// transaction.
//
//   draft  -> sent, signed     Signed straight from draft: the executed copy is attached.
//   sent   -> draft, signed    Back to draft when the client asks for changes.
//   signed -> ended            Expired or terminated.
//   ended  -> (none)
//
// - Once signed, always signed: a signed or ended contract never goes back, its document never
//   changes and it is never deleted (`contract_signed`). Its dates and title may still change.
// - The document is replaced while `draft`, or by the change that moves a `sent` contract back
//   to draft or marks it signed (the executed copy). A `sent` contract otherwise keeps its
//   document: what the client has is what it shows (`invalid_transition` from sent to sent).
// - `signed` needs a document, and marking it signed locks that file in Storage.
// - `signedAt` is set on signing (now, unless the change names the day it was signed). It may be
//   corrected on a signed or ended contract and is refused on any other.
// - A change to the status the contract has changes nothing and writes no event.

export type ContractStatus = "draft" | "sent" | "signed" | "ended";

export interface ContractState {
  status: ContractStatus;
  documentNodeId: string | null;
  signedAt: Date | null;
}

export interface ContractChange {
  status?: ContractStatus;
  /** Null takes the document off a draft. */
  documentNodeId?: string | null;
  signedAt?: Date;
}

/** A signed (or ended) contract refuses the change. */
export type ContractSigned = { status: "contract_signed" };
/** The status cannot go from `from` to `to`, or a sent contract's document changes on its own. */
export type InvalidTransition = {
  status: "invalid_transition";
  from: ContractStatus;
  to: ContractStatus;
};
/** A field the change cannot carry: `documentNodeId` missing on signing, `signedAt` unsigned. */
export type InvalidContract = { status: "invalid_contract"; param: string };

export type ContractTransition =
  | {
      status: "ok";
      state: ContractState;
      statusChanged: boolean;
      documentChanged: boolean;
      /** The file to lock in the same transaction, when this change signs the contract. */
      lock: string | null;
    }
  | ContractSigned
  | InvalidTransition
  | InvalidContract;

const NEXT: Record<ContractStatus, readonly ContractStatus[]> = {
  draft: ["sent", "signed"],
  sent: ["draft", "signed"],
  signed: ["ended"],
  ended: [],
};

export const CONTRACT_SIGNED = { status: "contract_signed" } as const;

/** Signed now or before: what can no longer be undone. */
export const wasSigned = (status: ContractStatus) => status === "signed" || status === "ended";

/** Why the document may not change from `from` to `to`, or null when it may. */
function documentRefusal(from: ContractStatus, to: ContractStatus) {
  // From `sent`, only with a move: back to draft, or signed with the executed copy.
  if (from === "draft" || (from === "sent" && to !== "sent")) return null;
  return wasSigned(from) ? CONTRACT_SIGNED : ({ status: "invalid_transition", from, to } as const);
}

/** The contract's state after `change` at `now`, or why it is refused. Never throws. */
export function changeContract(
  state: ContractState,
  change: ContractChange,
  now: Date,
): ContractTransition {
  const from = state.status;
  const to = change.status ?? from;
  const statusChanged = to !== from;
  if (statusChanged && !NEXT[from].includes(to)) {
    return wasSigned(from) ? CONTRACT_SIGNED : { status: "invalid_transition", from, to };
  }
  const documentNodeId =
    change.documentNodeId === undefined ? state.documentNodeId : change.documentNodeId;
  const documentChanged = documentNodeId !== state.documentNodeId;
  const refusal = documentChanged ? documentRefusal(from, to) : null;
  if (refusal) return refusal;
  if (to === "signed" && !documentNodeId) {
    return { status: "invalid_contract", param: "documentNodeId" };
  }
  if (change.signedAt && !wasSigned(to)) return { status: "invalid_contract", param: "signedAt" };
  const signing = statusChanged && to === "signed";
  const signedAt = change.signedAt ?? (signing ? now : state.signedAt);
  return {
    status: "ok",
    state: { status: to, documentNodeId, signedAt },
    statusChanged,
    documentChanged,
    lock: signing ? documentNodeId : null,
  };
}
