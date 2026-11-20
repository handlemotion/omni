import { useState } from "react";
import { fileType } from "@/lib/file-kind.ts";
import type { StorageNode } from "@/lib/storage.ts";

type ThumbnailSize = 256 | 640;

const WORKER_THUMBNAIL_MAX_SOURCE_BYTES = 20_000_000;

/**
 * Whether the Worker draws this file a thumbnail (W2, `GET /files/:id/thumbnail`): an image up to
 * 20 MB. HEIC counts though the browser cannot show the original.
 */
export function hasThumbnail(node: StorageNode) {
  if (node.kind !== "file" || node.size <= 0) return false;
  if (node.size > WORKER_THUMBNAIL_MAX_SOURCE_BYTES) return false;
  return fileType(node.name, node.mimeType).kind === "image";
}

/**
 * The thumbnail's address beside the file's bytes (`…/content` → `…/thumbnail`), through the same
 * door. Naming the version makes it cacheable for good, so a scroll back costs no request.
 */
export function thumbnailUrl(contentUrl: string, node: StorageNode, size: ThumbnailSize) {
  const url = new URL(contentUrl, window.location.origin);
  url.pathname = url.pathname.replace(/\/content$/, "/thumbnail");
  url.searchParams.set("size", String(size));
  if (node.contentVersion !== undefined) url.searchParams.set("v", String(node.contentVersion));
  return url.toString();
}

/** A card's thumbnail size: the smallest drawn that stays sharp at this screen's density. */
export const cardThumbnailSize: () => ThumbnailSize = () =>
  (globalThis.devicePixelRatio ?? 1) > 1.4 ? 640 : 256;

/**
 * The Worker's thumbnail over whatever is drawn under it, faded in once loaded. A file it cannot
 * draw answers 415 and stays hidden, so the glyph under it shows.
 */
export function ThumbnailImage(props: {
  node: StorageNode;
  url: string;
  size: ThumbnailSize;
  className: string;
}) {
  const [shown, setShown] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      src={thumbnailUrl(props.url, props.node, props.size)}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onLoad={() => setShown(true)}
      onError={() => setFailed(true)}
      className={`${props.className} transition-opacity duration-200 ease-out motion-reduce:transition-none ${shown ? "opacity-100" : "opacity-0"}`}
    />
  );
}
