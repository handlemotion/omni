// Sharing (ADR 0034 decision 4): who a file or folder is shared with and its one link, what was
// shared with the signed-in person, and what a link opens (`/s/<shareId>`), signed in or not.
import {
  infiniteQueryOptions,
  mutationOptions,
  queryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import type { Api } from "@omni/client";
import type { InferResponseType } from "hono/client";
import { api, ApiError, call } from "./api.ts";
import { keys } from "./query-keys.ts";

export type StorageSharing = InferResponseType<
  Api["storage"]["nodes"][":id"]["sharing"]["$get"],
  200
>["sharing"];
export type StorageGrantRole = StorageSharing["people"][number]["role"];
export type StorageLinkAccess = StorageSharing["linkAccess"];
export type SharedWithMeItem = InferResponseType<
  Api["storage"]["shared-with-me"]["$get"],
  200
>["items"][number];
export type StorageLinkPage = InferResponseType<Api["storage"]["shared"][":shareId"]["$get"], 200>;

const PAGE_SIZE = "100";

export const storageSharingQuery = (nodeId: string) =>
  queryOptions({
    queryKey: keys.storageSharing(nodeId),
    queryFn: ({ signal }) =>
      call(api.storage.nodes[":id"].sharing.$get({ param: { id: nodeId } }, { init: { signal } })),
  });

/** Each change answers with the sharing as it is now; the cache takes it as it comes. */
const sharingChanged =
  (client: QueryClient) =>
  ({ sharing }: { sharing: StorageSharing }) =>
    client.setQueryData(keys.storageSharing(sharing.nodeId), { sharing });

/** `mutate({ id, linkAccess })` sets general access; `mutate({ id, reset: true })` a new link. */
export const setLinkMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({
      id,
      ...json
    }: { id: string } & ({ linkAccess: StorageLinkAccess } | { reset: true })) =>
      call(api.storage.nodes[":id"].sharing.link.$put({ param: { id }, json })),
    onSuccess: sharingChanged(client),
  });

/** `mutate({ id, email, role })` adds a person (they get one mail) or changes their role. */
export const putPersonMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, email, role }: { id: string; email: string; role: StorageGrantRole }) =>
      call(
        api.storage.nodes[":id"].sharing.people[":email"].$put({
          param: { id, email },
          json: { role },
        }),
      ),
    onSuccess: sharingChanged(client),
  });

/** `mutate({ id, email })` removes a person; their next request finds nothing. */
export const removePersonMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, email }: { id: string; email: string }) =>
      call(api.storage.nodes[":id"].sharing.people[":email"].$delete({ param: { id, email } })),
    onSuccess: sharingChanged(client),
  });

export const storageSharedWithMeQuery = () =>
  infiniteQueryOptions({
    queryKey: keys.storageSharedWithMe(),
    queryFn: ({ pageParam, signal }) =>
      call(
        api.storage["shared-with-me"].$get(
          { query: { ...(pageParam ? { cursor: pageParam } : {}), limit: PAGE_SIZE } },
          { init: { signal } },
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

/** What `/s/<shareId>` opens: the shared node, or the folder `nodeId` inside it. */
export const storageLinkQuery = (shareId: string, nodeId?: string) =>
  infiniteQueryOptions({
    queryKey: keys.storageLink(shareId, nodeId),
    queryFn: ({ pageParam, signal }) =>
      call(
        api.storage.shared[":shareId"].$get(
          {
            param: { shareId },
            query: {
              ...(nodeId ? { node: nodeId } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
              limit: PAGE_SIZE,
            },
          },
          { init: { signal } },
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    // A link that opens nothing to this reader says so at once: trying again won't open it.
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 3,
  });

/** The link to a shared item, as people open it. */
export const shareUrl = (shareId: string) => `${window.location.origin}/s/${shareId}`;
