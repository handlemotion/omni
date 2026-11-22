import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ApiError, api } from "./api.ts";
import { config } from "./config.ts";
import { localFile, type FileSource } from "./drive-files.ts";
import { folderQuery, storageHeaders, type DriveNode } from "./drive.ts";
import { previewKindOf } from "./file-kind.ts";
import { keys } from "./query-keys.ts";

export { contentUrl } from "./drive-files.ts";

/** The most of a text file its preview reads: the start of a larger one. */
export const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;

/** Which bytes a preview shows: a new version of the file is a new copy and a new cache entry. */
export const versionOf = (node: DriveNode) => String(node.contentVersion ?? node.updatedAt);

/** `node`'s current bytes, as `localFile` names them. */
export const sourceOf = (
  node: Pick<DriveNode, "id" | "name" | "size" | "contentVersion" | "updatedAt">,
) =>
  ({
    id: node.id,
    name: node.name,
    size: node.size,
    version: String(node.contentVersion ?? node.updatedAt),
  }) satisfies FileSource & { size: number };

/**
 * A small WebP of an image file (W2's thumbnail route), no wider or taller than `size`: 256 for a
 * row's tile, 1280 for the photo viewer before it zooms. Named by its version, so it is cached
 * for good and a new version is a new picture.
 */
export const thumbnailUrl = (node: DriveNode, size: 256 | 640 | 1280) =>
  `${config.apiUrl}/api/storage/files/${encodeURIComponent(node.id)}/thumbnail?size=${size}${
    node.contentVersion === undefined ? "" : `&v=${node.contentVersion}`
  }`;

/** The session and workspace headers a native view sends with `contentUrl`. */
export const useStorageHeaders = () =>
  useQuery({ queryKey: keys.storageHeaders(), queryFn: () => storageHeaders(), staleTime: 60_000 });

/**
 * `node` as a file on this phone, under its own name, for a view iOS draws from a local file
 * (PDFs, Office and iWork documents), which picks how by its extension. Kept per version in the
 * cache (`drive-files.ts`), so opening it again reads the copy.
 */
export const useLocalCopy = (node: DriveNode) =>
  useQuery({
    queryKey: keys.fileCopy(node.id, versionOf(node)),
    queryFn: async () => {
      const file = await localFile(sourceOf(node));
      return { uri: file.uri, folderUri: file.parentDirectory.uri };
    },
    staleTime: Infinity,
    retry: false,
  });

async function startOf(node: DriveNode, signal: AbortSignal) {
  const response = await api.storage.files[":id"].content.$get(
    { param: { id: node.id } },
    { headers: { range: `bytes=0-${TEXT_PREVIEW_MAX_BYTES - 1}` }, init: { signal } },
  );
  if (!response.ok) throw new ApiError(response.status, "the file didn't load");
  return response.text();
}

/**
 * A text file's contents, or `binary` when it has NUL bytes, whatever its name says. Only its
 * first `TEXT_PREVIEW_MAX_BYTES` are read (a `Range` request), so a large log never fills memory.
 */
export const useFileText = (node: DriveNode) =>
  useQuery({
    queryKey: keys.fileText(node.id, versionOf(node)),
    queryFn: async ({ signal }) => {
      const text =
        node.size > TEXT_PREVIEW_MAX_BYTES
          ? await startOf(node, signal)
          : await (await localFile(sourceOf(node))).text();
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
  const place = node?.parentId
    ? { parent: node.parentId }
    : node?.teamspaceId
      ? { teamspace: node.teamspaceId }
      : { space: node?.space === "shared" ? ("shared" as const) : ("personal" as const) };
  const folder = useInfiniteQuery({ ...folderQuery(place), enabled: !!node });
  if (!node || folder.isPending) return null;
  const images = (folder.data ?? []).filter(
    (one) => one.kind === "file" && !one.trashedAt && previewKindOf(one) === "image",
  );
  return images.some((one) => one.id === node.id) ? images : [node];
}
