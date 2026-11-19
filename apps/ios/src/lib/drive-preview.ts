import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Directory, File, Paths } from "expo-file-system";
import { config } from "./config.ts";
import { folderQuery, storageHeaders, type DriveNode } from "./drive.ts";
import { previewKindOf } from "./file-kind.ts";
import { keys } from "./query-keys.ts";

/** Which bytes a preview shows: a new version of the file is a new copy and a new cache entry. */
export const versionOf = (node: DriveNode) => String(node.contentVersion ?? node.updatedAt);

/** Where a file's bytes are, for a native view that loads them itself (the photo viewer). */
export const contentUrl = (fileId: string) =>
  `${config.apiUrl}/api/storage/files/${encodeURIComponent(fileId)}/content`;

/** The session and workspace headers a native view sends with `contentUrl`. */
export const useStorageHeaders = () =>
  useQuery({ queryKey: keys.storageHeaders(), queryFn: () => storageHeaders(), staleTime: 60_000 });

const safeName = (name: string) => name.replace(/[/\\:]/g, "_").trim() || "File";

async function localCopy(node: DriveNode) {
  const folder = new Directory(Paths.cache, "drive-preview", node.id, versionOf(node));
  const file = new File(folder, safeName(node.name));
  if (!file.exists) {
    folder.create({ idempotent: true, intermediates: true });
    try {
      await File.downloadFileAsync(contentUrl(node.id), file, {
        headers: await storageHeaders(),
        idempotent: true,
      });
    } catch (error) {
      if (file.exists) file.delete();
      throw error;
    }
  }
  return { uri: file.uri, folderUri: folder.uri, file };
}

/**
 * `node` as a file on this phone, under its own name, for the web view: iOS picks how to draw a
 * local file by its extension, where the Worker serves every file as an
 * `application/octet-stream` attachment that a web view only downloads. Kept per version, so
 * opening it again reads the copy.
 */
export const useLocalCopy = (node: DriveNode) =>
  useQuery({
    queryKey: keys.fileCopy(node.id, versionOf(node)),
    queryFn: async () => {
      const { uri, folderUri } = await localCopy(node);
      return { uri, folderUri };
    },
    staleTime: Infinity,
  });

/** A text file's contents, or `binary` when it has NUL bytes, whatever its name says. */
export const useFileText = (node: DriveNode) =>
  useQuery({
    queryKey: keys.fileText(node.id, versionOf(node)),
    queryFn: async () => {
      const { file } = await localCopy(node);
      const text = await file.text();
      return { text, binary: text.slice(0, 8000).includes("\u0000") };
    },
    staleTime: Infinity,
  });

/**
 * The images beside `node` in its folder, in the folder's order, to swipe through. `node` alone
 * when its folder isn't one this member can list (a file shared with them on its own); null
 * while the folder loads, since the viewer opens on `node`'s page of the list.
 */
export function useFolderImages(node: DriveNode | undefined) {
  const place = node?.parentId ? { parent: node.parentId } : { space: node?.space ?? "personal" };
  const folder = useInfiniteQuery({ ...folderQuery(place), enabled: !!node });
  if (!node || folder.isPending) return null;
  const images = (folder.data ?? []).filter(
    (one) => one.kind === "file" && !one.trashedAt && previewKindOf(one) === "image",
  );
  return images.some((one) => one.id === node.id) ? images : [node];
}
