// Storage (ADR 0034): the active workspace's My files and Shared, Trash, usage, and the changes,
// by the member's door or a shared link's. Lists are paged by the server's cursor. Nothing here is realtime in v1: every change refetches the lists.
import {
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import type { Api } from "@omni/client";
import type { InferResponseType } from "hono/client";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";

export type StorageListPage = InferResponseType<Api["storage"]["nodes"]["$get"], 200>;
export type StorageNode = StorageListPage["nodes"][number];
export type StorageFolderView = NonNullable<StorageListPage["folder"]>;
export type StorageSpace = StorageNode["space"];
/** Where a listing, a new folder or an upload goes: a space's root, or inside a folder. */
export type StoragePlace = { space: StorageSpace } | { parentId: string };

// `startup-fetch.ts` asks for a folder's first page at startup with this size too.
const PAGE_SIZE = "100";

/** A folder's contents, folders first, then by name. The first page carries the folder itself. */
export const storageListQuery = (place: StoragePlace) =>
  infiniteQueryOptions({
    queryKey: keys.storageList(place),
    queryFn: ({ pageParam, signal }) =>
      call(
        api.storage.nodes.$get(
          {
            query: {
              ...("parentId" in place ? { parent: place.parentId } : { space: place.space }),
              ...(pageParam ? { cursor: pageParam } : {}),
              limit: PAGE_SIZE,
            },
          },
          { init: { signal } },
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

/** What the member may restore, newest first. */
export const storageTrashQuery = () =>
  infiniteQueryOptions({
    queryKey: keys.storageTrash(),
    queryFn: ({ pageParam, signal }) =>
      call(
        api.storage.trash.$get(
          { query: { ...(pageParam ? { cursor: pageParam } : {}), limit: PAGE_SIZE } },
          { init: { signal } },
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

/** Every change moves rows between lists (a folder, Trash), so all of Storage refetches. */
export const storageChanged = (client: QueryClient) =>
  client.invalidateQueries({ queryKey: keys.storage() });

/**
 * Changes go through one of two doors: the member's own (`shareId` absent), or a shared link's
 * (`/api/storage/shared/:shareId/...`), where an Editor changes what is inside the shared folder.
 * The link door takes places by `parentId` alone: a link has no space.
 */
const sharedDoor = () => api.storage.shared[":shareId"];

/** `mutate({ name, place, shareId? })` makes a folder; a taken name gets a number. */
export const createFolderMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({
      name,
      place,
      shareId,
    }: {
      name: string;
      place: StoragePlace;
      shareId?: string;
    }) =>
      shareId
        ? call(sharedDoor().folders.$post({ param: { shareId }, json: { name, ...place } }))
        : call(api.storage.folders.$post({ json: { name, ...place } })),
    onSuccess: () => storageChanged(client),
  });

/** `mutate({ id, name })` renames; `mutate({ id, place })` moves within the workspace. */
export const changeNodeMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({
      shareId,
      ...change
    }: { id: string; shareId?: string } & ({ name: string } | { place: StoragePlace })) => {
      const json = "name" in change ? { name: change.name } : change.place;
      return shareId
        ? call(sharedDoor().nodes[":id"].$patch({ param: { shareId, id: change.id }, json }))
        : call(api.storage.nodes[":id"].$patch({ param: { id: change.id }, json }));
    },
    onSuccess: () => storageChanged(client),
  });

/** `mutate({ id, shareId? })` moves a file or folder to Trash. */
export const trashNodeMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, shareId }: { id: string; shareId?: string }) =>
      shareId
        ? call(sharedDoor().nodes[":id"].$delete({ param: { shareId, id }, query: {} }))
        : call(api.storage.nodes[":id"].$delete({ param: { id }, query: {} })),
    onSuccess: () => storageChanged(client),
  });

/** `mutate(id)` puts a trashed file or folder back where it was. */
export const restoreNodeMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (id: string) => call(api.storage.nodes[":id"].restore.$post({ param: { id } })),
    onSuccess: () => storageChanged(client),
  });

/** `mutate(id)` deletes something in Trash for good. */
export const deleteForeverMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: (id: string) =>
      call(api.storage.nodes[":id"].$delete({ param: { id }, query: { forever: "1" } })),
    onSuccess: () => storageChanged(client),
  });

/** Bytes stored, the limit and the allowance (`GET /usage`). */
export const storageUsageQuery = () =>
  queryOptions({
    queryKey: keys.storageUsage(),
    queryFn: ({ signal }) => call(api.storage.usage.$get(undefined, { init: { signal } })),
  });

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** "1.4 MB": a byte count in binary units, one decimal under 10 (none when it is .0). */
export function formatBytes(bytes: number) {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit > 0 && value < 10 ? 1 : 0;
  // "1 GB", not "1.0 GB".
  return `${Number(value.toFixed(digits))} ${UNITS[unit]}`;
}
