import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import {
  crmCompaniesQuery,
  crmCompanyIndexQuery,
  crmSettingsQuery,
  type CrmCompanyFilter,
  type CrmDealFilter,
  type CrmPeopleFilter,
  crmCompanyQuery,
  crmContractsQuery,
  crmDealQuery,
  crmDealsQuery,
  crmFindQuery,
  crmPeopleQuery,
  crmPersonQuery,
  crmStagesQuery,
  crmTimelineQuery,
  type CrmRecordKind,
} from "../lib/crm.ts";
import {
  addDomainMutation,
  bulkMutation,
  recordLifecycleMutation,
  removeDomainMutation,
  createCompanyMutation,
  createContractMutation,
  createDealMutation,
  createNoteMutation,
  createPersonMutation,
  deleteContractMutation,
  deleteNoteMutation,
  moveDealMutation,
  putStagesMutation,
  recordFolderMutation,
  updateCompanyMutation,
  updateContractMutation,
  updateDealMutation,
  updatePersonMutation,
} from "../lib/crm-mutations.ts";
import { useMembers } from "./use-organization.ts";
import { useMember } from "./use-session.ts";
import { useCurrentWorkspace } from "./use-workspaces.ts";

/** True in a company workspace: a Personal space has no CRM (`no_crm`). */
export function useHasCrm() {
  const active = useCurrentWorkspace();
  return !!active && active.kind !== "personal";
}

/** Companies by name (or `filter`); `companies` is every loaded page. */
export function useCrmCompanies(filter: CrmCompanyFilter | string = "") {
  const query = useInfiniteQuery(crmCompaniesQuery(filter));
  const companies = useMemo(
    () => query.data?.pages.flatMap((page) => page.companies) ?? [],
    [query.data],
  );
  return { ...query, companies };
}

export function useCrmPeople(filter: CrmPeopleFilter | string = "") {
  const query = useInfiniteQuery(crmPeopleQuery(filter));
  const people = useMemo(
    () => query.data?.pages.flatMap((page) => page.people) ?? [],
    [query.data],
  );
  return { ...query, people };
}

/** Deals by name; `all` keeps loading pages until every deal is there (the board). */
export function useCrmDeals(filter: CrmDealFilter | string = "", options: { all?: boolean } = {}) {
  const query = useInfiniteQuery(crmDealsQuery(filter));
  const deals = useMemo(() => query.data?.pages.flatMap((page) => page.deals) ?? [], [query.data]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (options.all && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [options.all, hasNextPage, isFetchingNextPage, fetchNextPage]);
  return { ...query, deals };
}

/** Every live company by id, loading every page: the Company columns' names and logos. */
export function useCrmCompanyIndex() {
  const query = useInfiniteQuery(crmCompanyIndexQuery());
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);
  return useMemo(
    () => new Map(query.data?.pages.flatMap((page) => page.companies).map((c) => [c.id, c]) ?? []),
    [query.data],
  );
}

/** The workspace's default currency, or null. */
export function useCrmDefaultCurrency() {
  return useQuery(crmSettingsQuery()).data?.defaultCurrency ?? null;
}

/** The workspace's members as owners to pick: id and the name to show. */
export function useOwners() {
  const members = useMembers().data?.members;
  return useMemo(
    () =>
      (members ?? []).map((m) => ({
        id: m.id,
        name: m.user.name || m.user.email,
        image: m.user.image ?? null,
      })),
    [members],
  );
}

/** Owners and admins may delete a record for good. */
export function useCanDeleteForever() {
  return /\b(owner|admin)\b/.test(useMember().member.role);
}

export function useCrmCompany(id: string, options: { enabled?: boolean } = {}) {
  return useQuery({ ...crmCompanyQuery(id), enabled: options.enabled ?? true });
}

export function useCrmPerson(id: string) {
  return useQuery(crmPersonQuery(id));
}

export function useCrmDeal(id: string) {
  return useQuery(crmDealQuery(id));
}

/** The pipeline, in order. */
export function useCrmStages() {
  return useQuery(crmStagesQuery());
}

/** A record's timeline, newest first; `items` is every loaded page. */
export function useCrmTimeline(kind: CrmRecordKind, id: string) {
  const query = useInfiniteQuery(crmTimelineQuery(kind, id));
  const items = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  return { ...query, items };
}

export function useCrmContracts(where: { company: string } | { deal: string }) {
  const query = useInfiniteQuery(crmContractsQuery(where));
  const contracts = useMemo(
    () => query.data?.pages.flatMap((page) => page.contracts) ?? [],
    [query.data],
  );
  return { ...query, contracts };
}

/** People, companies and deals for a picker; nothing until `q` has a letter. */
export function useCrmFind(q: string) {
  return useQuery(crmFindQuery(q));
}

export function useCreateCompany() {
  return useMutation(createCompanyMutation(useQueryClient()));
}

export function useCreatePerson() {
  return useMutation(createPersonMutation(useQueryClient()));
}

export function useCreateDeal() {
  return useMutation(createDealMutation(useQueryClient()));
}

export function useUpdateCompany() {
  return useMutation(updateCompanyMutation(useQueryClient()));
}

export function useUpdatePerson() {
  return useMutation(updatePersonMutation(useQueryClient()));
}

export function useUpdateDeal() {
  return useMutation(updateDealMutation(useQueryClient()));
}

export function useRemoveDomain() {
  return useMutation(removeDomainMutation(useQueryClient()));
}

/** `mutate({ kind, id, action })`: archive, restore, or delete for good. */
export function useRecordLifecycle() {
  return useMutation(recordLifecycleMutation(useQueryClient()));
}

/** `mutateAsync({ kind, ids, action })` → `{ done, refused }`. */
export function useBulkCrm() {
  return useMutation(bulkMutation(useQueryClient()));
}

export function useAddDomain() {
  return useMutation(addDomainMutation(useQueryClient()));
}

/** `mutate({ dealId, stage })`: optimistic on every deals list, rolled back on failure. */
export function useMoveDeal() {
  return useMutation(moveDealMutation(useQueryClient()));
}

export function useCreateNote() {
  return useMutation(createNoteMutation(useQueryClient()));
}

export function useDeleteNote() {
  return useMutation(deleteNoteMutation(useQueryClient()));
}

/** `mutateAsync({ kind, id })` → `{ nodeId }`: the record's folder, made when missing. */
export function useRecordFolder() {
  return useMutation(recordFolderMutation(useQueryClient()));
}

export function useCreateContract() {
  return useMutation(createContractMutation(useQueryClient()));
}

export function useUpdateContract() {
  return useMutation(updateContractMutation(useQueryClient()));
}

export function useDeleteContract() {
  return useMutation(deleteContractMutation(useQueryClient()));
}

export function usePutStages() {
  return useMutation(putStagesMutation(useQueryClient()));
}
