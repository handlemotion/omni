// What `/s/<shareId>` opens (ADR 0034 decision 8, after Salesforce's shared file page), signed in
// or not: a file is a card with its name, size and Download; a folder is its page, with its
// place inside what was shared in the title. An Editor (or a member of its workspace) changes
// what is inside through the link's own door; sharing it on is the owner's, from Storage.
import { useCallback, useMemo } from "react";
import {
  IconDownload,
  IconFile,
  IconFolderMove,
  IconPencil,
  IconTrash,
} from "@/components/icons/central";
import type { SettingsRowMenuItem } from "@/components/settings/kit/settings-row-menu";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useStorageLink, useTrashNode } from "@/hooks/use-storage.ts";
import { formatBytes, type StorageNode } from "@/lib/storage.ts";
import { sharedFileUrl } from "@/lib/urls.ts";
import { FolderCrumbs } from "./folder-crumbs.tsx";
import { FolderView, type FolderDialog } from "./folder-view.tsx";
import { LinkFrame } from "./link-frame.tsx";
import { storageErrorToast } from "./storage-errors.ts";

export function LinkPage({ shareId, nodeId }: { shareId: string; nodeId?: string | undefined }) {
  const link = useStorageLink(shareId, nodeId);
  const item = link.item;
  // The route's loader waited for it; a link that opens nothing never renders this page.
  if (!item) return null;
  if (item.node.kind === "file") return <FileCard shareId={shareId} node={item.node} />;
  return <SharedFolder shareId={shareId} nodeId={nodeId} link={link} item={item} />;
}

type Link = ReturnType<typeof useStorageLink>;
type Item = NonNullable<Link["item"]>;

const linkHref = (shareId: string, folderId?: string) =>
  `/s/${encodeURIComponent(shareId)}${folderId ? `?node=${encodeURIComponent(folderId)}` : ""}`;

function SharedFolder(props: {
  shareId: string;
  nodeId: string | undefined;
  link: Link;
  item: Item;
}) {
  const { shareId, item } = props;
  const canWrite = item.role !== "viewer";
  const trash = useTrashNode();
  // `path` runs from what was shared down to this folder.
  const [top = { id: item.node.id, name: item.node.name }, ...below] = item.path;
  // Stable, so the memoized table and grid render only when their rows change.
  const fileUrl = useCallback((node: StorageNode) => sharedFileUrl(shareId, node.id), [shareId]);
  const folderHref = useCallback((node: StorageNode) => linkHref(shareId, node.id), [shareId]);
  const download = useCallback(
    (node: StorageNode) => window.location.assign(fileUrl(node)),
    [fileUrl],
  );
  const trashNode = trash.mutate;
  const menu = useMemo(
    () =>
      (node: StorageNode, open: (dialog: FolderDialog) => void): SettingsRowMenuItem[] => [
        ...(node.kind === "file"
          ? [{ icon: IconDownload, label: "Download", onAction: () => download(node) }]
          : []),
        ...(canWrite
          ? [
              {
                icon: IconPencil,
                label: "Rename",
                onAction: () => open({ dialog: "rename", node }),
              },
              {
                icon: IconFolderMove,
                label: "Move",
                onAction: () => open({ dialog: "move", node }),
              },
              {
                icon: IconTrash,
                label: "Move to trash",
                danger: true,
                onAction: () =>
                  trashNode(
                    { id: node.id, shareId },
                    { onError: (error) => storageErrorToast(error, "It was not moved to Trash") },
                  ),
              },
            ]
          : []),
      ],
    [canWrite, download, shareId, trashNode],
  );
  return (
    <LinkFrame>
      <FolderView
        sidebar={false}
        title={
          <FolderCrumbs
            top={{ name: top.name, href: linkHref(shareId) }}
            path={below}
            href={(id) => linkHref(shareId, id)}
          />
        }
        source={{
          label: item.node.name,
          place: { parentId: item.node.id },
          shareId,
          canWrite,
          list: props.link,
          folderHref,
          fileUrl,
          download,
          menu,
          move: { kind: "link", shareId, top, path: below },
          empty: canWrite
            ? { title: "This folder is empty", description: "Drop files here or upload them." }
            : { title: "This folder is empty" },
        }}
      />
    </LinkFrame>
  );
}

/**
 * One shared file: a card a little above the page's middle, its name, its size, Download.
 * Geometry: a 360px card, 24px in; the 20px file mark, then 12px to the name, 2px to the size,
 * 20px to the button.
 */
function FileCard(props: { shareId: string; node: StorageNode }) {
  return (
    <LinkFrame>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4 pb-[12vh]">
        <Card className="w-full max-w-90 items-center gap-0 px-6 text-center">
          <IconFile aria-hidden className="size-5 text-muted-foreground" />
          <h1 className="mt-3 max-w-full truncate text-base text-foreground">{props.node.name}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground tabular-nums">
            {formatBytes(props.node.size)}
          </p>
          <Button
            className="mt-5 w-full"
            onPress={() => window.location.assign(sharedFileUrl(props.shareId, props.node.id))}
          >
            <IconDownload />
            Download
          </Button>
        </Card>
      </div>
    </LinkFrame>
  );
}
