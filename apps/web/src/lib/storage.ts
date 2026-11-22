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
import {
  storageFolderMade,
  storageListsPut,
  storageNodeAhead,
  storageNodeChanged,
  storageNodeRemoved,
} from "./storage-cache.ts";

export type StorageListPage = InferResponseType<Api["storage"]["nodes"]["$get"], 200>;
export type StorageNode = StorageListPage["nodes"][number];
export type StorageFolderView = NonNullable<StorageListPage["folder"]>;
export type StorageSpace = Exclude<StorageNode["space"], "teamspace">;
/** Where a listing, a new folder or an upload goes: a drive's root, or inside a folder. */
export type StoragePlace = { space: StorageSpace } | { teamspaceId: string } | { parentId: string };

/** The query that lists a place: `parent`, `teamspace` or `space`. */
export const placeQuery = (place: StoragePlace) =>
  "parentId" in place
    ? { parent: place.parentId }
    : "teamspaceId" in place
      ? { teamspace: place.teamspaceId }
      : { space: place.space };

/** A drive's root: My files, Shared, or a teamspace. */
export type DriveRoot = { space: StorageSpace } | { teamspaceId: string };

/** The drive a node is in. */
export const driveOf: (node: Pick<StorageNode, "space" | "teamspaceId">) => DriveRoot = (node) =>
  node.teamspaceId
    ? { teamspaceId: node.teamspaceId }
    : { space: node.space === "personal" ? "personal" : "shared" };

/** A drive's key: two drives are one when their keys match. */
export const driveKey = (drive: DriveRoot) =>
  "teamspaceId" in drive ? `teamspace:${drive.teamspaceId}` : drive.space;

const pageSize = (cursor: string | null) => (cursor ? "200" : "100");

/** A space's sidebar glyph, as `PATCH /teamspaces/:id` takes it. */
export type StorageSpaceIcon = NonNullable<
  NonNullable<Parameters<Api["storage"]["teamspaces"][":id"]["$patch"]>[0]["json"]>["icon"]
>;

/** A folder's contents, folders first, then by name. The first page carries the folder itself. */
export const storageListQuery = (place: StoragePlace) =>
  infiniteQueryOptions({
    queryKey: keys.storageList(place),
    queryFn: ({ pageParam, signal }) =>
      call(
        api.storage.nodes.$get(
          {
            query: {
              ...placeQuery(place),
              ...(pageParam ? { cursor: pageParam } : {}),
              limit: pageSize(pageParam),
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
          {
            query: {
              ...(pageParam ? { cursor: pageParam } : {}),
              limit: pageSize(pageParam),
            },
          },
          { init: { signal } },
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

/**
 * A change whose answer does not say what moved (a link's door, a version, a signature): all of
 * Storage refetches.
 */
export const storageChanged = (client: QueryClient) =>
  client.invalidateQueries({ queryKey: keys.storage() });

const sharedDoor = () => api.storage.shared[":shareId"];

/** `mutate({ name, place, shareId? })` makes a folder; a taken name gets a number. */
export const createFolderMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
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
        ? call(
            sharedDoor().folders.$post({
              param: { shareId },
              json: { name, ...place },
            }),
          )
        : call(api.storage.folders.$post({ json: { name, ...place } })),
    onSuccess: ({ node }, { shareId }) => {
      if (shareId) return storageChanged(client);
      storageFolderMade(client, node);
      return storageNodeChanged(client, node);
    },
  });

/** `mutate({ id, name })` renames; `mutate({ id, place })` moves within the workspace. */
export const changeNodeMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({
      shareId,
      ...change
    }: { id: string; shareId?: string } & ({ name: string } | { place: StoragePlace })) => {
      const json = "name" in change ? { name: change.name } : change.place;
      return shareId
        ? call(
            sharedDoor().nodes[":id"].$patch({
              param: { shareId, id: change.id },
              json,
            }),
          )
        : call(api.storage.nodes[":id"].$patch({ param: { id: change.id }, json }));
    },
    onSuccess: ({ node }, change) =>
      change.shareId ? storageChanged(client) : storageNodeChanged(client, node),
  });

/** `mutate({ id, shareId? })` moves a file or folder to Trash. */
export const trashNodeMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({ id, shareId }: { id: string; shareId?: string }) =>
      shareId
        ? call(
            sharedDoor().nodes[":id"].$delete({
              param: { shareId, id },
              query: {},
            }),
          )
        : call(api.storage.nodes[":id"].$delete({ param: { id }, query: {} })),
    onMutate: async ({ id, shareId }) =>
      shareId ? undefined : { held: await storageNodeAhead(client, id) },
    onError: (_error, _trash, context) => storageListsPut(client, context?.held),
    onSuccess: (_, { id, shareId }) =>
      shareId ? storageChanged(client) : storageNodeRemoved(client, id),
  });

/** `mutate(id)` puts a trashed file or folder back where it was. */
export const restoreNodeMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (id: string) => call(api.storage.nodes[":id"].restore.$post({ param: { id } })),
    onSuccess: ({ node }) => storageNodeChanged(client, node),
  });

/** `mutate(id)` deletes something in Trash for good. */
export const deleteForeverMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: (id: string) =>
      call(
        api.storage.nodes[":id"].$delete({
          param: { id },
          query: { forever: "1" },
        }),
      ),
    onMutate: async (id) => ({ held: await storageNodeAhead(client, id) }),
    onError: (_error, _id, context) => storageListsPut(client, context?.held),
    onSuccess: (_, id) => storageNodeRemoved(client, id),
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
  return `${Number(value.toFixed(digits))} ${UNITS[unit]}`;
}
