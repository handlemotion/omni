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
import { ProgressBar, ProgressBarTrack } from "@/components/ui/progress-bar";
import { EmptyState } from "@/components/empty/empty-state.tsx";
import { Input } from "@/components/ui/input";
import { TextField } from "@/components/ui/text-field";
import { useLinkUploading, useStorageLink, useTrashNode } from "@/hooks/use-storage.ts";
import { fileType } from "@/lib/file-kind.ts";
import { formatBytes, type StorageNode } from "@/lib/storage.ts";
import { unlockLink, type StorageLinkUpload } from "@/lib/storage-sharing.ts";
import { sharedViewUrl, sharedFileUrl } from "@/lib/urls.ts";
import { useIsMobile } from "@/hooks/use-mobile.ts";
import { CommentsPanel } from "./comments-panel.tsx";
import { isDoc } from "./editor/document-editor.tsx";
import { PreviewPanel } from "./preview/preview-panel.tsx";
import { FileGlyph } from "./file-glyph.tsx";
import { FolderCrumbs } from "./folder-crumbs.tsx";
import { FolderView, type FolderDialog } from "./folder-view.tsx";
import { LinkFrame } from "./link-frame.tsx";
import { storageErrorToast } from "./storage-errors.ts";
import { downloadFile, downloadZip } from "@/lib/download.ts";

export function LinkPage({ shareId, nodeId }: { shareId: string; nodeId?: string | undefined }) {
  const link = useStorageLink(shareId, nodeId);
  const item = link.item;
  if (!item && link.isError) {
    return (
      <LinkFrame>
        <EmptyState figure="loupe" title="Not found" />
      </LinkFrame>
    );
  }
  if (!item) return null;
  const first = link.data?.pages[0];
  const downloads = first?.downloads !== false;
  const upload = first?.uploading?.find((pending) => pending.id === item.node.id);
  if (upload) return <UploadingCard shareId={shareId} upload={upload} />;
  if (item.node.kind === "file" && isDoc(item.node)) {
    return (
      <LinkFrame>
        <PreviewPanel
          node={item.node}
          url={sharedViewUrl(shareId, item.node.id)}
          menu={[]}
          fullScreen
          shell={false}
          canWrite={item.role === "member" || item.role === "editor"}
          canComment={item.role !== "viewer"}
          canExport={downloads}
          shareId={shareId}
          sharedLive={!!first && "live" in first && first.live === true}
        />
      </LinkFrame>
    );
  }
  if (item.node.kind === "file") {
    return (
      <FileCard
        shareId={shareId}
        node={item.node}
        canComment={item.role !== "viewer"}
        downloads={downloads}
      />
    );
  }
  return (
    <SharedFolder shareId={shareId} nodeId={nodeId} link={link} item={item} downloads={downloads} />
  );
}

/** A link with a password: ask for it, then open the link in this browser. */
export function UnlockLink(props: { shareId: string; onUnlocked: () => void }) {
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <LinkFrame>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 pb-[12vh]">
        <Card className="w-full max-w-90 gap-0 px-6">
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (!password) return;
              setPending(true);
              unlockLink(props.shareId, password)
                .then(props.onUnlocked)
                .catch((error: unknown) => storageErrorToast(error, "The link did not open"))
                .finally(() => setPending(false));
            }}
          >
            <TextField
              aria-label="Password"
              type="password"
              autoFocus
              value={password}
              onChange={setPassword}
            >
              <Input placeholder="Password" autoComplete="off" />
            </TextField>
            <Button type="submit" isDisabled={!password} isPending={pending}>
              Open
            </Button>
          </form>
        </Card>
      </div>
    </LinkFrame>
  );
}

function UploadingCard(props: { shareId: string; upload: StorageLinkUpload }) {
  const uploading = useLinkUploading(props.shareId, undefined, [props.upload]);
  const upload = uploading[0] ?? props.upload;
  return (
    <LinkFrame>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4 pb-[12vh]">
        <Card className="w-full max-w-90 items-center gap-0 px-6 text-center">
          <FileGlyph
            kind={fileType(upload.name, upload.mimeType).kind}
            className="size-5 text-muted-foreground"
          />
          <h1 className="mt-3 max-w-full truncate text-base text-foreground">{upload.name}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground tabular-nums">
            {formatBytes(upload.size)}
          </p>
          <UploadProgress className="mt-5 w-full" upload={upload} />
        </Card>
      </div>
    </LinkFrame>
  );
}

