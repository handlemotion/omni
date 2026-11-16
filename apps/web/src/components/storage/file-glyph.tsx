// A file's marks, by what it is (`lib/file-kind.ts`): its glyph, the tile the glyph sits in, and
// the type badge. The tile is the list rows' 32px square from the Figma list frame and the grid's
// larger one, on our tokens: a raised background square, the border and the crisp drop.
import type { ComponentType } from "react";
import {
  IconAudio,
  IconCode,
  IconFile,
  IconFilePdf,
  IconFileText,
  IconFileZip,
  IconFolder,
  IconImage,
  IconSlides,
  IconTable,
  IconVideo,
} from "@/components/icons/central";
import { Badge } from "@/components/ui/badge";
import type { FileKind } from "@/lib/file-kind.ts";

type Glyph = ComponentType<{ className?: string }>;

const GLYPH: Record<FileKind | "folder", Glyph> = {
  folder: IconFolder,
  image: IconImage,
  video: IconVideo,
  audio: IconAudio,
  pdf: IconFilePdf,
  code: IconCode,
  text: IconFileText,
  csv: IconTable,
  spreadsheet: IconTable,
  document: IconFileText,
  presentation: IconSlides,
  archive: IconFileZip,
  other: IconFile,
};

export function FileGlyph(props: { kind: FileKind | "folder"; className?: string }) {
  const Glyph = GLYPH[props.kind];
  return <Glyph className={props.className} />;
}

const TILE = {
  // The list's 32px square, its 15px glyph centred.
  sm: "size-8 rounded-lg *:size-icon",
  // The grid's and the preview's 88px square, a 32px glyph.
  lg: "size-22 rounded-xl *:size-8",
} as const;

/** The glyph in its raised square; muted, as every icon is at rest. */
export function FileTile(props: { kind: FileKind | "folder"; size?: keyof typeof TILE }) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center border bg-background text-muted-foreground shadow-raised ${TILE[props.size ?? "sm"]}`}
    >
      <FileGlyph kind={props.kind} />
    </span>
  );
}

/** "PNG", "PDF", "CODE": the type, in the list's Kind column and the preview's details. */
export function TypeBadge({ label }: { label: string }) {
  return (
    <Badge intent="secondary" isCircle={false} className="tabular-nums">
      {label}
    </Badge>
  );
}
