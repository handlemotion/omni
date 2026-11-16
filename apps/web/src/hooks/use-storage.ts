// Storage (ADR 0034): a folder's contents, Trash, the changes, and uploads.
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  changeNodeMutation,
  createFolderMutation,
  deleteForeverMutation,
  restoreNodeMutation,
  storageListQuery,
  storageTrashQuery,
  storageUsageQuery,
  trashNodeMutation,
  type StoragePlace,
} from "../lib/storage.ts";
import {
  putPersonMutation,
  removePersonMutation,
  setLinkMutation,
  storageLinkQuery,
  storageSharedWithMeQuery,
  storageSharingQuery,
} from "../lib/storage-sharing.ts";
import { addUploads, removeUpload, retryUpload, uploadsStore } from "../lib/storage-uploads.ts";
import { useSession } from "./use-session.ts";
import { useCurrentWorkspace } from "./use-workspaces.ts";

/**
 * A folder's contents (a space's root, or a folder by id), folders first. `nodes` is every loaded
 * page flattened; `folder` is the folder itself with its `path`, null at a root.
 */
export function useStorageList(place: StoragePlace, options: { enabled?: boolean } = {}) {
  const query = useInfiniteQuery({ ...storageListQuery(place), enabled: options.enabled ?? true });
  const nodes = useMemo(() => query.data?.pages.flatMap((page) => page.nodes) ?? [], [query.data]);
  return { ...query, nodes, folder: query.data?.pages[0]?.folder ?? null };
}

/** What you may restore from Trash, newest first. */
export function useStorageTrash() {
  const query = useInfiniteQuery(storageTrashQuery());
  const nodes = useMemo(() => query.data?.pages.flatMap((page) => page.nodes) ?? [], [query.data]);
  return { ...query, nodes };
}

/** True in a company workspace: only those have Shared (a Personal space has My files alone). */
export function useHasSharedFiles() {
  const active = useCurrentWorkspace();
  return !!active && active.kind !== "personal";
}

/** `mutate({ name, place })`. */
export function useCreateFolder() {
  return useMutation(createFolderMutation(useQueryClient()));
}

/** `mutate({ id, name })` renames; `mutate({ id, place })` moves. */
export function useChangeNode() {
  return useMutation(changeNodeMutation(useQueryClient()));
}

/** `mutate({ id, shareId? })` moves it to Trash. */
export function useTrashNode() {
  return useMutation(trashNodeMutation(useQueryClient()));
}

/** `mutate(id)` restores it from Trash. */
export function useRestoreNode() {
  return useMutation(restoreNodeMutation(useQueryClient()));
}

/** `mutate(id)` deletes it from Trash for good. */
export function useDeleteForever() {
  return useMutation(deleteForeverMutation(useQueryClient()));
}

/**
 * The uploads in progress and what to do with them. `upload(files, { place, shareId? }, onFailed)` queues
 * files; a failed one stays in `uploads` until `retry(id)` (it resumes) or `remove(id)`.
 */
export function useUploads() {
  const client = useQueryClient();
  // Each upload is bound to the session it is queued under (`storage-uploads.ts`): keep it
  // cached here too, on the link page outside the app shell.
  useSession();
  const uploads = useSyncExternalStore(uploadsStore.subscribe, uploadsStore.get);
  const upload = useCallback(
    (
      files: File[],
      target: { place: StoragePlace; shareId?: string | undefined },
      onFailed: (name: string, error: unknown) => void,
    ) => addUploads(client, files, target, onFailed),
    [client],
  );
  return { uploads, upload, retry: retryUpload, remove: removeUpload };
}

/** Bytes stored, the limit and the allowance, and whether uploads are blocked. */
export function useStorageUsage() {
  return useQuery(storageUsageQuery());
}

/** Who a file or folder is shared with, and its link (members who can write it only). */
export function useStorageSharing(nodeId: string) {
  return useQuery(storageSharingQuery(nodeId));
}

/** `mutate({ id, linkAccess })` sets general access; `mutate({ id, reset: true })` a new link. */
export function useSetStorageLink() {
  return useMutation(setLinkMutation(useQueryClient()));
}

/** `mutate({ id, email, role })` adds a person or changes their role. */
export function usePutStoragePerson() {
  return useMutation(putPersonMutation(useQueryClient()));
}

/** `mutate({ id, email })` removes a person. */
export function useRemoveStoragePerson() {
  return useMutation(removePersonMutation(useQueryClient()));
}

/** What was shared with the signed-in person, in any workspace, newest first. */
export function useSharedWithMe() {
  const query = useInfiniteQuery(storageSharedWithMeQuery());
  const items = useMemo(() => query.data?.pages.flatMap((page) => page.items) ?? [], [query.data]);
  return { ...query, items };
}

/**
 * What a link opens: `item` (the shared node, or the folder `nodeId` inside it, with its `path`
 * and the reader's `role`) and, for a folder, `nodes`.
 */
export function useStorageLink(
  shareId: string,
  nodeId?: string,
  options: { enabled?: boolean } = {},
) {
  const query = useInfiniteQuery({
    ...storageLinkQuery(shareId, nodeId),
    enabled: options.enabled ?? true,
  });
  const nodes = useMemo(() => query.data?.pages.flatMap((page) => page.nodes) ?? [], [query.data]);
  return { ...query, nodes, item: query.data?.pages[0]?.item };
}
