import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, call } from "./api.ts";
import { crmChanged } from "./crm-mutations.ts";
import { keys } from "./query-keys.ts";

/** The two records with files: a company and a deal (the project). */
export type FileRecordKind = "companies" | "deals";

/** Drive files linked to the record where they live (`docs/spec/crm.md`, "Keep the files"), the ones the reader can open. */
export const useFileLinks = (kind: FileRecordKind, id: string) =>
  useQuery({
    queryKey: [...keys.crmAll(), "links", kind, id],
    queryFn: ({ signal }) =>
      call(
        kind === "companies"
          ? api.crm.companies[":id"].links.$get({ param: { id } }, { init: { signal } })
          : api.crm.deals[":id"].links.$get({ param: { id } }, { init: { signal } }),
      ),
    select: (data) => data.links.map((link) => link.node),
  });

/** Finds or makes the record's folder in Shared and answers its node id, for an upload. */
export function useRecordFolder() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, id }: { kind: FileRecordKind; id: string }) =>
      call(
        kind === "companies"
          ? api.crm.companies[":id"].folder.$post({ param: { id } })
          : api.crm.deals[":id"].folder.$post({ param: { id } }),
      ),
    onSettled: () => crmChanged(client),
  });
}

/** Links Drive nodes to the record where they are; its folder is made too when it had none. */
export function useLinkFiles() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, id, nodeIds }: { kind: FileRecordKind; id: string; nodeIds: string[] }) =>
      call(
        kind === "companies"
          ? api.crm.companies[":id"].links.$post({ param: { id }, json: { nodeIds } })
          : api.crm.deals[":id"].links.$post({ param: { id }, json: { nodeIds } }),
      ),
    onSettled: () =>
      Promise.all([crmChanged(client), client.invalidateQueries({ queryKey: keys.driveAll() })]),
  });
}

/** Drops a link; the file stays where it is in Drive. */
export function useUnlinkFile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, id, nodeId }: { kind: FileRecordKind; id: string; nodeId: string }) =>
      call(
        kind === "companies"
          ? api.crm.companies[":id"].links[":nodeId"].$delete({ param: { id, nodeId } })
          : api.crm.deals[":id"].links[":nodeId"].$delete({ param: { id, nodeId } }),
      ),
    onSettled: () => crmChanged(client),
  });
}
