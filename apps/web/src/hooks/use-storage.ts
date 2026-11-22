import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  changeNodeMutation,
  createFolderMutation,
  deleteForeverMutation,
  restoreNodeMutation,
  storageListQuery,
  storageTrashQuery,
  storageUsageQuery,
  trashNodeMutation,
  type StorageNode,
  type StoragePlace,
  type DriveRoot,
} from "../lib/storage.ts";
import { keys } from "../lib/query-keys.ts";
import {
  createTeamspaceMutation,
  deleteTeamspaceMutation,
  joinTeamspaceMutation,
  putTeamspaceMemberMutation,
  storageTeamspaceMembersQuery,
  storageTeamspacesQuery,
  updateTeamspaceMutation,
  type StorageTeamspace,
} from "../lib/storage-teamspaces.ts";
import {
  linkUploading,
  putPersonMutation,
  removePersonMutation,
  setLinkMutation,
  setUploadLinkMutation,
  storageUploadSharingQuery,
  storageLinkQuery,
  storageSharedWithMeQuery,
  storageSharingQuery,
  type StorageLinkUpload,
} from "../lib/storage-sharing.ts";
import {
  addUploads,
  removeUpload,
  retryUpload,
  uploadsStore,
  type UploadTarget,
} from "../lib/storage-uploads.ts";
import {
  addCommentMutation,
  changeCommentMutation,
  deleteCommentMutation,
  storageCommentsQuery,
  storageNodeQuery,
} from "../lib/storage-comments.ts";
import type { Picked } from "../lib/storage-upload-tree.ts";
import { restoreVersionMutation, storageVersionsQuery } from "../lib/storage-versions.ts";
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

/**
 * Starts reading a folder's first page as the pointer rests on its row, so opening it finds it
 * cached. A card's stack already reads it as the card nears the screen; a fresh page is not
 * asked again.
 */
export function usePrefetchFolder() {
  const client = useQueryClient();
  return useCallback(
    (node: StorageNode) => {
      if (node.kind === "folder")
        void client.prefetchInfiniteQuery(storageListQuery({ parentId: node.id }));
    },
    [client],
  );
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
 * What to do with uploads: `upload(files, { place, shareId? }, onFailed)` queues files (or a
 * dropped or picked folder's `Picked`); a failed one stays listed until `retry(id)` (it resumes)
 * or `remove(id)`. It doesn't re-render with their progress: `useUploadItems` does.
 */
export function useUploads() {
  const client = useQueryClient();
  useSession();
  const upload = useCallback(
    (
      files: File[] | Picked,
      target: UploadTarget,
      onFailed: (name: string, error: unknown) => void,
    ) => addUploads(client, files, target, onFailed),
    [client],
  );
  return { upload, retry: retryUpload, remove: removeUpload };
}

/** The uploads in progress or failed, re-rendered about four times a second while they move. */
export function useUploadItems() {
  return useSyncExternalStore(uploadsStore.subscribe, uploadsStore.get);
}

/** A file's current content and the versions it replaced (whoever may edit the file only). */
export function useStorageVersions(nodeId: string, shareId?: string, enabled = true) {
  return useQuery({ ...storageVersionsQuery(nodeId, shareId), enabled });
}

/** `mutate({ id, versionId, shareId? })` makes a kept version the file's content again. */
export function useRestoreVersion() {
  return useMutation(restoreVersionMutation(useQueryClient()));
}

/** A file's comments (a member, an Editor or a Commenter only). */
export function useStorageComments(nodeId: string, shareId?: string, enabled = true) {
  return useQuery({ ...storageCommentsQuery(nodeId, shareId), enabled });
}

/**
 * Asks where a file is now (its space and folder), or null when the reader no longer reaches it.
 * For a notification that leads to a file that may have moved.
 */
export function useFilePlace() {
  const client = useQueryClient();
  return useCallback(
    (id: string) =>
      client
        .fetchQuery(storageNodeQuery(id))
        .then(({ node }) => ({ space: node.space, folderId: node.parentId }))
        .catch(() => null),
    [client],
  );
}

/** `mutate({ id, shareId?, body })` starts a thread, or replies with `parentId`. */
export function useAddComment() {
  return useMutation(addCommentMutation(useQueryClient()));
}

/** `mutate({ id, commentId, shareId?, change })` edits (`body`) or resolves (`resolved`). */
export function useChangeComment() {
  return useMutation(changeCommentMutation(useQueryClient()));
}

/** `mutate({ id, commentId, shareId? })` deletes one's own comment. */
export function useDeleteComment() {
  return useMutation(deleteCommentMutation(useQueryClient()));
}

/** Bytes stored, the limit and the allowance, and whether uploads are blocked. */
export function useStorageUsage() {
  return useQuery(storageUsageQuery());
}

/** Who a file or folder is shared with, and its link (members who can write it only). */
export function useStorageSharing(nodeId: string) {
  return useQuery(storageSharingQuery(nodeId));
}

/** The sharing of a new file still uploading, by its upload id. */
export function useUploadSharing(uploadId: string) {
  return useQuery(storageUploadSharingQuery(uploadId));
}

/**
 * `mutate({ id, linkAccess })` sets general access; `mutate({ id, reset: true })` a new link.
 * With `uploading`, `id` is a file still uploading.
 */
export function useSetStorageLink(uploading = false) {
  const client = useQueryClient();
  return useMutation(uploading ? setUploadLinkMutation(client) : setLinkMutation(client));
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

const UPLOADING_POLL_MS = 2000;

/**
 * The files still uploading behind a link, from `initial` (the link's first page), polled while
 * any are. Each time one finishes, the link is read again so it shows as a file.
 */
export function useLinkUploading(
  shareId: string,
  nodeId: string | undefined,
  initial: StorageLinkUpload[] | undefined,
) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: keys.storageLinkUploading(shareId, nodeId),
    queryFn: ({ signal }) => linkUploading(shareId, nodeId, signal),
    initialData: initial ? { uploading: initial } : undefined,
    enabled: (initial?.length ?? 0) > 0,
    refetchInterval: (state) => (state.state.data?.uploading.length ? UPLOADING_POLL_MS : false),
  });
  const uploading = useMemo(() => query.data?.uploading ?? [], [query.data]);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    const now = new Set(uploading.map((upload) => upload.id));
    const finished = [...seen.current].some((id) => !now.has(id));
    seen.current = now;
    if (finished) void client.invalidateQueries({ queryKey: keys.storageLink(shareId, nodeId) });
  }, [client, nodeId, shareId, uploading]);
  return uploading;
}

