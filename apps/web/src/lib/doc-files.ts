import { queryOptions } from "@tanstack/react-query";
import { api } from "./api.ts";
import { keys } from "./query-keys.ts";
import { workspaceHeaders } from "./current-workspace.ts";
import { sharedFileUrl, storageFileUrl } from "./urls.ts";

/**
 * Where a doc's Markdown points for a Drive file it shows as an image: the file's content path
 * on this origin, by id, so renaming or moving the file keeps the image.
 */
export function docImagePath(fileId: string) {
  return new URL(api.storage.files[":id"].content.$url({ param: { id: fileId } }).toString())
    .pathname;
}

/** The Drive file an image in a doc shows, or null for an image from anywhere else. */
export function docImageFile(src: string) {
  const id = /^\/api\/storage\/files\/([^/?#]+)\/content$/.exec(src)?.[1];
  return id ? decodeURIComponent(id) : null;
}

/** The Drive file a link in a doc opens (the `file` of an app link), or null. */
export function docLinkFile(href: string) {
  if (!href.startsWith("/")) return null;
  const id = new URL(href, window.location.origin).searchParams.get("file");
  return id || null;
}

/** An image file's bytes, with the type the browser read them as. */
export async function docImageBytes(fileId: string, shareId: string | undefined) {
  const url = shareId ? sharedFileUrl(shareId, fileId) : storageFileUrl(fileId);
  const response = await fetch(url, { credentials: "same-origin", headers: workspaceHeaders() });
  if (!response.ok) throw new Error(`the image did not load (${response.status})`);
  const blob = await response.blob();
  const type = sniffImage(new Uint8Array(await blob.slice(0, 12).arrayBuffer()));
  if (!type) throw new Error("the file is not an image");
  return new Blob([blob], { type: `image/${type}` });
}

/** An image in a doc, as a URL the page may show: the file is served as a download, never inline. */
export const docImageQuery = (fileId: string, shareId: string | undefined) =>
  queryOptions({
    queryKey: keys.storagePreview("image", `doc:${fileId}`, shareId ?? ""),
    queryFn: async () => ({ url: URL.createObjectURL(await docImageBytes(fileId, shareId)) }),
    staleTime: Infinity,
    gcTime: 10 * 60_000,
    retry: 1,
  });

/** The raster type the first bytes of a file declare, if it is one a doc shows. */
export function sniffImage(head: Uint8Array) {
  const starts = (...bytes: number[]) => bytes.every((byte, i) => head[i] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "png";
  if (starts(0xff, 0xd8, 0xff)) return "jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && head[8] === 0x57 && head[9] === 0x45) return "webp";
  return null;
}
