import type { ReactNode } from "react";
import { Skeleton, SkeletonBox } from "skullet/react";
import { IconDownload } from "@/components/icons/central";
import { Button } from "@/components/ui/button";
import type { FileKind } from "@/lib/file-kind.ts";
import { FileTile } from "../file-glyph.tsx";

/**
 * The file's tile and Download, a little above the stage's middle. No `onDownload` (a view-only
 * link) leaves the tile alone.
 */
export function NoPreview(props: { kind: FileKind; onDownload?: (() => void) | undefined }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 p-8 pb-[10%]">
      <FileTile kind={props.kind} size="lg" />
      {props.onDownload && (
        <Button size="sm" intent="outline" onPress={props.onDownload}>
          <IconDownload />
          Download
        </Button>
      )}
    </div>
  );
}

/** One box the stage's size while the bytes are on their way; skullet holds it back 150ms. */
export function StageLoading(props: { label: string; children?: ReactNode }) {
  return (
    <Skeleton
      loading
      label={props.label}
      className="flex flex-1 p-5"
      skeleton={
        props.children ?? <SkeletonBox width="100%" height="100%" radius="var(--radius-xl)" />
      }
    >
      {null}
    </Skeleton>
  );
}
