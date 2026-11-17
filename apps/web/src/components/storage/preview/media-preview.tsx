import { useState } from "react";
import type { FileKind } from "@/lib/file-kind.ts";
import { FileTile } from "../file-glyph.tsx";
import { NoPreview } from "./shared.tsx";

export function VideoPreview(props: { url: string; name: string; onDownload: () => void }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <NoPreview kind="video" onDownload={props.onDownload} />;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-5">
      {/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        src={props.url}
        aria-label={props.name}
        controls
        playsInline
        preload="metadata"
        onError={() => setBroken(true)}
        className="max-h-full max-w-full rounded-lg bg-foreground shadow-raised"
      />
    </div>
  );
}

export function AudioPreview(props: {
  url: string;
  name: string;
  kind: FileKind;
  onDownload: () => void;
}) {
  const [broken, setBroken] = useState(false);
  if (broken) return <NoPreview kind={props.kind} onDownload={props.onDownload} />;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8 pb-[10%]">
      <FileTile kind="audio" size="lg" />
      {/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
      <audio
        src={props.url}
        aria-label={props.name}
        controls
        preload="metadata"
        onError={() => setBroken(true)}
        className="w-full max-w-sm"
      />
    </div>
  );
}
