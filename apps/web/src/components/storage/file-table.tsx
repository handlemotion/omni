import { SkeletonBox } from "skullet/react";
import { fileType } from "@/lib/file-kind.ts";
import type { StorageNode } from "@/lib/storage.ts";
import { FileTile } from "./file-glyph.tsx";

export const DAY = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

export const COLUMN = {
  date: "w-36 max-sm:hidden",
  size: "w-24",
} as const;

/** The kind's 32px tile and the name, 12px apart, the name cut with an ellipsis. */
export function NameCell(props: {
  kind: StorageNode["kind"];
  name: string;
  mimeType?: string | null | undefined;
}) {
  const kind =
    props.kind === "folder" ? "folder" : fileType(props.name, props.mimeType ?? null).kind;
  return (
    <span className="flex min-w-0 items-center gap-3">
      <FileTile kind={kind} />
      <span className="truncate">{props.name}</span>
    </span>
  );
}

/** A secondary column's value: muted, in tabular figures. */
export function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground tabular-nums">{children}</span>;
}

/** The table while its rows load: skullet's boxes on the rows' own grid. */
export function FileTableBones() {
  return (
    <div>
      <div className="h-9 border-b" />
      {Array.from({ length: 12 }, (_, i) => (
        <div key={i} className="flex h-14 items-center gap-3 border-b px-5">
          <SkeletonBox width={32} height={32} radius="var(--radius-lg)" />
          <span className="min-w-0 flex-1">
            <SkeletonBox width={`${25 + ((i * 17) % 30)}%`} height={10} />
          </span>
          <span className="w-24 max-md:hidden">
            <SkeletonBox width={36} height={14} radius="var(--radius-sm)" />
          </span>
          <span className="w-24">
            <SkeletonBox width={44} height={10} />
          </span>
          <span className="w-36 max-sm:hidden">
            <SkeletonBox width={72} height={10} />
          </span>
          <span className="w-8.5" />
        </div>
      ))}
    </div>
  );
}
