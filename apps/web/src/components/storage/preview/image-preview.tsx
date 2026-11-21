import { use, useEffect, useRef, useState, type RefObject } from "react";
import { useFileImage } from "@/hooks/use-storage-preview.ts";
import type { PreviewSource } from "@/lib/storage-preview.ts";
import { PageMarks, PdfMarksContext } from "./pdf-marks.tsx";
import { NoPreview, StageLoading } from "./shared.tsx";

interface Size {
  width: number;
  height: number;
}

/**
 * The image, fit to the stage and never past its own size. With `placeholder` (the Worker's
 * thumbnail, often already cached by the list) that shows at once, fit to the stage, until the
 * whole image has loaded over it.
 */
export function ImagePreview(props: {
  source: PreviewSource;
  raster: string;
  name: string;
  placeholder?: string | undefined;
  onDownload?: (() => void) | undefined;
}) {
  const image = useFileImage(props.source, props.raster);
  const [broken, setBroken] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);
  const placeholder = thumbFailed ? undefined : props.placeholder;
  const stage = useRef<HTMLDivElement>(null);
  const room = useRoom(stage, !!(image.data || placeholder));
  const [natural, setNatural] = useState<Size | null>(null);
  const [thumb, setThumb] = useState<Size | null>(null);
  const failed = image.isError || broken;
  const onUnshown = use(PdfMarksContext)?.onUnshown;
  useEffect(() => {
    if (failed) onUnshown?.();
  }, [failed, onUnshown]);
  if (failed) return <NoPreview kind="image" onDownload={props.onDownload} />;
  if (!image.data && !placeholder) return <StageLoading label="Loading image" />;
  const box = fit(room, natural, thumb);
  return (
    <div
      ref={stage}
      data-preview-stage
      className="flex min-h-0 flex-1 items-center justify-center p-5"
    >
      <div
        className={`relative max-h-full max-w-full ${box || image.data ? "" : "invisible"}`}
        style={box ?? {}}
      >
        {placeholder && !natural && (
          <img
            src={placeholder}
            alt=""
            draggable={false}
            onLoad={(event) => setThumb(sizeOf(event.currentTarget))}
            onError={() => setThumbFailed(true)}
            className="absolute inset-0 block size-full rounded-lg border object-contain"
          />
        )}
        {image.data && (
          <img
            src={image.data.url}
            alt={props.name}
            decoding="async"
            draggable={false}
            onLoad={(event) => setNatural(sizeOf(event.currentTarget))}
            onError={() => setBroken(true)}
            className="relative block size-full max-h-full max-w-full rounded-lg border object-contain"
          />
        )}
        {natural && <PageMarks page={1} />}
      </div>
    </div>
  );
}

const sizeOf = (image: HTMLImageElement) => ({
  width: image.naturalWidth,
  height: image.naturalHeight,
});

function fit(room: Size | null, natural: Size | null, thumb: Size | null) {
  const shape = natural ?? thumb;
  if (!room || !shape) return null;
  const most = natural ? 1 : Infinity;
  const scale = Math.min(room.width / shape.width, room.height / shape.height, most);
  return { width: shape.width * scale, height: shape.height * scale };
}

function useRoom(ref: RefObject<HTMLDivElement | null>, ready: boolean) {
  const [room, setRoom] = useState<Size | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        setRoom({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, ready]);
  return room;
}
