// An image, fitted to the stage. Its bytes are fetched once and shown as an allow-listed raster
// `blob:` URL, never under the type it was uploaded with (ADR 0040).
import { useState } from "react";
import { useFileImage } from "@/hooks/use-storage-preview.ts";
import type { PreviewSource } from "@/lib/storage-preview.ts";
import { NoPreview, StageLoading } from "./shared.tsx";

export function ImagePreview(props: {
  source: PreviewSource;
  raster: string;
  name: string;
  onDownload: () => void;
}) {
  const image = useFileImage(props.source, props.raster);
  const [broken, setBroken] = useState(false);
  if (image.isError || broken) return <NoPreview kind="image" onDownload={props.onDownload} />;
  if (!image.data) return <StageLoading label="Loading image" />;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-5">
      <img
        src={image.data.url}
        alt={props.name}
        decoding="async"
        draggable={false}
        onError={() => setBroken(true)}
        className="max-h-full max-w-full rounded-lg object-contain shadow-raised"
      />
    </div>
  );
}
