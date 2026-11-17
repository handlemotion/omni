// A file's comments (ADR 0043 decisions 4 and 5), by the member's door or a shared link's: the
// threads, and adding, editing, resolving and deleting. Comments are not the file's content: a
// change refetches this file's comments only, never the folder lists.
import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import type { Api } from "@omni/client";
import type { InferRequestType, InferResponseType } from "hono/client";
import { api, call } from "./api.ts";
import { keys } from "./query-keys.ts";

export type StorageComments = InferResponseType<
  Api["storage"]["files"][":id"]["comments"]["$get"],
  200
>;
export type StorageComment = StorageComments["comments"][number];
export type StorageCommentAnchor = NonNullable<StorageComment["anchor"]>;
type AddBody = InferRequestType<Api["storage"]["files"][":id"]["comments"]["$post"]>["json"];
type ChangeBody = InferRequestType<
  Api["storage"]["files"][":id"]["comments"][":commentId"]["$patch"]
>["json"];

/** A thread: its first comment and the replies under it, oldest first. */
export interface StorageThread {
  root: StorageComment;
  replies: StorageComment[];
}

const sharedDoor = () => api.storage.shared[":shareId"].files[":id"].comments;
const memberDoor = () => api.storage.files[":id"].comments;

export const storageCommentsQuery = (id: string, shareId?: string) =>
  queryOptions({
    queryKey: keys.storageComments(id),
    queryFn: ({ signal }) =>
      shareId
        ? call(sharedDoor().$get({ param: { shareId, id } }, { init: { signal } }))
        : call(memberDoor().$get({ param: { id } }, { init: { signal } })),
  });

/** The comments grouped into threads, oldest first; `resolved` picks one side. */
export function threadsOf(comments: StorageComment[], resolved: boolean): StorageThread[] {
  const sorted = comments.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  const threads = new Map<string, StorageThread>();
  for (const comment of sorted) {
    if (comment.parentId === null) threads.set(comment.id, { root: comment, replies: [] });
  }
  for (const comment of sorted) {
    if (comment.parentId !== null) threads.get(comment.parentId)?.replies.push(comment);
  }
  return [...threads.values()].filter((thread) => !!thread.root.resolvedAt === resolved);
}

export const commentAuthor = (comment: StorageComment) => comment.authorName ?? "Former member";

const refetch = (client: QueryClient, id: string) =>
  client.invalidateQueries({ queryKey: keys.storageComments(id) });

/** `mutate({ id, shareId?, body })`: a new thread, or with `parentId` in `body` a reply. */
export const addCommentMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({ id, shareId, body }: { id: string; shareId?: string; body: AddBody }) =>
      shareId
        ? call(sharedDoor().$post({ param: { shareId, id }, json: body }))
        : call(memberDoor().$post({ param: { id }, json: body })),
    onSuccess: (_answer, { id }) => refetch(client, id),
  });

/** `mutate({ id, commentId, shareId?, change })`: `{ body }` edits, `{ resolved }` resolves. */
export const changeCommentMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: ({
      id,
      commentId,
      shareId,
      change,
    }: {
      id: string;
      commentId: string;
      shareId?: string;
      change: ChangeBody;
    }) =>
      shareId
        ? call(
            sharedDoor()[":commentId"].$patch({ param: { shareId, id, commentId }, json: change }),
          )
        : call(memberDoor()[":commentId"].$patch({ param: { id, commentId }, json: change })),
    onSuccess: (_answer, { id }) => refetch(client, id),
  });

/** `mutate({ id, commentId, shareId? })` deletes a comment of one's own, a root with its replies. */
export const deleteCommentMutation = (client: QueryClient) =>
  mutationOptions({
    mutationFn: async ({
      id,
      commentId,
      shareId,
    }: {
      id: string;
      commentId: string;
      shareId?: string;
    }) => {
      const response = await (shareId
        ? sharedDoor()[":commentId"].$delete({ param: { shareId, id, commentId } })
        : memberDoor()[":commentId"].$delete({ param: { id, commentId } }));
      if (!response.ok) await call(Promise.resolve(response));
    },
    onSuccess: (_answer, { id }) => refetch(client, id),
  });

/**
 * Where a file is now, for a notification about it: it may have moved since, so it is always
 * asked afresh (`staleTime: 0`).
 */
export const storageNodeQuery = (id: string) =>
  queryOptions({
    queryKey: keys.storageNode(id),
    queryFn: ({ signal }) =>
      call(api.storage.nodes[":id"].$get({ param: { id } }, { init: { signal } })),
    staleTime: 0,
  });
