import { useEffect, useState, type RefObject } from "react";
import { SkeletonBox } from "skullet/react";
import {
  SettingsRowMenu,
  type SettingsRowMenuItem,
} from "@/components/settings/kit/settings-row-menu";
import { GridListItem } from "@/components/ui/grid-list";
import { fileType, type FileType } from "@/lib/file-kind.ts";
import { formatBytes, type StorageNode } from "@/lib/storage.ts";
import { AudioArt, VideoArt } from "./card-art/media.tsx";
import { FilePage, hasPage } from "./card-art/page.tsx";
import { FileGlyph } from "./file-glyph.tsx";
import { FolderArt } from "./folder-art.tsx";
import { CARD_DROP_TARGET, LIFTED, useSurfaceDrag, type NodeDrag } from "./node-drag.tsx";
import { NodeName, type ItemName } from "./name-field.tsx";
import { PdfStack } from "./pdf-stack.tsx";
import { useWarmOnHover } from "./preview/warm-preview.ts";
import { cardThumbnailSize, hasThumbnail, ThumbnailImage } from "./thumbnail-image.tsx";

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
  /** Where a folder's contents' bytes are read, for the sheets in its pocket. */
  fileUrl?: (node: StorageNode) => string;
  /**
   * False through a shared link's door: its folders draw the bare pocket, and its files' cards read
   * no bytes (a link's content route counts each read from the start as a download).
   */
  peek?: boolean | undefined;
  /** Its name as a field, while it is renamed. */
  name?: ItemName | undefined;
  /** Lifting it onto folders, and folders taking drops (`node-drag.tsx`); off without it. */
  drag?: NodeDrag | undefined;
}) {
  const { node } = props;
  const type = node.kind === "file" ? fileType(node.name, node.mimeType) : null;
  const lift = useSurfaceDrag(node, "card", props.drag);
  const warm = useWarmOnHover(node, props.url);
  return (
    <GridListItem
      ref={lift.ref}
      {...lift.props}
      {...warm}
      id={node.id}
      href={props.href}
      textValue={node.name}
      className={`flex-col items-stretch gap-2 rounded-xl p-1.5 *:*:data-[slot=control]:absolute *:*:data-[slot=control]:start-3 *:*:data-[slot=control]:top-3 *:*:data-[slot=control]:z-10 transition-[background-color,scale] duration-150 ease-out hover:bg-hover active:scale-[.99] selected:bg-accent motion-reduce:transition-none ${CARD_DROP_TARGET} ${LIFTED}`}
    >
      {node.kind === "folder" ? (
        <FolderArt node={node} peek={props.peek} fileUrl={props.fileUrl} />
      ) : (
        <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-lg border bg-surface">
          {type && <FileArt node={node} type={type} url={props.url} read={props.peek !== false} />}
        </div>
      )}
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1 gap-y-1 ps-0.5">
        <NodeName node={node} name={props.name} card />
        <span {...KEEP_IN_MENU} className="row-span-2 self-start">
          <SettingsRowMenu label={`Actions for ${node.name}`} items={props.menu} lazy />
        </span>
        <span className="truncate text-xs text-muted-foreground tabular-nums">
          {type ? `${formatBytes(node.size)} · ${type.label}` : "Folder"}
        </span>
      </div>
    </GridListItem>
  );
}

function FileArt(props: { node: StorageNode; type: FileType; url: string; read: boolean }) {
  const { node, type, url } = props;
  if (hasThumbnail(node)) return <Thumbnail node={node} url={url} />;
  if (type.preview === "pdf") return <PdfStack node={node} url={url} />;
  if (!props.read) return <FileGlyph kind={type.kind} className="size-8 text-muted-foreground" />;
  if (node.size > 0 && type.preview === "video") {
    return <VideoArt key={versionOf(node)} node={node} url={versioned(url, node)} />;
  }
  if (node.size > 0 && type.preview === "audio") {
    return <AudioArt key={versionOf(node)} node={node} url={versioned(url, node)} />;
  }
  if (hasPage(node, type)) return <FilePage node={node} type={type} url={url} />;
  return <FileGlyph kind={type.kind} className="size-8 text-muted-foreground" />;
}

const versionOf = (node: StorageNode) => String(node.contentVersion ?? node.updatedAt);

const versioned = (url: string, node: StorageNode) => {
  const named = new URL(url, window.location.origin);
  named.searchParams.set("v", versionOf(node));
  return named.toString();
};

function Thumbnail(props: { node: StorageNode; url: string }) {
  return (
    <>
      <FileGlyph kind="image" className="size-8 text-muted-foreground" />
      <ThumbnailImage
        node={props.node}
        url={props.url}
        size={cardThumbnailSize()}
        className="absolute inset-0 size-full object-cover"
      />
    </>
  );
}

/** True once the element comes within a screen of the viewport, and from then on. */
export function useSeen(ref: RefObject<HTMLElement | null>) {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || seen) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
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
    <div className="grid grid-cols-[repeat(auto-fill,11.5rem)] gap-x-3 gap-y-4 px-3.5">
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
