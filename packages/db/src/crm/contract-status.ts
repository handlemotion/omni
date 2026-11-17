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

function documentRefusal(from: ContractStatus, to: ContractStatus) {
  if (from === "draft" || (from === "sent" && to !== "sent")) return null;
  return wasSigned(from) ? CONTRACT_SIGNED : ({ status: "invalid_transition", from, to } as const);
}

/** The contract's state after `change` at `now`, or why it is refused. Never throws. */
export const changeContract: (
  state: ContractState,
  change: ContractChange,
  now: Date,
) => ContractTransition = (state, change, now) => {
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
};
