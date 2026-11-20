import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { Alert } from "react-native";
import { api, call } from "./api.ts";
import { crmErrorAlert } from "./crm-errors.ts";
import { crmChanged, type CrmRecordKind } from "./crm-mutations.ts";
import { useMe } from "./crm-timeline.ts";
import { keys } from "./query-keys.ts";
import { cacheEpoch } from "./workspace-id.ts";

type ListPage = Record<string, unknown> & { nextCursor: string | null };

const FIELD: Record<CrmRecordKind, string> = {
  companies: "companies",
  people: "people",
  deals: "deals",
};

const { companies, people, deals } = {
  companies: api.crm.companies[":id"],
  people: api.crm.people[":id"],
  deals: api.crm.deals[":id"],
};

type Write = (id: string) => Promise<unknown>;
type Owner = (id: string, ownerMemberId: string | null) => Promise<unknown>;

const WRITES: Record<
  CrmRecordKind,
  { archive: Write; restore: Write; deleteForever: Write; owner: Owner }
> = {
  companies: {
    archive: (id) => call(companies.$delete({ param: { id }, query: {} })),
    restore: (id) => call(companies.restore.$post({ param: { id } })),
    deleteForever: (id) => call(companies.$delete({ param: { id }, query: { forever: "1" } })),
    owner: (id, ownerMemberId) =>
      call(companies.$patch({ param: { id }, json: { ownerMemberId } })),
  },
  people: {
    archive: (id) => call(people.$delete({ param: { id }, query: {} })),
    restore: (id) => call(people.restore.$post({ param: { id } })),
    deleteForever: (id) => call(people.$delete({ param: { id }, query: { forever: "1" } })),
    owner: (id, ownerMemberId) => call(people.$patch({ param: { id }, json: { ownerMemberId } })),
  },
  deals: {
    archive: (id) => call(deals.$delete({ param: { id }, query: {} })),
    restore: (id) => call(deals.restore.$post({ param: { id } })),
    deleteForever: (id) => call(deals.$delete({ param: { id }, query: { forever: "1" } })),
    owner: (id, ownerMemberId) => call(deals.$patch({ param: { id }, json: { ownerMemberId } })),
  },
};

const FAILED = {
  archive: "It was not archived",
  restore: "It was not restored",
  deleteForever: "It was not deleted",
};

/** What leaves a list: archiving takes a record out of the live list, restoring out of Archived. */
export type RecordMove = keyof typeof FAILED;

/**
 * `mutate(id)` archives, restores or deletes one record for good. It leaves every list of its
 * kind at once (the other list gains it when it refetches); a failure puts it back.
 */
export function useRecordMove(kind: CrmRecordKind, move: RecordMove) {
  const client = useQueryClient();
  const lists = keys.crmList(kind);
  const field = FIELD[kind];
  return useMutation({
    mutationFn: (id: string) => WRITES[kind][move](id),
    onMutate: async (id) => {
      await client.cancelQueries({ queryKey: lists });
      const before = client.getQueriesData({ queryKey: lists });
      client.setQueriesData<InfiniteData<ListPage>>({ queryKey: lists }, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                [field]: (page[field] as { id: string }[]).filter((one) => one.id !== id),
              })),
            }
          : data,
      );
      return { before, epoch: cacheEpoch() };
    },
    onError: (error, _id, context) => {
      crmErrorAlert(error, FAILED[move]);
      if (context?.epoch !== cacheEpoch()) return;
      for (const [key, data] of context.before) client.setQueryData(key, data);
    },
    onSettled: () => crmChanged(client),
  });
}

/** `mutate({ id, ownerMemberId })` hands one record to a member, or to no one (null). */
export function useSetOwner(kind: CrmRecordKind) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ownerMemberId }: { id: string; ownerMemberId: string | null }) =>
      WRITES[kind].owner(id, ownerMemberId),
    onError: (error) => crmErrorAlert(error, "The owner was not changed"),
    onSettled: () => crmChanged(client),
  });
}

/** Whether you are an owner or admin here: only they delete a record for good. */
export function useIsAdmin() {
  const role = useMe().data?.role ?? "";
  return /\b(owner|admin)\b/.test(role);
}

/** The web's question before a record is deleted for good; `run` once it is confirmed. */
export function confirmDeleteForever(name: string, run: () => void) {
  Alert.alert(`Delete ${name || "this record"} forever?`, undefined, [
    { text: "Cancel", style: "cancel" },
    { text: "Delete forever", style: "destructive", onPress: run },
  ]);
}
