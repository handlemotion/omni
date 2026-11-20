import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import type { Api } from "@omni/client";
import type { InferResponseType } from "hono/client";
import { api, call } from "./api.ts";
import { settleCrm } from "./crm-cache.ts";
import { keys } from "./query-keys.ts";
import { storageChanged } from "./storage.ts";

/** The two records with files: a company and a deal (the project). */
export type FileRecordKind = "companies" | "deals";

export type CrmFileLink = InferResponseType<
  Api["crm"]["deals"][":id"]["links"]["$get"],
  200
>["links"][number];

const linksKey = (kind: FileRecordKind, id: string) => [...keys.crm(), "links", kind, id] as const;

/** Drive files linked to the record where they live (`docs/spec/crm.md`, "Keep the files"), the ones the reader can open. */
export const crmFileLinksQuery = (kind: FileRecordKind, id: string) =>
  queryOptions({
    queryKey: linksKey(kind, id),
    queryFn: ({ signal }) =>
      call(
        kind === "companies"
          ? api.crm.companies[":id"].links.$get({ param: { id } }, { init: { signal } })
          : api.crm.deals[":id"].links.$get({ param: { id } }, { init: { signal } }),
      ),
    select: (data) => data.links,
  });

/** Links Drive nodes to the record; the record's folder is made too when it had none. */
export const linkFilesMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ kind, id, nodeIds }: { kind: FileRecordKind; id: string; nodeIds: string[] }) =>
      call(
        kind === "companies"
          ? api.crm.companies[":id"].links.$post({ param: { id }, json: { nodeIds } })
          : api.crm.deals[":id"].links.$post({ param: { id }, json: { nodeIds } }),
      ),
    ...settleCrm(client, () => void storageChanged(client)),
  });

/** Drops a link; the file stays where it is in Drive. */
export const unlinkFileMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ kind, id, nodeId }: { kind: FileRecordKind; id: string; nodeId: string }) =>
      call(
        kind === "companies"
          ? api.crm.companies[":id"].links[":nodeId"].$delete({ param: { id, nodeId } })
          : api.crm.deals[":id"].links[":nodeId"].$delete({ param: { id, nodeId } }),
      ),
    ...settleCrm(client),
  });
