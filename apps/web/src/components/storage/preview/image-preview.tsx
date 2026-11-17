// An image, fitted to the stage. Its bytes are fetched once and shown as an allow-listed raster
// `blob:` URL, never under the type it was uploaded with (ADR 0040). It is sized to the stage in
// script, so the comment pins and the box being drawn (`PageMarks`, page 1) sit on the image
// itself, not on the stage around it.
import { useEffect, useRef, useState, type RefObject } from "react";
import { useFileImage } from "@/hooks/use-storage-preview.ts";
import type { PreviewSource } from "@/lib/storage-preview.ts";
import { PageMarks } from "./pdf-marks.tsx";
import { NoPreview, StageLoading } from "./shared.tsx";

export function ImagePreview(props: {
  source: PreviewSource;
  raster: string;
  name: string;
  onDownload: () => void;
}) {
  const image = useFileImage(props.source, props.raster);
  const [broken, setBroken] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const room = useRoom(stage, !!image.data);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  if (image.isError || broken) return <NoPreview kind="image" onDownload={props.onDownload} />;
  if (!image.data) return <StageLoading label="Loading image" />;
  // Never past its own size; until it has loaded, the browser's own fit.
  const scale =
    natural && room ? Math.min(room.width / natural.width, room.height / natural.height, 1) : null;
  return (
    <div ref={stage} className="flex min-h-0 flex-1 items-center justify-center p-5">
      <div
        className="relative max-h-full max-w-full"
        style={
          natural && scale ? { width: natural.width * scale, height: natural.height * scale } : {}
        }
      >
        <img
          src={image.data.url}
          alt={props.name}
          decoding="async"
          draggable={false}
          onLoad={(event) =>
            setNatural({
              width: event.currentTarget.naturalWidth,
              height: event.currentTarget.naturalHeight,
            })
          }
          onError={() => setBroken(true)}
          className="block size-full max-h-full max-w-full rounded-lg object-contain shadow-raised"
        />
        {natural && <PageMarks page={1} />}
      </div>
    </div>
  );
}

/** The stage's inner size, inside its padding. */
function useRoom(ref: RefObject<HTMLDivElement | null>, ready: boolean) {
  const [room, setRoom] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setRoom({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, ready]);
  return room;
}
