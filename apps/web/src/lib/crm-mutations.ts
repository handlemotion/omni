import { mutationOptions, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import type { Api } from "@omni/client";
import type { InferRequestType } from "hono/client";
import { api, call } from "./api.ts";
import type { CrmContractStatus, CrmRecordKind, CrmStage } from "./crm.ts";
import { dropFromPages, optimisticCrm, setCrmFields, settleCrm } from "./crm-cache.ts";
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
export type ContractSigners = Json<
  InferRequestType<Crm["contracts"][":id"]["send"]["$post"]>
>["signers"];
export type SignedCopy = Json<InferRequestType<Crm["contracts"][":id"]["signed-copy"]["$post"]>>;
export type StageInput = Json<InferRequestType<Crm["stages"]["$put"]>>["stages"][number];

const settle = (client: QueryClient) => settleCrm(client);
const settleWithStorage = (client: QueryClient) =>
  settleCrm(client, () => void storageChanged(client));

function stageKindOf(client: QueryClient, stageId: string | undefined) {
  if (!stageId) return undefined;
  const pipeline = client.getQueryData<{ stages: CrmStage[] }>(keys.crmStages());
  return pipeline?.stages.find((stage) => stage.id === stageId)?.kind;
}

export const createCompanyMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (json: NewCompany) => call(api.crm.companies.$post({ json })),
    ...settle(client),
  });

export const createPersonMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (json: NewPerson) => call(api.crm.people.$post({ json })),
    ...settle(client),
  });

export const createDealMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (json: NewDeal) => call(api.crm.deals.$post({ json })),
    ...settle(client),
  });

export const updateCompanyMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ id, ...json }: CompanyChange & { id: string }) =>
      call(api.crm.companies[":id"].$patch({ param: { id }, json })),
    ...optimisticCrm(
      client,
      ({ id, name, description, ownerMemberId }: CompanyChange & { id: string }) =>
        setCrmFields(client, id, { name, description, ownerMemberId }),
    ),
    ...settle(client),
  });

export const updatePersonMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ id, ...json }: PersonChange & { id: string }) =>
      call(api.crm.people[":id"].$patch({ param: { id }, json })),
    ...optimisticCrm(
      client,
      ({ id, name, companyId, jobTitle, phone, ownerMemberId }: PersonChange & { id: string }) =>
        setCrmFields(client, id, { name, companyId, jobTitle, phone, ownerMemberId }),
    ),
    ...settle(client),
  });

export const updateDealMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ id, ...json }: DealChange & { id: string }) =>
      call(api.crm.deals[":id"].$patch({ param: { id }, json })),
    ...optimisticCrm(client, (change: DealChange & { id: string }) =>
      setCrmFields(client, change.id, {
        name: change.name,
        companyId: change.companyId,
        ownerMemberId: change.ownerMemberId,
        valueMinor: change.valueMinor,
        valueCurrency: change.currency,
        expectedCloseOn: change.expectedCloseOn,
        stageId: change.stageId,
        stageKind: stageKindOf(client, change.stageId),
      }),
    ),
    ...settle(client),
  });

/** `mutate({ id, file })` sets a deal's picture; a PUT keyed by content, so a retry is safe. */
export const setDealIconMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ id, file }: { id: string; file: File }) =>
      call(api.crm.deals[":id"].icon.$put({ param: { id }, form: { file } })),
    ...settle(client),
  });

/** `mutate(id)`: the deal shows its client's logo again. */
export const removeDealIconMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (id: string) => call(api.crm.deals[":id"].icon.$delete({ param: { id } })),
    ...settle(client),
  });

/** `mutate({ id, domain })` adds a domain to a company. */
export const addDomainMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ id, domain }: { id: string; domain: string }) =>
      call(api.crm.companies[":id"].domains[":domain"].$put({ param: { id, domain } })),
    ...settle(client),
  });

/** `mutate({ id, domain })` takes a domain off a company. */
export const removeDomainMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ id, domain }: { id: string; domain: string }) =>
      call(api.crm.companies[":id"].domains[":domain"].$delete({ param: { id, domain } })),
    ...settle(client),
  });

