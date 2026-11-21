import { useCallback, useEffect, useRef } from "react";
import { useReadAhead } from "@/hooks/use-storage-preview.ts";
import { fileType } from "@/lib/file-kind.ts";
import type { StorageNode } from "@/lib/storage.ts";
import { previewThumbnail } from "../thumbnail-image.tsx";
import { loadPreviewCode } from "./preview-code.ts";

const DWELL_MS = 80;

/**
 * Readies a file's preview: its code, an image's thumbnail, and its bytes when they are cheap to
 * read on a guess (an image's original only with `images`).
 */
export function useWarmPreview() {
  const readAhead = useReadAhead();
  return useCallback(
    (node: StorageNode, url: string, images = false) => {
      if (node.kind !== "file") return;
      loadPreviewCode(fileType(node.name, node.mimeType).preview);
      readAhead(node, url, images);
      const thumbnail = previewThumbnail(node, url);
      if (thumbnail) new Image().src = thumbnail;
    },
    [readAhead],
  );
}

/**
 * Hover and press handlers for an item that opens a file: resting the pointer on it a moment, or
 * pressing it, readies its preview before the press lands.
 */
export function useWarmOnHover(node: StorageNode, url: string) {
  const warm = useWarmPreview();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (node.kind !== "file") return {};
  return {
    onHoverStart: () => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => warm(node, url), DWELL_MS);
    },
    onHoverEnd: () => clearTimeout(timer.current),
    onPressStart: () => warm(node, url),
  };
}

/** Readies the files beside the open one once the page is idle, so stepping to them is instant. */
export function useWarmNeighbors(
  nodes: (StorageNode | undefined)[],
  fileUrl: (node: StorageNode) => string,
) {
  const warm = useWarmPreview();
  const shown = nodes.filter((node): node is StorageNode => !!node);
  const key = shown.map((node) => `${node.id}:${node.updatedAt}`).join();
  const latest = useRef({ shown, fileUrl });
  latest.current = { shown, fileUrl };
  useEffect(() => {
    if (!key) return;
    const run = () => {
      for (const node of latest.current.shown) warm(node, latest.current.fileUrl(node), true);
    };
    if (typeof requestIdleCallback === "undefined") {
      const timer = setTimeout(run, 300);
      return () => clearTimeout(timer);
    }
    const idle = requestIdleCallback(run, { timeout: 1000 });
    return () => cancelIdleCallback(idle);
  }, [key, warm]);
}
