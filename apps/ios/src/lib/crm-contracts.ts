import type { Api } from "@omni/client";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InferRequestType, InferResponseType } from "hono/client";
import { api, call } from "./api.ts";
import { crmChanged } from "./crm-mutations.ts";

type Crm = Api["crm"];
export type CrmContract = InferResponseType<Crm["contracts"]["$get"], 200>["contracts"][number];
export type ContractSigner = NonNullable<CrmContract["signing"]>["signers"][number];
export type ContractSigners = InferRequestType<
  Crm["contracts"][":id"]["send"]["$post"]
>["json"]["signers"];

/** The record a contract list is on: a deal's, or a company's (its deals' included). */
export type ContractOwner = { kind: "deals" | "companies"; id: string };

type ContractPage = InferResponseType<Crm["contracts"]["$get"], 200>;

const OPEN_POLL_MS = 15_000;
const MAX_PAGES = 20;

/**
 * Every contract on the record, all pages. While one is out for signature it polls, since a
 * signer viewing or signing announces nothing.
 */
export const contractsQuery = (owner: ContractOwner) =>
  queryOptions({
    queryKey: ["crm", "contracts", owner.kind, owner.id] as const,
    queryFn: async ({ signal }) => {
      const where = owner.kind === "deals" ? { deal: owner.id } : { company: owner.id };
      const contracts: CrmContract[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MAX_PAGES; page++) {
        const answer: ContractPage = await call(
          api.crm.contracts.$get(
            { query: { ...where, ...(cursor ? { cursor } : {}) } },
            { init: { signal } },
          ),
        );
        contracts.push(...answer.contracts);
        cursor = answer.nextCursor;
        if (!cursor) break;
      }
      return contracts;
    },
    refetchInterval: (query) =>
      query.state.data?.some((contract) => contract.signing?.status === "sent")
        ? OPEN_POLL_MS
        : false,
  });

export const useContracts = (owner: ContractOwner) => useQuery(contractsQuery(owner));

export function useSendContract() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, signers }: { id: string; signers: ContractSigners }) =>
      call(api.crm.contracts[":id"].send.$post({ param: { id }, json: { signers } })),
    onSettled: () => crmChanged(client),
  });
}

export function useVoidContract() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => call(api.crm.contracts[":id"].void.$post({ param: { id } })),
    onSettled: () => crmChanged(client),
  });
}

const DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const day = (date: string) => DAY.format(new Date(`${date}T00:00:00`));

const ENDING_SOON_DAYS = 30;

function daysUntil(date: string, now = new Date()) {
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((Date.parse(`${date}T00:00:00Z`) - today) / 86_400_000);
}

/** The word a contract's row ends with: its status, how far signing got, or that it ends soon. */
export function contractStatus(contract: CrmContract) {
  const signing = contract.signing;
  if (contract.status === "sent" && signing?.status === "completed") return "Signed";
  if (contract.status === "sent" && signing) return "Out for signature";
  if (contract.status === "signed" && contract.expiresOn) {
    const left = daysUntil(contract.expiresOn);
    if (left <= 0) return "Ends today";
    if (left === 1) return "Ends tomorrow";
    if (left <= ENDING_SOON_DAYS) return `Ends in ${left} days`;
  }
  const LABELS = { draft: "Draft", sent: "Sent", signed: "Signed", ended: "Ended" } as const;
  return LABELS[contract.status];
}

/** "1 of 2 signed" while out for signature, else its dates. */
export function contractLine(contract: CrmContract) {
  const signing = contract.signing;
  if (contract.status === "sent" && signing?.status === "sent") {
    const signed = signing.signers.filter((signer) => signer.signedAt).length;
    return `${signed} of ${signing.signers.length} signed`;
  }
  const dates = [
    contract.effectiveOn && `From ${day(contract.effectiveOn)}`,
    contract.expiresOn && `${contract.effectiveOn ? "until" : "Until"} ${day(contract.expiresOn)}`,
  ].filter(Boolean);
  return dates.length ? dates.join(" ") : null;
}

export function signerStatus(signer: ContractSigner) {
  if (signer.signedAt) return "Signed";
  if (signer.viewedAt) return "Viewed";
  return "Waiting";
}

/** The sealed copy: recorded on the contract, or Storage's as soon as it wrote it. */
export const signedCopyOf = (contract: CrmContract) =>
  contract.signedNodeId ?? contract.signing?.sealedNodeId ?? null;
