import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { StorageNode } from "../lib/storage.ts";
import {
  cardTextQuery,
  previewImageQuery,
  previewSheetsQuery,
  pdfSheetsQuery,
  pdfThumbnailQuery,
  previewTextQuery,
  readAhead,
  revokePreviewUrls,
  type PreviewSource,
} from "../lib/storage-preview.ts";

/** The file's first 512 KB as text, for code, text and CSV. */
export function useFileText(source: PreviewSource) {
  revokePreviewUrls(useQueryClient());
  return useQuery(previewTextQuery(source));
}

/** An XLSX's visible sheets, each as rows of text cells. */
export function useFileSheets(source: PreviewSource) {
  return useQuery(previewSheetsQuery(source));
}

/** The whole image, re-typed as `raster`, as an object URL. */
export function useFileImage(source: PreviewSource, raster: string) {
  revokePreviewUrls(useQueryClient());
  return useQuery(previewImageQuery(source, raster));
}

/**
 * A PDF's tile, once `enabled` (the tile is on screen): its first page and shape as soon as
 * that is drawn, then the pages behind it as `more`.
 */
export function usePdfPages(source: PreviewSource, enabled: boolean) {
  revokePreviewUrls(useQueryClient());
  const options = pdfThumbnailQuery(source);
  const first = useQuery({ ...options, enabled: enabled && options.enabled !== false });
  const count = first.data?.count ?? 0;
  const sheets = useQuery({ ...pdfSheetsQuery(source, count), enabled: enabled && count > 1 });
  const data = useMemo(
    () => first.data && { ...first.data, more: sheets.data?.more ?? [] },
    [first.data, sheets.data],
  );
  return { data, isError: first.isError };
}

/** A card's page: the file's first 8 KB as text, once `enabled` (the card is on screen). */
export function useCardText(source: PreviewSource, enabled: boolean) {
  const options = cardTextQuery(source);
  return useQuery({ ...options, enabled: enabled && options.enabled !== false });
}

/** A workbook's sheets for its card, once `enabled`: read whole, shared with its preview. */
export function useCardSheets(source: PreviewSource, enabled: boolean) {
  return useQuery({ ...previewSheetsQuery(source), enabled });
}

/**
 * `(node, url, images)` starts reading a file's preview on a guess, when it is cheap to
 * (`readAhead`).
 */
export function useReadAhead() {
  const client = useQueryClient();
  revokePreviewUrls(client);
  return useCallback(
    (node: StorageNode, url: string, images: boolean) => readAhead(client, node, url, images),
    [client],
  );
}
