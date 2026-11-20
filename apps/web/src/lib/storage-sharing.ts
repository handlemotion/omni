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
export type StorageLinkUpload = NonNullable<StorageLinkPage["uploading"]>[number];

const PAGE_SIZE = "100";

export const storageSharingQuery = (nodeId: string) =>
  queryOptions({
    queryKey: keys.storageSharing(nodeId),
    queryFn: ({ signal }) =>
      call(api.storage.nodes[":id"].sharing.$get({ param: { id: nodeId } }, { init: { signal } })),
  });

/** The sharing of a new file still uploading, by its upload id (which the file keeps). */
export const storageUploadSharingQuery = (uploadId: string) =>
  queryOptions({
    queryKey: keys.storageSharing(uploadId),
    queryFn: ({ signal }) =>
      call(
        api.storage.uploads[":id"].sharing.$get({ param: { id: uploadId } }, { init: { signal } }),
      ),
  });

const sharingChanged =
  (client: QueryClient) =>
  ({ sharing }: { sharing: StorageSharing }) =>
    client.setQueryData(keys.storageSharing(sharing.nodeId), { sharing });

/** A change to a link's settings: expiry (null: never), password (null removes it), downloads. */
export type StorageLinkChange = {
  expiresAt?: string | null;
  password?: string | null;
  downloads?: boolean;
};

/**
 * `mutate({ id, linkAccess })` sets general access, `mutate({ id, reset: true })` makes a new
 * link, and `mutate({ id, ...change })` changes its settings.
 */
export const setLinkMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({
      id,
      ...json
    }: { id: string } & (
      | { linkAccess: StorageLinkAccess }
      | { reset: true }
      | StorageLinkChange
    )) => call(api.storage.nodes[":id"].sharing.link.$put({ param: { id }, json })),
    onSuccess: sharingChanged(client),
  });

/** `setLinkMutation` for a new file still uploading, by its upload id. */
export const setUploadLinkMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
    mutationFn: ({
      id,
      ...json
    }: { id: string } & (
      | { linkAccess: StorageLinkAccess }
      | { reset: true }
      | StorageLinkChange
    )) => call(api.storage.uploads[":id"].sharing.link.$put({ param: { id }, json })),
    onSuccess: sharingChanged(client),
  });

/** `mutate({ id, email, role })` adds a person (they get one mail) or changes their role. */
export const putPersonMutation = (client: QueryClient) =>
  mutationOptions({
    meta: { handlesError: true },
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
    meta: { handlesError: true },
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
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 3,
  });

/** The files still uploading behind a link: the linked file itself, or those in `nodeId`. */
export const linkUploading = (shareId: string, nodeId?: string, signal?: AbortSignal) =>
  call(
    api.storage.shared[":shareId"].uploading.$get(
      { param: { shareId }, query: nodeId ? { node: nodeId } : {} },
      { init: signal ? { signal } : {} },
    ),
  );

/** Unlocks a password link for this browser: the Worker sets a cookie scoped to the link. */
export const unlockLink = (shareId: string, password: string) =>
  call(api.storage.shared[":shareId"].unlock.$post({ param: { shareId }, json: { password } }));

/** The link to a shared item, as people open it. */
export const shareUrl = (shareId: string) => `${window.location.origin}/s/${shareId}`;
