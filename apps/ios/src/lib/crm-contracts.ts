import type { Api, CrmContract } from "@omni/client";
import { queryOptions, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { InferRequestType, InferResponseType } from "hono/client";
import { api, call } from "./api.ts";
import { crmChanged } from "./crm-mutations.ts";

type Crm = Api["crm"];
export type ContractSigner = NonNullable<CrmContract["signing"]>["signers"][number];
export type ContractSigners = InferRequestType<
  Crm["contracts"][":id"]["send"]["$post"]
>["json"]["signers"];

export type SignedCopy = InferRequestType<Crm["contracts"][":id"]["signed-copy"]["$post"]>["json"];

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

/** Records a contract signed elsewhere with its executed copy (`POST /contracts/:id/signed-copy`). */
export function useSignedCopy() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...json }: SignedCopy & { id: string }) =>
      call(api.crm.contracts[":id"]["signed-copy"].$post({ param: { id }, json })),
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

export function signerStatus(signer: ContractSigner) {
  if (signer.signedAt) return "Signed";
  if (signer.viewedAt) return "Viewed";
  return "Waiting";
}

/** The sealed copy: recorded on the contract, or Storage's as soon as it wrote it. */
export const signedCopyOf = (contract: CrmContract) =>
  contract.signedNodeId ?? contract.signing?.sealedNodeId ?? null;
