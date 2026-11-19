import type { Api } from "@omni/client";
import {
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
} from "@tanstack/react-query";
import type { InferRequestType, InferResponseType } from "hono/client";
import { api, call } from "./api.ts";
import type { CrmStage } from "./crm-timeline.ts";
import { keys } from "./query-keys.ts";
import { cacheEpoch } from "./workspace-id.ts";

type Crm = Api["crm"];
type Json<T> = T extends { json: infer J } ? J : never;
export type NewCompany = Json<InferRequestType<Crm["companies"]["$post"]>>;
export type NewPerson = Json<InferRequestType<Crm["people"]["$post"]>>;
export type NewDeal = Json<InferRequestType<Crm["deals"]["$post"]>>;
export type CompanyChange = Json<InferRequestType<Crm["companies"][":id"]["$patch"]>>;
export type PersonChange = Json<InferRequestType<Crm["people"][":id"]["$patch"]>>;
export type DealChange = Json<InferRequestType<Crm["deals"][":id"]["$patch"]>>;
type DealPage = InferResponseType<Crm["deals"]["$get"], 200>;
type DealDetail = InferResponseType<Crm["deals"][":id"]["$get"], 200>;

/** The three records, as the API's paths name them. */
export type CrmRecordKind = "companies" | "people" | "deals";

/** Every change can touch lists, records and timelines alike: all of the CRM refetches. */
export const crmChanged = (client: QueryClient) => client.invalidateQueries({ queryKey: ["crm"] });

function useCrmMutation<V, R>(mutationFn: (vars: V) => Promise<R>) {
  const client = useQueryClient();
  return useMutation({ mutationFn, onSettled: () => crmChanged(client) });
}

export const useCreateCompany = () =>
  useCrmMutation((json: NewCompany) => call(api.crm.companies.$post({ json })));

export const useCreatePerson = () =>
  useCrmMutation((json: NewPerson) => call(api.crm.people.$post({ json })));

export const useCreateDeal = () =>
  useCrmMutation((json: NewDeal) => call(api.crm.deals.$post({ json })));

export const useUpdateCompany = () =>
  useCrmMutation(({ id, ...json }: CompanyChange & { id: string }) =>
    call(api.crm.companies[":id"].$patch({ param: { id }, json })),
  );

export const useUpdatePerson = () =>
  useCrmMutation(({ id, ...json }: PersonChange & { id: string }) =>
    call(api.crm.people[":id"].$patch({ param: { id }, json })),
  );

export const useUpdateDeal = () =>
  useCrmMutation(({ id, ...json }: DealChange & { id: string }) =>
    call(api.crm.deals[":id"].$patch({ param: { id }, json })),
  );

/** `mutate({ id, domain })` adds a domain to a company. */
export const useAddDomain = () =>
  useCrmMutation(({ id, domain }: { id: string; domain: string }) =>
    call(api.crm.companies[":id"].domains[":domain"].$put({ param: { id, domain } })),
  );

/**
 * `mutate({ dealId, stage })` moves a deal to another stage in every list and on its own screen
 * at once; the request's failure puts it back where it was.
 */
export function useMoveDeal() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ dealId, stage }: { dealId: string; stage: CrmStage }) =>
      call(api.crm.deals[":id"].$patch({ param: { id: dealId }, json: { stageId: stage.id } })),
    onMutate: async ({ dealId, stage }) => {
      const lists = keys.crmList("deals");
      const record = keys.crmRecord("deal", dealId);
      await Promise.all([
        client.cancelQueries({ queryKey: lists }),
        client.cancelQueries({ queryKey: record }),
      ]);
      const before = [
        ...client.getQueriesData({ queryKey: lists }),
        ...client.getQueriesData({ queryKey: record }),
      ];
      const move = <T extends { id: string; stageId: string }>(deal: T) =>
        deal.id === dealId ? { ...deal, stageId: stage.id, stageKind: stage.kind } : deal;
      client.setQueriesData<InfiniteData<DealPage>>({ queryKey: lists }, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((page) => ({ ...page, deals: page.deals.map(move) })),
            }
          : data,
      );
      client.setQueryData<DealDetail>(record, (data) =>
        data ? { ...data, deal: move(data.deal) } : data,
      );
      return { before, epoch: cacheEpoch() };
    },
    onError: (_error, _move, context) => {
      if (context?.epoch !== cacheEpoch()) return;
      for (const [key, data] of context.before) client.setQueryData(key, data);
    },
    onSettled: () => crmChanged(client),
  });
}

/** `mutate({ record, id, body })` writes a note on one company, person or deal. */
export const useCreateNote = () =>
  useCrmMutation(({ record, id, body }: { record: CrmRecordKind; id: string; body: string }) => {
    const on =
      record === "companies"
        ? { companyId: id }
        : record === "people"
          ? { personId: id }
          : { dealId: id };
    return call(api.crm.notes.$post({ json: { ...on, body } }));
  });

/** Its author rewrites a note. */
export const useEditNote = () =>
  useCrmMutation(({ id, body }: { id: string; body: string }) =>
    call(api.crm.notes[":id"].$patch({ param: { id }, json: { body } })),
  );

/** `mutate(id)`: its author deletes a note. */
export const useDeleteNote = () =>
  useCrmMutation((id: string) => call(api.crm.notes[":id"].$delete({ param: { id } })));

/** "12500.50" or "12,500" typed by a person, as minor units; null when it is not a number. */
export function parseMoney(text: string) {
  const cleaned = text.replace(/[^\d.,-]/g, "").replace(/,(?=\d{3}(\D|$))/g, "");
  if (!cleaned) return null;
  const value = Number(cleaned.replace(",", "."));
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}
