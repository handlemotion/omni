import { useRef, useState } from "react";
import { useThumbnail } from "@/hooks/use-storage-preview.ts";
import { fileType } from "@/lib/file-kind.ts";
import type { StorageNode } from "@/lib/storage.ts";
import { useSeen } from "./file-card.tsx";
import { FileTile } from "./file-glyph.tsx";

export function RowTile(props: { node: StorageNode; url: string }) {
  const { node } = props;
  const type = node.kind === "file" ? fileType(node.name, node.mimeType) : null;
  if (type?.preview !== "image" || !type.raster) return <FileTile kind={type?.kind ?? "folder"} />;
  return <PictureTile node={node} url={props.url} raster={type.raster} kind={type.kind} />;
}

function PictureTile(props: {
  node: StorageNode;
  url: string;
  raster: string;
  kind: Parameters<typeof FileTile>[0]["kind"];
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const near = useSeen(anchor);
  const thumb = useThumbnail(
    { url: props.url, version: props.node.updatedAt, size: props.node.size },
    { raster: props.raster },
    near,
  );
  const [shown, setShown] = useState(false);
  return (
    <span ref={anchor} className="relative shrink-0">
      <FileTile kind={props.kind} />
      {thumb.data && (
        <img
          src={thumb.data.url}
          alt=""
          decoding="async"
          draggable={false}
          onLoad={() => setShown(true)}
          className={`absolute inset-0 size-full rounded-lg border object-cover transition-opacity duration-200 ease-out motion-reduce:transition-none ${shown ? "opacity-100" : "opacity-0"}`}
        />
      )}
    </span>
  );
}
