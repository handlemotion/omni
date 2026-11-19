import type { FileKind } from "@/lib/file-kind.ts";
import { ExcelMark } from "./excel.tsx";
import { PdfMark } from "./pdf.tsx";
import { PowerPointMark } from "./powerpoint.tsx";
import { WordMark } from "./word.tsx";

/**
 * The file types a brand owns, drawn with its mark in its own colours, as the web's `BRAND` does
 * (`apps/web/src/components/storage/file-glyph.tsx`); every other kind keeps its Central glyph.
 */
export const BRAND_MARKS = {
  pdf: PdfMark,
  document: WordMark,
  spreadsheet: ExcelMark,
  presentation: PowerPointMark,
} as const satisfies Partial<Record<FileKind, unknown>>;

/** A kind that draws a brand's mark. */
export type BrandedKind = keyof typeof BRAND_MARKS;

/** Whether `kind` draws a brand's mark rather than a Central glyph. */
export const isBranded = (kind: string): kind is BrandedKind => kind in BRAND_MARKS;
