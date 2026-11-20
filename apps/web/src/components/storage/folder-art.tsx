import { useRef, useState, type CSSProperties } from "react";
import { IconFolderFilled, IconFolderOpenFilled } from "@/components/icons/central";
import { useStorageList } from "@/hooks/use-storage.ts";
import { usePdfPages } from "@/hooks/use-storage-preview.ts";
import { fileType } from "@/lib/file-kind.ts";
import type { StorageNode } from "@/lib/storage.ts";
import { useSeen } from "./file-card.tsx";
import { FileGlyph } from "./file-glyph.tsx";
import { hasThumbnail, ThumbnailImage } from "./thumbnail-image.tsx";

type Spot = readonly [left: number, top: number, width: number, height: number];

const EMPTY: Spot = [27, 22, 46, 50];
const STACK: readonly (readonly Spot[])[] = [
  [EMPTY],
  [
    [38, 36, 40, 40],
    [22, 20, 40, 40],
  ],
  [
    [30, 40, 40, 38],
    [14, 18, 40, 38],
    [46, 24, 40, 38],
  ],
];

/** The folder drawn; without `node` (a folder being named), or `peek` off, one dashed card. */
export function FolderArt(props: {
  node?: StorageNode;
  peek?: boolean | undefined;
  fileUrl?: ((node: StorageNode) => string) | undefined;
}) {
  const anchor = useRef<HTMLSpanElement>(null);
  const near = useSeen(anchor);
  const { node, fileUrl } = props;
  const enabled = !!node && !!fileUrl && props.peek !== false && near;
  const contents = useStorageList({ parentId: node?.id ?? "" }, { enabled });
  const cards = enabled ? pick(contents.nodes) : [];
  const spots = STACK[cards.length - 1] ?? [];
  const empty = !node || (contents.isSuccess && contents.nodes.length === 0);
  return (
    <div
      aria-hidden
      data-slot="folder-art"
      className="relative flex aspect-square items-center justify-center overflow-hidden rounded-lg border bg-surface"
    >
      <span ref={anchor} className="absolute inset-0" />
      {empty && <IconFolderOpenFilled className="size-12 text-subtle-foreground" />}
      {fileUrl &&
        cards.length > 0 &&
        cards
          .map((card, i) => (
            <Card key={card.id} node={card} url={fileUrl(card)} style={place(spots[i] ?? EMPTY)} />
          ))
          .toReversed()}
    </div>
  );
}

const place = ([left, top, width, height]: Spot) => {
  const result: CSSProperties = {
    left: `${left}%`,
    top: `${top}%`,
    width: `${width}%`,
    height: `${height}%`,
  };
  return result;
};

function pick(nodes: StorageNode[]) {
  const files = nodes.filter((n) => n.kind === "file");
  const folders = nodes.filter((n) => n.kind === "folder");
  return [...files, ...folders].slice(0, STACK.length);
}

function Card(props: { node: StorageNode; url: string; style: CSSProperties }) {
  const { node } = props;
  const type = node.kind === "file" ? fileType(node.name, node.mimeType) : null;
  return (
    <div
      style={props.style}
      className="absolute flex items-center justify-center overflow-hidden rounded-md border bg-background"
    >
      {type ? (
        <FileGlyph kind={type.kind} className="size-6 text-muted-foreground" />
      ) : (
        <IconFolderFilled className="size-6 text-primary" />
      )}
      {hasThumbnail(node) ? (
        <ThumbnailImage
          node={node}
          url={props.url}
          size={256}
          className="absolute inset-0 size-full object-cover"
        />
      ) : type?.preview === "pdf" ? (
        <PdfImage node={node} url={props.url} />
      ) : null}
    </div>
  );
}

function PdfImage(props: { node: StorageNode; url: string }) {
  const thumb = usePdfPages(
    { url: props.url, version: props.node.updatedAt, size: props.node.size },
    true,
  );
  const [shown, setShown] = useState(false);
  if (!thumb.data) return null;
  return (
    <img
      src={thumb.data.url}
      alt=""
      decoding="async"
      draggable={false}
      onLoad={() => setShown(true)}
      className={`absolute inset-0 size-full object-cover transition-opacity duration-200 ease-out motion-reduce:transition-none ${shown ? "opacity-100" : "opacity-0"}`}
    />
  );
}
