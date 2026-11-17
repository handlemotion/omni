// A file's versions (ADR 0043 decision 1), by the member's door or a shared link's: the current
// content and what it replaced, a version's download, and the restore. A new version is an
// upload (`storage-upload.ts`, with `replaces`).
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import type { Api } from "@omni/client";
import type { InferResponseType } from "hono/client";
import { api, call } from "./api.ts";
import { withWorkspace } from "./current-workspace.ts";
import { keys } from "./query-keys.ts";
import { storageChanged } from "./storage.ts";

export type StorageVersions = InferResponseType<
  Api["storage"]["files"][":id"]["versions"]["$get"],
  200
>;
export type StorageVersion = StorageVersions["versions"][number];

const sharedDoor = () => api.storage.shared[":shareId"].files[":id"].versions;
const memberDoor = () => api.storage.files[":id"].versions;

/** Listed under `storage`, so every change to Storage (a new version, a restore) refetches it. */
export const storageVersionsQuery = (id: string, shareId?: string) =>
  queryOptions({
    queryKey: keys.storageVersions(id),
    queryFn: ({ signal }) =>
      shareId
        ? call(sharedDoor().$get({ param: { shareId, id } }, { init: { signal } }))
        : call(memberDoor().$get({ param: { id } }, { init: { signal } })),
  });

/** A kept version's bytes: always a download, like the file's own. */
export function storageVersionUrl(id: string, versionId: string, shareId?: string) {
  if (shareId) {
    return sharedDoor()
      [":versionId"].content.$url({ param: { shareId, id, versionId } })
      .toString();
  }
  // Downloads and previews load it themselves, with no header: the URL names the workspace.
  return withWorkspace(
    memberDoor()[":versionId"].content.$url({ param: { id, versionId } }).toString(),
  );
}

/** `mutate({ id, versionId, shareId? })` makes a kept version the file's content again. */
export const restoreVersionMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ id, versionId, shareId }: { id: string; versionId: string; shareId?: string }) =>
      shareId
        ? call(sharedDoor()[":versionId"].restore.$post({ param: { shareId, id, versionId } }))
        : call(memberDoor()[":versionId"].restore.$post({ param: { id, versionId } })),
    onSuccess: () => storageChanged(client),
  });
