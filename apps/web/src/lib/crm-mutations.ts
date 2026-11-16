// The CRM's changes. Each refetches the CRM when it settles (`crmChanged`); moving a deal between
// stages patches every cached deals list at once and puts it back if the request fails.
import { mutationOptions, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import type { Api } from "@omni/client";
import type { InferRequestType } from "hono/client";
import { api, call } from "./api.ts";
import {
  crmChanged,
  patchDealInLists,
  type CrmContractStatus,
  type CrmDealPage,
  type CrmRecordKind,
  type CrmStage,
} from "./crm.ts";
import { keys } from "./query-keys.ts";
import { storageChanged } from "./storage.ts";

type Crm = Api["crm"];
type Json<T> = T extends { json: infer J } ? J : never;
export type NewCompany = Json<InferRequestType<Crm["companies"]["$post"]>>;
export type NewPerson = Json<InferRequestType<Crm["people"]["$post"]>>;
export type NewDeal = Json<InferRequestType<Crm["deals"]["$post"]>>;
export type CompanyChange = Json<InferRequestType<Crm["companies"][":id"]["$patch"]>>;
export type PersonChange = Json<InferRequestType<Crm["people"][":id"]["$patch"]>>;
export type DealChange = Json<InferRequestType<Crm["deals"][":id"]["$patch"]>>;
export type NewContract = Json<InferRequestType<Crm["contracts"]["$post"]>>;
export type ContractChange = Json<InferRequestType<Crm["contracts"][":id"]["$patch"]>>;
export type StageInput = Json<InferRequestType<Crm["stages"]["$put"]>>["stages"][number];

const settle = (client: QueryClient) => ({ onSettled: () => crmChanged(client) });

export const createCompanyMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (json: NewCompany) => call(api.crm.companies.$post({ json })),
    ...settle(client),
  });

export const createPersonMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (json: NewPerson) => call(api.crm.people.$post({ json })),
    ...settle(client),
  });

export const createDealMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (json: NewDeal) => call(api.crm.deals.$post({ json })),
    ...settle(client),
  });

export const updateCompanyMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, ...json }: CompanyChange & { id: string }) =>
      call(api.crm.companies[":id"].$patch({ param: { id }, json })),
    ...settle(client),
  });

export const updatePersonMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, ...json }: PersonChange & { id: string }) =>
      call(api.crm.people[":id"].$patch({ param: { id }, json })),
    ...settle(client),
  });

export const updateDealMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, ...json }: DealChange & { id: string }) =>
      call(api.crm.deals[":id"].$patch({ param: { id }, json })),
    ...settle(client),
  });

/** `mutate({ id, domain })` adds a domain to a company. */
export const addDomainMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, domain }: { id: string; domain: string }) =>
      call(api.crm.companies[":id"].domains[":domain"].$put({ param: { id, domain } })),
    ...settle(client),
  });

/**
 * `mutate({ dealId, stage })` moves a deal to another stage on every board and list at once; the
 * request's failure puts it back where it was.
 */
export const moveDealMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({ dealId, stage }: { dealId: string; stage: CrmStage }) =>
      call(api.crm.deals[":id"].$patch({ param: { id: dealId }, json: { stageId: stage.id } })),
    onMutate: async ({ dealId, stage }) => {
      await client.cancelQueries({ queryKey: keys.crmDealLists() });
      const before = client.getQueriesData<InfiniteData<CrmDealPage>>({
        queryKey: keys.crmDealLists(),
      });
      patchDealInLists(client, dealId, (deal) => ({
        ...deal,
        stageId: stage.id,
        stageKind: stage.kind,
      }));
      return { before };
    },
    onError: (_error, _move, context) => {
      for (const [key, data] of context?.before ?? []) client.setQueryData(key, data);
    },
    ...settle(client),
  });

/** `mutate({ record, id, body })` writes a note on one company, person or deal. */
export const createNoteMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({ record, id, body }: { record: CrmRecordKind; id: string; body: string }) => {
      const on =
        record === "companies"
          ? { companyId: id }
          : record === "people"
            ? { personId: id }
            : { dealId: id };
      return call(api.crm.notes.$post({ json: { ...on, body } }));
    },
    ...settle(client),
  });

/** `mutate(id)`: its author deletes a note. */
export const deleteNoteMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (id: string) => call(api.crm.notes[":id"].$delete({ param: { id } })),
    ...settle(client),
  });

/**
 * `mutate(record)` finds or makes a company's or deal's folder in Shared and answers its node id;
 * Storage's lists then show it.
 */
export const recordFolderMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({ kind, id }: { kind: "companies" | "deals"; id: string }) =>
      kind === "companies"
        ? call(api.crm.companies[":id"].folder.$post({ param: { id } }))
        : call(api.crm.deals[":id"].folder.$post({ param: { id } })),
    onSettled: () => Promise.all([crmChanged(client), storageChanged(client)]),
  });

export const createContractMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (json: NewContract) => call(api.crm.contracts.$post({ json })),
    ...settle(client),
  });

/** Status, title, dates or file. Signing locks the file, so Storage refetches too. */
export const updateContractMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, ...json }: ContractChange & { id: string }) =>
      call(api.crm.contracts[":id"].$patch({ param: { id }, json })),
    onSettled: () => Promise.all([crmChanged(client), storageChanged(client)]),
  });

export const deleteContractMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (id: string) => call(api.crm.contracts[":id"].$delete({ param: { id } })),
    ...settle(client),
  });

/** `mutate(stages)` replaces the pipeline, in order (owners and admins). */
export const putStagesMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (stages: StageInput[]) => call(api.crm.stages.$put({ json: { stages } })),
    ...settle(client),
  });

/**
 * The moves a contract can make from `status` (docs/spec/crm.md "API"): draft → sent → signed →
 * ended; draft may go straight to signed, and sent back to draft. Signing needs a file.
 */
export function nextStatuses(status: CrmContractStatus): CrmContractStatus[] {
  switch (status) {
    case "draft":
      return ["sent", "signed"];
    case "sent":
      return ["signed", "draft"];
    case "signed":
      return ["ended"];
    case "ended":
      return [];
  }
}