function UploadProgress(props: { upload: StorageLinkUpload; className?: string }) {
  const { upload } = props;
  const percent = upload.size ? Math.floor((upload.uploadedBytes / upload.size) * 100) : 0;
  return (
    <div className={`flex flex-col gap-1.5 ${props.className ?? ""}`}>
      <div className="flex h-6 items-center gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate text-start">Uploading</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">{percent}%</span>
      </div>
      <ProgressBar aria-label={`Uploading ${upload.name}`} value={percent}>
        <ProgressBarTrack />
      </ProgressBar>
    </div>
  );
}

function FolderUploading(props: {
  shareId: string;
  nodeId: string | undefined;
  initial: StorageLinkUpload[] | undefined;
}) {
  const uploading = useLinkUploading(props.shareId, props.nodeId, props.initial);
  if (!uploading.length) return null;
  return (
    <div className="pointer-events-none absolute inset-x-4 bottom-4 z-20 flex justify-start">
      <ul className="pointer-events-auto flex max-h-72 w-80 max-w-full flex-col overflow-y-auto rounded-lg border bg-background px-3 py-1.5 shadow-(--shadow-overlay)">
        {uploading.map((upload) => (
          <li key={upload.id} className="flex h-12 shrink-0 flex-col justify-center gap-1.5">
            <div className="flex h-6 items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{upload.name}</span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {upload.size ? Math.floor((upload.uploadedBytes / upload.size) * 100) : 0}%
              </span>
            </div>
            <ProgressBar
              aria-label={`Uploading ${upload.name}`}
              value={upload.size ? (upload.uploadedBytes / upload.size) * 100 : 0}
            >
              <ProgressBarTrack />
            </ProgressBar>
          </li>
        ))}
      </ul>
    </div>
  );
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
  downloads: boolean;
}) {
  const { shareId, item, downloads: canDownload } = props;
  const canWrite = item.role === "member" || item.role === "editor";
  const canComment = item.role !== "viewer";
  const trash = useTrashNode();
  const [top = { id: item.node.id, name: item.node.name }, ...below] = item.path;
  const fileUrl = useCallback(
    (node: StorageNode) =>
      isDoc(node) ? sharedViewUrl(shareId, node.id) : sharedFileUrl(shareId, node.id),
    [shareId],
  );
  const folderHref = useCallback((node: StorageNode) => linkHref(shareId, node.id), [shareId]);
  const download = useCallback(
    (node: StorageNode) => downloadFile(sharedFileUrl(shareId, node.id)),
    [shareId],
  );
  const trashNode = trash.mutate;
  const menu = useMemo(
    () => (node: StorageNode, open: (dialog: FolderDialog) => void) => {
      const result: SettingsRowMenuItem[] = [
        ...(canDownload
          ? [
              {
                icon: IconDownload,
                label: "Download",
                onAction: () =>
                  node.kind === "file" ? download(node) : downloadZip([node.id], shareId),
              },
            ]
          : []),
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
    [canComment, canDownload, canWrite, download, shareId, trashNode],
  );
  return (
    <LinkFrame>
      <FolderUploading
        shareId={shareId}
        nodeId={props.nodeId}
        initial={props.link.data?.pages[0]?.uploading}
      />
      <FolderView
        sidebar={false}
        title={(leaf) => (
          <FolderCrumbs
            top={{ name: top.name, href: linkHref(shareId) }}
            path={below}
            href={(id) => linkHref(shareId, id)}
            leaf={leaf}
          />
        )}
        source={{
          label: item.node.name,
          place: { parentId: item.node.id },
          shareId,
          canWrite,
          canComment,
          canExport: canDownload,
          list: props.link,
          folderHref,
          fileUrl,
          download: canDownload ? download : undefined,
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

function FileCard(props: {
  shareId: string;
  node: StorageNode;
  canComment: boolean;
  downloads: boolean;
}) {
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
            {props.downloads && (
              <Button
                className="mt-5 w-full"
                onPress={() => downloadFile(sharedFileUrl(props.shareId, props.node.id))}
              >
                <IconDownload />
                Download
              </Button>
            )}
            {props.canComment && (
              <Button
                className={`${props.downloads ? "mt-2" : "mt-5"} w-full`}
                intent="outline"
                onPress={() => setComments(true)}
              >
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
