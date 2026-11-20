import { useCallback, useMemo, useState } from "react";
import {
  IconClock3,
  IconComment,
  IconDownload,
  IconFolderMove,
  IconPencil,
  IconTrash,
} from "@/components/icons/central";
import type { SettingsRowMenuItem } from "@/components/settings/kit/settings-row-menu";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useStorageLink, useTrashNode } from "@/hooks/use-storage.ts";
import { fileType } from "@/lib/file-kind.ts";
import { formatBytes, type StorageNode } from "@/lib/storage.ts";
import { sharedFileUrl } from "@/lib/urls.ts";
import { useIsMobile } from "@/hooks/use-mobile.ts";
import { CommentsPanel } from "./comments-panel.tsx";
import { FileGlyph } from "./file-glyph.tsx";
import { FolderCrumbs } from "./folder-crumbs.tsx";
import { FolderView, type FolderDialog } from "./folder-view.tsx";
import { LinkFrame } from "./link-frame.tsx";
import { storageErrorToast } from "./storage-errors.ts";
import { downloadFile, downloadZip } from "@/lib/download.ts";

export function LinkPage({ shareId, nodeId }: { shareId: string; nodeId?: string | undefined }) {
  const link = useStorageLink(shareId, nodeId);
  const item = link.item;
  if (!item) return null;
  if (item.node.kind === "file") {
    return <FileCard shareId={shareId} node={item.node} canComment={item.role !== "viewer"} />;
  }
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
  const canWrite = item.role === "member" || item.role === "editor";
  const canComment = item.role !== "viewer";
  const trash = useTrashNode();
  const [top = { id: item.node.id, name: item.node.name }, ...below] = item.path;
  const fileUrl = useCallback((node: StorageNode) => sharedFileUrl(shareId, node.id), [shareId]);
  const folderHref = useCallback((node: StorageNode) => linkHref(shareId, node.id), [shareId]);
  const download = useCallback((node: StorageNode) => downloadFile(fileUrl(node)), [fileUrl]);
  const trashNode = trash.mutate;
  const menu = useMemo(
    () => (node: StorageNode, open: (dialog: FolderDialog) => void) => {
      const result: SettingsRowMenuItem[] = [
        {
          icon: IconDownload,
          label: "Download",
          onAction: () => (node.kind === "file" ? download(node) : downloadZip([node.id], shareId)),
        },
        ...(node.kind === "file" && canComment
          ? [
              {
                icon: IconComment,
                label: "Comments",
                onAction: () => open({ dialog: "comments", node }),
              },
            ]
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
              ...(node.kind === "file"
                ? [
                    {
                      icon: IconClock3,
                      label: "Versions",
                      onAction: () => open({ dialog: "versions", node }),
                    },
                  ]
                : []),
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
      ];
      return result;
    },
    [canComment, canWrite, download, shareId, trashNode],
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
          canTrash: () => canWrite,
          move: { kind: "link", shareId, top, path: below },
          empty: canWrite
            ? { title: "This folder is empty", description: "Drop files here or upload them." }
            : { title: "This folder is empty" },
        }}
      />
    </LinkFrame>
  );
}

function FileCard(props: { shareId: string; node: StorageNode; canComment: boolean }) {
  const [comments, setComments] = useState(false);
  const phone = useIsMobile();
  return (
    <LinkFrame>
      <div className="flex min-h-0 flex-1">
        <div
          className={`flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-y-auto p-4 pb-[12vh] ${
            comments && phone ? "hidden" : ""
          }`}
        >
          <Card className="w-full max-w-90 items-center gap-0 px-6 text-center">
            <FileGlyph
              kind={fileType(props.node.name, props.node.mimeType).kind}
              className="size-5 text-muted-foreground"
            />
            <h1 className="mt-3 max-w-full truncate text-base text-foreground">
              {props.node.name}
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground tabular-nums">
              {formatBytes(props.node.size)}
            </p>
            <Button
              className="mt-5 w-full"
              onPress={() => downloadFile(sharedFileUrl(props.shareId, props.node.id))}
            >
              <IconDownload />
              Download
            </Button>
            {props.canComment && (
              <Button className="mt-2 w-full" intent="outline" onPress={() => setComments(true)}>
                <IconComment />
                Comments
              </Button>
            )}
          </Card>
        </div>
        {comments && (
          <div className={`flex min-w-0 ${phone ? "flex-1" : "w-90 shrink-0"}`}>
            <CommentsPanel
              node={props.node}
              shareId={props.shareId}
              onClose={() => setComments(false)}
            />
          </div>
        )}
      </div>
    </LinkFrame>
  );
}
