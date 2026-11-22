import { useRef, useState, type CSSProperties } from "react";
import { IconFolderFilled } from "@/components/icons/central";
import { useStorageList } from "@/hooks/use-storage.ts";
import { usePdfPages } from "@/hooks/use-storage-preview.ts";
import { fileType } from "@/lib/file-kind.ts";
import type { StorageNode } from "@/lib/storage.ts";
import { useSeen } from "./file-card.tsx";
import { FileGlyph } from "./file-glyph.tsx";
import { hasThumbnail, ThumbnailImage } from "./thumbnail-image.tsx";

type Spot = readonly [left: number, top: number, width: number, turn: number];

const ONE: Spot = [21, 6, 58, -3];

const PEEK: readonly (readonly Spot[])[] = [
  [ONE],
  [
    [5, 8, 56, -5],
    [39, 10, 56, 5],
  ],
  [
    [3, 11, 50, -7],
    [25, 5, 50, 0],
    [47, 11, 50, 7],
  ],
];

/**
 * A folder drawn as a pocket, tinted blue: a back panel, its first few items standing in it as
 * cards, and a front flap over their lower half. Without `node` (a folder being named), or with
 * `peek` off, the pocket is empty; a folder with nothing in it, or one being named, is grey.
 */
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
  const spots = PEEK[cards.length - 1] ?? [];
  const empty = !node || (contents.isSuccess && contents.nodes.length === 0);
  const back = empty
    ? "border-folder-empty-edge/40 bg-(image:--folder-empty-back)"
    : "border-folder-edge/40 bg-(image:--folder-back)";
  const front = empty
    ? "border-folder-empty-edge/40 bg-(image:--folder-empty-front)"
    : "border-folder-edge/40 bg-(image:--folder-front)";
  return (
    <div
      aria-hidden
      data-slot="folder-art"
      className="relative aspect-square overflow-hidden rounded-lg"
    >
      <span ref={anchor} className="absolute inset-0" />
      <span
        className={`absolute inset-0 rounded-lg border ${back} inset-shadow-[0_1px_0] inset-shadow-folder-shine`}
      />
      {fileUrl &&
        cards.map((card, i) => (
          <Card key={card.id} node={card} url={fileUrl(card)} style={place(spots[i] ?? ONE)} />
        ))}
      <span
        className={`absolute inset-x-0 top-[40%] bottom-0 rounded-lg border ${front} inset-shadow-[0_1px_0] inset-shadow-folder-shine backdrop-blur-sm`}
      />
    </div>
  );
}

const place = ([left, top, width, turn]: Spot) => {
  const result: CSSProperties = {
    left: `${left}%`,
    top: `${top}%`,
    width: `${width}%`,
    rotate: `${turn}deg`,
  };
  return result;
};

function pick(nodes: StorageNode[]) {
  const files = nodes.filter((n) => n.kind === "file");
  const folders = nodes.filter((n) => n.kind === "folder");
  return [...files, ...folders].slice(0, PEEK.length);
}

function Card(props: { node: StorageNode; url: string; style: CSSProperties }) {
  const { node } = props;
  const type = node.kind === "file" ? fileType(node.name, node.mimeType) : null;
  return (
    <div
      style={props.style}
      className="absolute flex aspect-4/3 items-center justify-center overflow-hidden rounded-md border bg-background transition-[translate] duration-200 ease-out group-hover:-translate-y-[6%] motion-reduce:transition-none"
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
