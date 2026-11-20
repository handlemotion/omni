import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { STORAGE_LINK_KEY_HEADER, type Api } from "@omni/client";
import { File, Directory, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import type { InferResponseType } from "hono/client";
import { api, ApiError, call } from "./api.ts";
import { config } from "./config.ts";
import { safeName } from "./drive-files.ts";
import { storageHeaders } from "./drive.ts";
import { keys } from "./query-keys.ts";

export type DriveLink = InferResponseType<Api["storage"]["shared"][":shareId"]["$get"], 200>;
export type DriveLinkUpload = NonNullable<DriveLink["uploading"]>[number];

const UPLOADING_POLL_MS = 2_000;

const unlocked = new Map<string, string>();

const keyHeaders = (shareId: string) => {
  const key = unlocked.get(shareId);
  const headers: Record<string, string> = key ? { [STORAGE_LINK_KEY_HEADER]: key } : {};
  return headers;
};

/**
 * What a link opens, a page at a time: the shared item (or `node` inside a shared folder), a
 * folder's contents, whether its files can be downloaded, and files still uploading (on the
 * first page). While something is uploading it is asked again every two seconds, so the page
 * turns into the finished file by itself.
 */
export const useDriveLink = (shareId: string, node?: string) =>
  useInfiniteQuery({
    queryKey: keys.driveLink(shareId, node),
    queryFn: ({ pageParam, signal }) =>
      call(
        api.storage.shared[":shareId"].$get(
          {
            param: { shareId },
            query: { ...(node ? { node } : {}), ...(pageParam ? { cursor: pageParam } : {}) },
          },
          { init: { signal }, headers: keyHeaders(shareId) },
        ),
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: (query) =>
      query.state.data?.pages[0]?.uploading?.length ? UPLOADING_POLL_MS : false,
  });

/** The link, or the item it opens, does not exist (or no longer does): trying again won't help. */
export const isGone = (error: unknown) =>
  error instanceof ApiError && (error.status === 404 || error.status === 410);

/** The link's first page refused for want of its password. */
export const isLocked = (error: unknown) =>
  error instanceof ApiError && error.code === "link_locked";

/** Opens a password-protected link for this run of the app. */
export function useUnlockLink(shareId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (password: string) =>
      call(api.storage.shared[":shareId"].unlock.$post({ param: { shareId }, json: { password } })),
    onSuccess: ({ key }) => {
      unlocked.set(shareId, key);
      return client.invalidateQueries({ queryKey: keys.driveLinkAll(shareId) });
    },
  });
}

const LINK_FILES = new Directory(Paths.cache, "drive-links");

/**
 * A file opened through a link, into the share sheet (Save to Files, AirDrop, another app): a
 * fresh download each time, since a link's file isn't one of the person's own.
 */
export async function shareLinkFile(
  shareId: string,
  file: { id: string; name: string; mimeType: string | null },
) {
  const folder = new Directory(LINK_FILES, file.id);
  if (folder.exists) folder.delete();
  folder.create({ intermediates: true });
  const url = `${config.apiUrl}/api/storage/shared/${encodeURIComponent(shareId)}/files/${encodeURIComponent(file.id)}/content`;
  const headers = { ...(await storageHeaders(null)), ...keyHeaders(shareId) };
  const saved = await File.downloadFileAsync(url, new File(folder, safeName(file.name)), {
    headers,
  });
  await Sharing.shareAsync(saved.uri, file.mimeType ? { mimeType: file.mimeType } : {});
}