export type RecordLifecycle = "archive" | "restore" | "delete";

const DELETE_QUERY: Record<Exclude<RecordLifecycle, "restore">, { forever?: "1" }> = {
  archive: {},
  delete: { forever: "1" },
};

async function lifecycle(kind: CrmRecordKind, id: string, action: RecordLifecycle) {
  const param = { id };
  if (action === "restore") {
    if (kind === "companies") await call(api.crm.companies[":id"].restore.$post({ param }));
    else if (kind === "people") await call(api.crm.people[":id"].restore.$post({ param }));
    else await call(api.crm.deals[":id"].restore.$post({ param }));
    return;
  }
  const query = DELETE_QUERY[action];
  if (kind === "companies") await call(api.crm.companies[":id"].$delete({ param, query }));
  else if (kind === "people") await call(api.crm.people[":id"].$delete({ param, query }));
  else await call(api.crm.deals[":id"].$delete({ param, query }));
}

/** `mutate({ kind, id, action })`: archive, bring back, or delete for good (owners and admins). */
export const recordLifecycleMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({
      kind,
      id,
      action,
    }: {
      kind: CrmRecordKind;
      id: string;
      action: RecordLifecycle;
    }) => lifecycle(kind, id, action),
    ...optimisticCrm(
      client,
      ({ kind, id, action }: { kind: CrmRecordKind; id: string; action: RecordLifecycle }) => {
        if (action === "delete") dropFromPages(client, keys.crm(), kind, new Set([id]));
        else
          setCrmFields(client, id, {
            archivedAt: action === "archive" ? new Date().toISOString() : null,
          });
      },
    ),
    ...settle(client),
  });

export type BulkAction = Json<InferRequestType<Crm["companies"]["bulk"]["$post"]>>["action"];

const bulkRoute = (kind: CrmRecordKind) =>
  kind === "companies"
    ? api.crm.companies.bulk
    : kind === "people"
      ? api.crm.people.bulk
      : api.crm.deals.bulk;

const BULK_BATCH = 200;

async function bulk(kind: CrmRecordKind, ids: string[], action: BulkAction) {
  const result = { done: [] as string[], refused: [] as { id: string; code: string }[] };
  for (let start = 0; start < ids.length; start += BULK_BATCH) {
    const batch = ids.slice(start, start + BULK_BATCH);
    const answer = await call(bulkRoute(kind).$post({ json: { ids: batch, action } }));
    result.done.push(...answer.done);
    result.refused.push(...answer.refused);
  }
  return result;
}

/** `mutateAsync({ kind, ids, action })` → what changed and what was refused, by id. */
export const bulkMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({
      kind,
      ids,
      action,
    }: {
      kind: CrmRecordKind;
      ids: string[];
      action: BulkAction;
    }) => bulk(kind, ids, action),
    ...settle(client),
  });

/**
 * `mutate({ dealId, stage })` moves a deal to another stage on its page and every board and list at
 * once; the request's failure puts it back where it was.
 */
export const moveDealMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ dealId, stage }: { dealId: string; stage: CrmStage }) =>
      call(api.crm.deals[":id"].$patch({ param: { id: dealId }, json: { stageId: stage.id } })),
    ...optimisticCrm(client, ({ dealId, stage }: { dealId: string; stage: CrmStage }) =>
      setCrmFields(client, dealId, { stageId: stage.id, stageKind: stage.kind }),
    ),
    ...settle(client),
  });

type TimelinePage = { items: { kind: string; id: string; note?: { id: string } }[] };

/**
 * `mutate({ record, id, body })` writes a note on one company, person or deal. It shows at the top
 * of the record's timeline at once, from `authorMemberId`, and goes again if the request fails.
 */
