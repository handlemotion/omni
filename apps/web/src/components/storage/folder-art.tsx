// A folder card's square: a loose stack of what the folder holds, on the card's own surface, with
// no folder drawn, because the stack is the folder. Its first files come first (an image or PDF
// shows its thumbnail, anything else its glyph), then its subfolders (a solid blue folder), three
// at most; an empty folder's square itself is dashed. The contents come from the folder's own
// first page, read once the card nears the screen, so opening the folder finds it cached.
import { useRef, useState, type CSSProperties } from "react";
import { IconFolderFilled, IconFolderOpenFilled } from "@/components/icons/central";
import { useStorageList } from "@/hooks/use-storage.ts";
import { useThumbnail } from "@/hooks/use-storage-preview.ts";
import { fileType } from "@/lib/file-kind.ts";
import type { StorageNode } from "@/lib/storage.ts";
import { useSeen } from "./file-card.tsx";
import { FileGlyph } from "./file-glyph.tsx";

type Spot = readonly [left: number, top: number, width: number, height: number];

// Where each card sits (percent of the square), by how many there are, the front card first:
// one card centred; two on a diagonal; three as two behind, mirrored about the middle, and one
// in front between them. The back right card sits a little lower than the back left, so the
// pair doesn't read as a flat shelf.
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
  // Empty once its listing says so (not while it loads, so a full folder never flashes its empty
  // glyph), and always for a folder still being named.
  const empty = !node || (contents.isSuccess && contents.nodes.length === 0);
  return (
    <div
      aria-hidden
      data-slot="folder-art"
      className="relative flex aspect-square items-center justify-center overflow-hidden rounded-lg border bg-surface shadow-raised"
    >
      <span ref={anchor} className="absolute inset-0" />
      {/* Empty: an open folder, filled in the subtle grey, in place of the stack. */}
      {empty && <IconFolderOpenFilled className="size-12 text-subtle-foreground" />}
      {fileUrl &&
        cards.length > 0 &&
        // Drawn back to front, so the first card lands on top.
        cards
          .map((card, i) => (
            <Card key={card.id} node={card} url={fileUrl(card)} style={place(spots[i] ?? EMPTY)} />
          ))
          .toReversed()}
    </div>
  );
}

const place = ([left, top, width, height]: Spot): CSSProperties => ({
  left: `${left}%`,
  top: `${top}%`,
  width: `${width}%`,
  height: `${height}%`,
});

/** The folder's first files, then its subfolders, three at most. */
function pick(nodes: StorageNode[]) {
  const files = nodes.filter((n) => n.kind === "file");
  const folders = nodes.filter((n) => n.kind === "folder");
  return [...files, ...folders].slice(0, STACK.length);
}

/** One card: an image's thumbnail filling it, else its glyph in the middle. */
function Card(props: { node: StorageNode; url: string; style: CSSProperties }) {
  const { node } = props;
  const type = node.kind === "file" ? fileType(node.name, node.mimeType) : null;
  return (
    <div
      style={props.style}
      className="absolute flex items-center justify-center overflow-hidden rounded-md border bg-background shadow-raised"
    >
      {type ? (
        <FileGlyph kind={type.kind} className="size-6 text-muted-foreground" />
      ) : (
        // A subfolder: the filled folder in the brand blue, so it reads apart from files.
        <IconFolderFilled className="size-6 text-primary" />
      )}
      {type?.preview === "image" && type.raster ? (
        <CardImage node={node} url={props.url} of={{ raster: type.raster }} />
      ) : type?.preview === "pdf" ? (
        <CardImage node={node} url={props.url} of="pdf" />
      ) : null}
    </div>
  );
}

/** An image's or a PDF's thumbnail, faded in over the glyph once it has decoded. */
function CardImage(props: { node: StorageNode; url: string; of: { raster: string } | "pdf" }) {
  const thumb = useThumbnail(
    { url: props.url, version: props.node.updatedAt, size: props.node.size },
    props.of,
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
