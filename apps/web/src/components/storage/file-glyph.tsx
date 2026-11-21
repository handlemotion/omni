import {
  MicrosoftExcel,
  MicrosoftPowerPoint,
  MicrosoftWord,
  PDF,
} from "@ridemountainpig/svgl-react";
import type { ComponentType } from "react";
import {
  IconAudio,
  IconPaperclip,
  IconCode,
  IconFile,
  IconFileText,
  IconFileZip,
  IconFolder,
  IconImage,
  IconTable,
  IconVideo,
} from "@/components/icons/central";
import { Badge } from "@/components/ui/badge";
import { fileType, type FileKind } from "@/lib/file-kind.ts";

type Glyph = ComponentType<{ className?: string }>;

const BRAND = {
  pdf: PDF,
  document: MicrosoftWord,
  spreadsheet: MicrosoftExcel,
  presentation: MicrosoftPowerPoint,
} satisfies Partial<Record<FileKind, Glyph>>;

const GLYPH: Record<FileKind | "folder", Glyph> = {
  ...BRAND,
  folder: IconFolder,
  image: IconImage,
  video: IconVideo,
  audio: IconAudio,
  doc: IconFileText,
  code: IconCode,
  text: IconFileText,
  csv: IconTable,
  archive: IconFileZip,
  other: IconFile,
};

export function FileGlyph(props: { kind: FileKind | "folder"; className?: string }) {
  const Glyph = GLYPH[props.kind];
  return <Glyph className={props.className} />;
}

/** An attachment chip's mark: the brand's for a PDF or an Office file, else the paperclip. */
export function AttachmentGlyph(props: { name: string; mimeType?: string | null }) {
  const brands: Partial<Record<FileKind, Glyph>> = BRAND;
  const Brand = brands[fileType(props.name, props.mimeType ?? null).kind];
  return Brand ? <Brand /> : <IconPaperclip />;
}

const TILE = {
  xs: "size-6 rounded-md *:size-3.5",
  sm: "size-8 rounded-lg *:size-icon",
  lg: "size-22 rounded-xl *:size-8",
} as const;

/** The glyph in its raised square; muted, as every icon is at rest. */
export function FileTile(props: { kind: FileKind | "folder"; size?: keyof typeof TILE }) {
  return (
    <span
      aria-hidden
      className={`flex shrink-0 items-center justify-center border bg-background text-muted-foreground ${TILE[props.size ?? "sm"]}`}
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
