// A file's preview (ADR 0040): its text, its image, its grid thumbnail.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  previewImageQuery,
  previewTextQuery,
  revokePreviewUrls,
  thumbnailQuery,
  type PreviewSource,
} from "../lib/storage-preview.ts";

/** The file's first 512 KB as text, for code, text and CSV. */
export function useFileText(source: PreviewSource) {
  revokePreviewUrls(useQueryClient());
  return useQuery(previewTextQuery(source));
}

/** The whole image, re-typed as `raster`, as an object URL. */
export function useFileImage(source: PreviewSource, raster: string) {
  revokePreviewUrls(useQueryClient());
  return useQuery(previewImageQuery(source, raster));
}

/** A downscaled copy for a grid tile, once `enabled` (the tile is on screen). */
export function useThumbnail(source: PreviewSource, raster: string | undefined, enabled: boolean) {
  revokePreviewUrls(useQueryClient());
  const options = thumbnailQuery(source, raster ?? "");
  return useQuery({ ...options, enabled: !!raster && enabled && options.enabled !== false });
}
