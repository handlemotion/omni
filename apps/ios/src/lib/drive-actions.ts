import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ErrorCode, Member } from "@omni/client";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { Alert } from "react-native";
import { ApiError, api, call } from "./api.ts";
import { config } from "./config.ts";
import { driveNodeChanged, driveNodeRemoved } from "./drive-cache.ts";
import { storageHeaders, type DriveNode } from "./drive.ts";
import { keys } from "./query-keys.ts";
import { cacheEpoch } from "./workspace-id.ts";

/** Where a new folder or an upload goes: a space's top, or inside a folder. */
export type DrivePlace = { space: "personal" | "shared" } | { parentId: string };

/** Where `node` is listed: inside its folder, or at its space's top. */
export const placeOf = (node: DriveNode) =>
  (node.parentId ? { parentId: node.parentId } : { space: node.space }) satisfies DrivePlace;

/** What a new folder is called when it is left unnamed, as on the web. */
export const NEW_FOLDER_NAME = "Untitled folder";

const BY_CODE: Partial<Record<ErrorCode, string>> = {
  storage_full: "Storage is full",
  billing_inactive: "This workspace is read-only",
  file_too_large: "That file is too large",
  invalid_name: "That name can't be used",
  name_taken: "That name is taken",
  forbidden: "You can't change this",
  not_found: "That's no longer here",
  too_deep: "Folders can't nest that deep",
  cycle: "A folder can't move into itself",
  parent_trashed: "Its folder is in Trash",
  invalid_email: "That isn't an email address",
  locked: "That file is locked",
  rate_limited: "Too many at once. Try again in a minute",
};

const FINAL = new Set<string>(["storage_full", "billing_inactive", "file_too_large", "locked"]);

const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : undefined);

/** Why `error` refused the action, or `fallback`: the web's `storageErrorText`. */
export function driveErrorText(error: unknown, fallback: string) {
  const code = codeOf(error);
  return (code && BY_CODE[code as ErrorCode]) || fallback;
}

/** The web's toast, as a native alert. */
export const driveErrorAlert = (fallback: string) => (error: unknown) =>
  Alert.alert(driveErrorText(error, fallback));

/** Whether trying an upload again may work: anything but a refusal that would repeat. */
export const canRetryUpload = (error: unknown) => {
  const code = codeOf(error);
  return !code || !FINAL.has(code);
};

/** The member the app is signed in as here: their id and role decide who may trash what. */
export const useMe = () =>
  useQuery({
    queryKey: keys.me(),
    queryFn: ({ signal }) => call(api.me.$get(undefined, { init: { signal } })),
    staleTime: 5 * 60_000,
  });

/** The web's rule for Move to trash: your own files, anything you made, or a manager. */
export function canTrash(node: DriveNode, me: Pick<Member, "id" | "role"> | undefined) {
  if (node.space === "personal") return true;
  if (!me) return false;
  return /\b(owner|admin)\b/.test(me.role) || node.createdByMemberId === me.id;
}

/** One file or folder, as `GET /nodes/:id` answers it: the preview's title and details. */
export const useNode = (id: string) =>
  useQuery({
    queryKey: keys.driveNode(id),
    queryFn: ({ signal }) =>
      call(api.storage.nodes[":id"].$get({ param: { id } }, { init: { signal } })),
  });

const began = () => ({ epoch: cacheEpoch() });
const current = (start: { epoch: number } | undefined) => start?.epoch === cacheEpoch();

/** `mutate({ name, place })` makes a folder; a taken name gets a number. */
export function useCreateFolder() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ name, place }: { name: string; place: DrivePlace }) =>
      call(api.storage.folders.$post({ json: { name, ...place } })),
    onMutate: began,
    onSuccess: ({ node }, _, start) => current(start) && driveNodeChanged(client, node),
  });
}

/** `mutate({ id, name })` renames; `mutate({ id, place })` moves within the workspace. */
export function useChangeNode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...change }: { id: string } & ({ name: string } | { place: DrivePlace })) =>
      call(
        api.storage.nodes[":id"].$patch({
          param: { id },
          json: "name" in change ? { name: change.name } : change.place,
        }),
      ),
    onMutate: began,
    onSuccess: ({ node }, _, start) => current(start) && driveNodeChanged(client, node),
  });
}

/** `mutate(id)` moves a file or folder to Trash. */
export function useTrashNode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      call(api.storage.nodes[":id"].$delete({ param: { id }, query: {} })),
    onMutate: began,
    onSuccess: (_, id, start) => current(start) && driveNodeRemoved(client, id),
  });
}

/** `mutate(id)` puts a trashed file or folder back where it was. */
export function useRestoreNode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => call(api.storage.nodes[":id"].restore.$post({ param: { id } })),
    onMutate: began,
    onSuccess: ({ node }, _, start) => current(start) && driveNodeChanged(client, node),
  });
}

/** `mutate(id)` deletes something in Trash for good. */
export function useDeleteForever() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      call(api.storage.nodes[":id"].$delete({ param: { id }, query: { forever: "1" } })),
    onMutate: began,
    onSuccess: (_, id, start) => current(start) && driveNodeRemoved(client, id),
  });
}

/** Asks for a new name with the system prompt, then renames (the web's Rename dialog). */
export function promptRename(
  node: Pick<DriveNode, "id" | "name">,
  rename: ReturnType<typeof useChangeNode>["mutate"],
) {
  Alert.prompt(
    "Rename",
    undefined,
    [
      { text: "Cancel", style: "cancel" },
      {
        text: "Rename",
        isPreferred: true,
        onPress: (value?: string) => {
          const name = value?.trim();
          if (!name || name === node.name) return;
          rename({ id: node.id, name }, { onError: driveErrorAlert("It was not renamed") });
        },
      },
    ],
    "plain-text",
    node.name,
  );
}

/** Asks before deleting from Trash for good, in the web's words. */
export function confirmDeleteForever(
  node: Pick<DriveNode, "id" | "name">,
  remove: ReturnType<typeof useDeleteForever>["mutate"],
) {
  Alert.alert(`Delete “${node.name}” forever?`, undefined, [
    { text: "Cancel", style: "cancel" },
    {
      text: "Delete forever",
      style: "destructive",
      onPress: () => remove(node.id, { onError: driveErrorAlert("It was not deleted") }),
    },
  ]);
}

async function shareDownload(path: string, name: string, mimeType: string | null) {
  const headers = await storageHeaders();
  const folder = new Directory(Paths.cache, "drive", String(Date.now()));
  folder.create({ intermediates: true, idempotent: true });
  const file = await File.downloadFileAsync(
    `${config.apiUrl}/api/storage/${path}`,
    new File(folder, name),
    { headers, idempotent: true },
  );
  await Sharing.shareAsync(file.uri, mimeType ? { mimeType } : {});
}

/** A file's bytes in the share sheet. Fails with an alert, in the web's words. */
export const shareFile = (node: Pick<DriveNode, "id" | "name" | "mimeType">) =>
  shareDownload(`files/${encodeURIComponent(node.id)}/content`, node.name, node.mimeType).catch(
    () => Alert.alert("It was not downloaded"),
  );

/** A kept version's bytes in the share sheet. */
export const shareVersion = (
  node: Pick<DriveNode, "id" | "name" | "mimeType">,
  versionId: string,
) =>
  shareDownload(
    `files/${encodeURIComponent(node.id)}/versions/${encodeURIComponent(versionId)}/content`,
    node.name,
    node.mimeType,
  ).catch(() => Alert.alert("It was not downloaded"));
