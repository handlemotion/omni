import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  previewImageQuery,
  previewSheetsQuery,
  pdfThumbnailQuery,
  previewTextQuery,
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

/** A PDF's tile: its first pages and its shape, once `enabled` (the tile is on screen). */
export function usePdfPages(source: PreviewSource, enabled: boolean) {
  revokePreviewUrls(useQueryClient());
  const options = pdfThumbnailQuery(source);
  return useQuery({ ...options, enabled: enabled && options.enabled !== false });
}
