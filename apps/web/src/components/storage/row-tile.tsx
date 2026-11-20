import { fileType } from "@/lib/file-kind.ts";
import type { StorageNode } from "@/lib/storage.ts";
import { FileTile } from "./file-glyph.tsx";
import { hasThumbnail, ThumbnailImage } from "./thumbnail-image.tsx";

export function RowTile(props: { node: StorageNode; url: string }) {
  const { node } = props;
  const type = node.kind === "file" ? fileType(node.name, node.mimeType) : null;
  const tile = <FileTile kind={type?.kind ?? "folder"} />;
  if (!hasThumbnail(node)) return tile;
  return (
    <span className="relative shrink-0">
      {tile}
      <ThumbnailImage
        node={node}
        url={props.url}
        size={256}
        className="absolute inset-0 size-full rounded-lg border object-cover"
      />
    </span>
  );
}
