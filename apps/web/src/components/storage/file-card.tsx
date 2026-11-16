// One file or folder as a card, the same for both: a square preview (an image's thumbnail, else
// its kind's glyph on the card's surface), then the name with its menu beside it, and under it
// what it is ("585 KB · PNG", "Folder"). Hovered the card washes; the open file's card keeps the
// accent fill; a press squeezes it a touch (cards squeeze least).
import { useEffect, useRef, useState, type RefObject } from "react";
import { SkeletonBox } from "skullet/react";
import {
  SettingsRowMenu,
  type SettingsRowMenuItem,
} from "@/components/settings/kit/settings-row-menu";
import { GridListItem } from "@/components/ui/grid-list";
import { useThumbnail } from "@/hooks/use-storage-preview.ts";
import { fileType } from "@/lib/file-kind.ts";
import { formatBytes, type StorageNode } from "@/lib/storage.ts";
import { FileGlyph } from "./file-glyph.tsx";

const stop = (event: { stopPropagation: () => void }) => event.stopPropagation();
/**
 * On an item's menu: React carries a menu item's presses and keys up from its portal to the
 * item, which would select it (opening the preview) as the menu acts. The table's action cells
 * do the same.
 */
export const KEEP_IN_MENU = {
  onPointerDown: stop,
  onPointerUp: stop,
  onClick: stop,
  onKeyDown: stop,
};

export function FileCard(props: {
  node: StorageNode;
  href: string | undefined;
  /** Where its bytes are read, for an image's thumbnail. */
  url: string;
  menu: SettingsRowMenuItem[];
}) {
  const { node } = props;
  const type = node.kind === "file" ? fileType(node.name, node.mimeType) : null;
  return (
    <GridListItem
      id={node.id}
      href={props.href}
      textValue={node.name}
      // 6px around the square and the caption, so the hover and open fills frame both. Laid out
      // only near the screen.
      className="flex-col items-stretch gap-2 rounded-xl p-1.5 transition-[background-color,scale] duration-150 ease-out [contain-intrinsic-size:auto_15rem] [content-visibility:auto] hover:bg-hover active:scale-[.99] selected:bg-accent motion-reduce:transition-none"
    >
      <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-lg border bg-surface shadow-raised">
        {type?.preview === "image" && type.raster ? (
          <Thumbnail node={node} url={props.url} raster={type.raster} />
        ) : (
          <FileGlyph kind={type?.kind ?? "folder"} className="size-8 text-muted-foreground" />
        )}
      </div>
      {/* The body's 13px over the 11px meta, 4px apart: two sizes, as the rows use. */}
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1 gap-y-1 ps-0.5">
        <span className="truncate text-sm text-foreground">{node.name}</span>
        <span {...KEEP_IN_MENU} className="row-span-2 self-start">
          <SettingsRowMenu label={`Actions for ${node.name}`} items={props.menu} />
        </span>
        <span className="truncate text-xs text-muted-foreground tabular-nums">
          {type ? `${formatBytes(node.size)} · ${type.label}` : "Folder"}
        </span>
      </div>
    </GridListItem>
  );
}

/** An image's thumbnail, faded in over its glyph once it has decoded. */
function Thumbnail(props: { node: StorageNode; url: string; raster: string }) {
  // Fetched only once the card nears the screen: a mounted card off screen fetches nothing.
  const anchor = useRef<HTMLSpanElement>(null);
  const near = useSeen(anchor);
  const thumb = useThumbnail(
    { url: props.url, version: props.node.updatedAt, size: props.node.size },
    props.raster,
    near,
  );
  const [shown, setShown] = useState(false);
  return (
    <>
      <span ref={anchor} aria-hidden className="absolute inset-0" />
      {!shown && <FileGlyph kind="image" className="size-8 text-muted-foreground" />}
      {thumb.data && (
        <img
          src={thumb.data.url}
          alt=""
          decoding="async"
          draggable={false}
          onLoad={() => setShown(true)}
          className={`absolute inset-0 size-full object-cover transition-opacity duration-200 ease-out motion-reduce:transition-none ${shown ? "opacity-100" : "opacity-0"}`}
        />
      )}
    </>
  );
}

/** True once the element comes within a screen of the viewport, and from then on. */
function useSeen(ref: RefObject<HTMLElement | null>) {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || seen) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setSeen(true);
      },
      { rootMargin: "100% 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, seen]);
  return seen;
}

/** Cards while they load: skullet's squares and captions on the cards' own grid. */
export function FileCardBones(props: { count: number }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-x-3 gap-y-4 px-3.5">
      {Array.from({ length: props.count }, (_, i) => (
        <div key={i} className="flex flex-col gap-2 p-1.5">
          <div className="aspect-square">
            <SkeletonBox width="100%" height="100%" radius="var(--radius-lg)" />
          </div>
          <SkeletonBox width={`${40 + ((i * 17) % 40)}%`} height={10} />
          <SkeletonBox width={64} height={8} />
        </div>
      ))}
    </div>
  );
}