/** The workspace's teamspaces the member reaches; empty until they load. */
export function useTeamspaces() {
  const query = useQuery(storageTeamspacesQuery());
  return { teamspaces: query.data ?? [], isPending: query.isPending };
}

/** A drive the member can browse, with its name. */
export interface DriveEntry {
  drive: DriveRoot;
  label: string;
  teamspace?: StorageTeamspace | undefined;
}

const LEGACY_LABEL = { personal: "Personal", shared: "Team" } as const;

/** The drives the member can browse: their teamspaces, then Shared in a company, then My files. */
export function useDrives() {
  const hasShared = useHasSharedFiles();
  const { teamspaces, isPending } = useTeamspaces();
  const legacy = hasShared ? (["shared", "personal"] as const) : (["personal"] as const);
  const drives: DriveEntry[] = [
    ...teamspaces.map((teamspace) => ({
      drive: { teamspaceId: teamspace.id },
      label: teamspace.name,
      teamspace,
    })),
    ...legacy.map((space) => ({ drive: { space }, label: LEGACY_LABEL[space] })),
  ];
  return { drives, isPending };
}

/** A teamspace's name, once the list has it. */
export function useTeamspaceName(teamspaceId: string | undefined) {
  const { teamspaces } = useTeamspaces();
  return teamspaces.find((teamspace) => teamspace.id === teamspaceId)?.name;
}

/** `mutate({ name, private, memberIds })`. */
export function useCreateTeamspace() {
  return useMutation(createTeamspaceMutation(useQueryClient()));
}

/** `mutate({ id, name?, private? })`. */
export function useUpdateTeamspace() {
  return useMutation(updateTeamspaceMutation(useQueryClient()));
}

/** `mutate(id)`: joins an open teamspace. */
export function useJoinTeamspace() {
  return useMutation(joinTeamspaceMutation(useQueryClient()));
}

/** `mutate(id)`. */
export function useDeleteTeamspace() {
  return useMutation(deleteTeamspaceMutation(useQueryClient()));
}

/** `mutate({ id, memberId, role })`; `role: null` takes them out. */
export function usePutTeamspaceMember() {
  return useMutation(putTeamspaceMemberMutation(useQueryClient()));
}

/** Who is in a teamspace, owners first. */
export function useTeamspaceMembers(teamspaceId: string) {
  return useQuery(storageTeamspaceMembersQuery(teamspaceId));
}
