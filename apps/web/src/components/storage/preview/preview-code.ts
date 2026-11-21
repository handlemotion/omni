import type { PreviewKind } from "@/lib/file-kind.ts";

/**
 * Each preview's code, its own chunk. `PreviewBody` loads it on first use; `loadPreviewCode` asks
 * for it before that (a file under the pointer, the files beside the open one), so opening a kind
 * for the first time doesn't wait on a download.
 */
export const PREVIEW_CODE = {
  pdf: () => import("./pdf-preview.tsx"),
  text: () => import("./code-preview.tsx"),
  csv: () => import("./csv-preview.tsx"),
  sheet: () => import("./xlsx-preview.tsx"),
} as const;

export function loadPreviewCode(preview: PreviewKind) {
  if (preview in PREVIEW_CODE) {
    void PREVIEW_CODE[preview as keyof typeof PREVIEW_CODE]().catch(() => {});
  }
}
