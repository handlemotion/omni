import { eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { crmContracts } from "../schema/crm.ts";
import { memberStorage, STORAGE_PDF_MIME } from "../storage.ts";
import { wasSigned } from "./contract-status.ts";
import {
  contractColumns,
  contractEvent,
  loadContract,
  lockRecords,
  teamDrive,
  usableDocument,
  withProgress,
  type ContractResult,
  type ContractSignedBy,
} from "./contracts.ts";
import { fileContract, shareContract } from "./contract-people.ts";
import { NOT_FOUND, refuse, type CrmMember, type Ex } from "./core.ts";
import { cleanName } from "./records.ts";

export interface SignedCopyInput {
  /** The executed copy: a PDF in the workspace's drives, wherever it lives. */
  nodeId: string;
  /** When it was signed; now when left out, or the recorded date on a contract already signed. */
  signedAt?: Date;
  signers: ContractSignedBy[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const invalid = (param: string) => ({ status: "invalid_contract" as const, param });

function signersOf(input: ContractSignedBy[]) {
  const signers: ContractSignedBy[] = [];
  for (const signer of input) {
    const name = cleanName(signer.name);
    if (!name) return null;
    const email = signer.email?.trim().toLowerCase() || null;
    signers.push({ name, email });
  }
  return signers;
}

async function isSignedPdf(tx: Ex, member: CrmMember, nodeId: string) {
  if (!(await usableDocument(tx, member, nodeId))) return false;
  const file = await memberStorage(tx as Db, member.id).node(nodeId);
  return file?.node.mimeType === STORAGE_PDF_MIME;
}

async function checkInput(tx: Ex, member: CrmMember, input: SignedCopyInput, now: Date) {
  if (input.signedAt && input.signedAt.getTime() > now.getTime() + DAY_MS) {
    return invalid("signedAt");
  }
  const signers = signersOf(input.signers);
  if (!signers) return invalid("signers");
  if (!(await isSignedPdf(tx, member, input.nodeId))) return invalid("nodeId");
  return { status: "ok" as const, signers };
}

/**
 * Records a contract signed outside Omni (a client's portal, paper, another e-signature
 * service): its executed copy becomes the signed copy, locked, with who signed and when. A draft
 * or a contract sent by hand becomes `signed`; a contract marked signed without its copy takes
 * one. A contract out for signature from Omni refuses (`signature_open`), as does one that
 * already has its signed copy (`contract_signed`).
 */
export const recordSignedCopy: (
  tx: Ex,
  member: CrmMember,
  id: string,
  input: SignedCopyInput,
) => Promise<ContractResult> = async (tx, member, id, input) => {
  const seen = await loadContract(tx, member.orgId, id);
  if (!seen || !(await lockRecords(tx, member.orgId, seen))) return NOT_FOUND;
  const current = await loadContract(tx, member.orgId, id, true);
  if (!current) return NOT_FOUND;
  if (current.status === "sent" && current.signatureRequestId) return { status: "signature_open" };
  if (current.signedNodeId) return { status: "contract_signed" };
  const now = new Date();
  const checked = await checkInput(tx, member, input, now);
  if (checked.status !== "ok") return checked;
  const { signers } = checked;
  const signing = !wasSigned(current.status);
  const documentNodeId = current.documentNodeId ?? input.nodeId;
  const [contract] = await tx
    .update(crmContracts)
    .set({
      status: signing ? "signed" : current.status,
      signedAt: input.signedAt ?? (signing ? now : current.signedAt),
      documentNodeId,
      signedNodeId: input.nodeId,
      signedBy: signers,
    })
    .where(eq(crmContracts.id, id))
    .returning(contractColumns);
  await fileContract(tx, member, contract!);
  await shareContract(tx, member, contract!);
  const storage = memberStorage(tx as Db, member.id);
  for (const nodeId of new Set([documentNodeId, input.nodeId])) {
    const locked = await storage.lock(nodeId);
    if (locked.status !== "ok" || !teamDrive(locked.node)) refuse(invalid("nodeId"));
  }
  const copy = { signedNodeId: input.nodeId, signers, elsewhere: true };
  if (signing) {
    await contractEvent(tx, member, contract!, "contract_status_changed", {
      from: current.status,
      to: "signed",
      ...copy,
    });
  } else {
    await contractEvent(tx, member, contract!, "contract_document_changed", {
      from: current.documentNodeId,
      to: documentNodeId,
      ...copy,
    });
  }
  return { status: "ok", contract: await withProgress(tx, member.orgId, contract!) };
};