export const createNoteMutation = (client: QueryClient, authorMemberId: string | null) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ record, id, body }: { record: CrmRecordKind; id: string; body: string }) =>
      call(api.crm.notes.$post({ json: { ...noteOn(record, id), body } })),
    ...optimisticCrm(
      client,
      ({ record, id, body }: { record: CrmRecordKind; id: string; body: string }) => {
        const at = new Date().toISOString();
        const noteId = `pending-${crypto.randomUUID()}`;
        const on = { companyId: null, personId: null, dealId: null, ...noteOn(record, id) };
        const item = {
          kind: "note",
          id: noteId,
          at,
          note: { id: noteId, ...on, body, authorMemberId, createdAt: at, updatedAt: at },
        };
        client.setQueryData<InfiniteData<TimelinePage>>(keys.crmTimeline(record, id), (data) =>
          data?.pages[0]
            ? {
                ...data,
                pages: [
                  { ...data.pages[0], items: [item, ...data.pages[0].items] },
                  ...data.pages.slice(1),
                ],
              }
            : data,
        );
      },
    ),
    ...settle(client),
  });

const noteOn = (record: CrmRecordKind, id: string) =>
  record === "companies"
    ? { companyId: id }
    : record === "people"
      ? { personId: id }
      : { dealId: id };

/** `mutate(id)`: its author deletes a note; it leaves every timeline at once. */
export const deleteNoteMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (id: string) => call(api.crm.notes[":id"].$delete({ param: { id } })),
    ...optimisticCrm(client, (id: string) =>
      client.setQueriesData<InfiniteData<TimelinePage>>(
        { queryKey: [...keys.crm(), "timeline"] },
        (data) =>
          data && {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              items: page.items.filter((item) => item.id !== id && item.note?.id !== id),
            })),
          },
      ),
    ),
    ...settle(client),
  });

/**
 * `mutate(record)` finds or makes a company's or deal's folder in Shared and answers its node id;
 * Storage's lists then show it.
 */
export const recordFolderMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ kind, id }: { kind: "companies" | "deals"; id: string }) =>
      kind === "companies"
        ? call(api.crm.companies[":id"].folder.$post({ param: { id } }))
        : call(api.crm.deals[":id"].folder.$post({ param: { id } })),
    ...settleWithStorage(client),
  });

export const createContractMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (json: NewContract) => call(api.crm.contracts.$post({ json })),
    ...settle(client),
  });

/** Status, title, dates or file. Signing locks the file, so Storage refetches too. */
export const updateContractMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ id, ...json }: ContractChange & { id: string }) =>
      call(api.crm.contracts[":id"].$patch({ param: { id }, json })),
    ...settleWithStorage(client),
  });

/** Sends a draft's PDF to its signers; the file locks, so Storage refetches too. */
export const sendContractMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ id, signers }: { id: string; signers: ContractSigners }) =>
      call(api.crm.contracts[":id"].send.$post({ param: { id }, json: { signers } })),
    ...settleWithStorage(client),
  });

/** Records a contract signed elsewhere with its executed copy; both files lock. */
export const signedCopyMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ id, ...json }: SignedCopy & { id: string }) =>
      call(api.crm.contracts[":id"]["signed-copy"].$post({ param: { id }, json })),
    ...settleWithStorage(client),
  });

/** Voids the open signature request; the contract is a draft again. */
export const voidContractMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (id: string) => call(api.crm.contracts[":id"].void.$post({ param: { id } })),
    ...settleWithStorage(client),
  });

export const deleteContractMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (id: string) => call(api.crm.contracts[":id"].$delete({ param: { id } })),
    ...settle(client),
  });

/** `mutate(stages)` replaces the pipeline, in order (owners and admins). */
export const putStagesMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (stages: StageInput[]) => call(api.crm.stages.$put({ json: { stages } })),
    ...settle(client),
  });

/**
 * The moves a contract can make from `status` (docs/spec/crm.md "API"): draft → sent → signed →
 * ended; draft may go straight to signed, and sent back to draft. Signing needs a file.
 */
export const nextStatuses: (status: CrmContractStatus) => CrmContractStatus[] = (status) => {
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
};
