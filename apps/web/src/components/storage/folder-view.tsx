// A folder's page, whichever door it is opened through (a member's My files or Shared, or a
// shared link): the folder as a list or a grid, files dropped anywhere on it uploaded here, the
// upload actions for whoever may write, the dialogs its rows open, and the open file's preview
// beside it (ADR 0040), or instead a file's comments (ADR 0043), narrower. The open file is the
// URL's `?file=` and the commented one its `?comments=`, so Back closes either; opening one closes
// the other.
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SettingsRowMenuItem } from "@/components/settings/kit/settings-row-menu";
import { ResizeGrip, useStoredWidth } from "@/components/ui/resize-grip";
import { useFullScreen } from "@/hooks/use-full-screen.ts";
import { useFolderDrafts } from "@/hooks/use-folder-drafts.ts";
import { useIsMobile } from "@/hooks/use-mobile.ts";
import { useUploads } from "@/hooks/use-storage.ts";
import type { StorageNode, StoragePlace } from "@/lib/storage.ts";
import { MoveDialog, RenameDialog, type MoveScope } from "./file-dialogs.tsx";
import { FolderBody, HeaderActions } from "./folder-body.tsx";
import { PreviewPanel } from "./preview/preview-panel.tsx";
import { ShareDialog } from "./share-dialog.tsx";
import { storageErrorToast } from "./storage-errors.ts";
import { StorageFrame } from "./storage-frame.tsx";
import { UploadsPanel } from "./uploads-panel.tsx";
import { VersionsDialog } from "./versions-dialog.tsx";
import { CommentsPanel } from "./comments-panel.tsx";

export type FolderDialog = {
  dialog: "rename" | "move" | "share" | "versions" | "comments";
  node: StorageNode;
} | null;

export interface FolderSource {
  /** The folder's own name, for the table and the drop target. */
  label: string;
  place: StoragePlace;
  /** Through a shared link's door; else the member's. */
  shareId?: string | undefined;
  /** New folder, Upload and drops, and the rows' changes. */
  canWrite: boolean;
  list: {
    nodes: StorageNode[];
    isPending: boolean;
    isError: boolean;
    refetch: () => unknown;
    hasNextPage: boolean;
    fetchNextPage: () => unknown;
    isFetchingNextPage: boolean;
  };
  /** Where a folder's row leads. */
  folderHref: (node: StorageNode) => string;
  /** Where a file's bytes are read through this door: Download and the preview. */
  fileUrl: (node: StorageNode) => string;
  download: (node: StorageNode) => void;
  /** The rows' actions, given the way to open this page's dialogs. */
  menu: (node: StorageNode, open: (dialog: FolderDialog) => void) => SettingsRowMenuItem[];
  move: MoveScope;
  empty: { title: string; description?: string };
}

// The preview keeps the width the person dragged it to (560px until then); the folder takes the
// rest, never under 320px, as the inbox does beside an open thread.
const PREVIEW_WIDTH = 560;
const PREVIEW_MIN = 360;
const PREVIEW_MAX = 4096;
const FOLDER_MIN = 320;
// Comments are a column of chat, not a document: a fixed 360px.
const COMMENTS_WIDTH = 360;

export function FolderView(props: {
  title: ReactNode;
  /** False outside the app shell. */
  sidebar?: boolean;
  source: FolderSource;
}) {
  const { source } = props;
  const shell = props.sidebar !== false;
  const { upload } = useUploads();
  const [dialog, setDialog] = useState<FolderDialog>(null);
  const close = () => setDialog(null);
  const send = (files: File[]) =>
    files.length > 0 &&
    upload(files, { place: source.place, shareId: source.shareId }, (name, error) =>
      storageErrorToast(error, `“${name}” was not uploaded`),
    );
  const open = useOpenFile(source.list);
  const comments = useCommentsPanel(source.list);
  // New folder shows the folder at once, its name ready to type (Finder's way, not a dialog).
  const folders = useFolderDrafts({
    place: source.place,
    shareId: source.shareId,
    nodes: source.list.nodes,
    ready: !source.list.isPending && !source.list.isError,
  });
  const drafts = useMemo(
    () => ({ list: folders.drafts, handlers: { finish: folders.finish, onType: folders.onType } }),
    [folders.drafts, folders.finish, folders.onType],
  );
  const menu = useCallback(
    (node: StorageNode) =>
      source.menu(node, (next) =>
        next?.dialog === "comments" ? comments.select(next.node.id) : setDialog(next),
      ),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the menu builder is the dependency
    [source.menu],
  );

  // Beside the preview, the folder keeps at least its minimum; full screen or on a phone the
  // preview takes the whole width.
  const [fullScreen, toggleFullScreen] = useFullScreen();
  const phone = useIsMobile();
  const node = open.node;
  const hideFolder = (!!node && (fullScreen || phone)) || (!!comments.node && phone);
  const split = !!node && !hideFolder;
  const preview = useStoredWidth(
    "omni:file-preview-width",
    PREVIEW_WIDTH,
    PREVIEW_MIN,
    PREVIEW_MAX,
  );
  const rowRef = useRef<HTMLDivElement>(null);
  const folderRef = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState(false);

  return (
    <div
      ref={rowRef}
      className={`flex min-h-0 min-w-0 ${shell ? "h-svh" : "flex-1"} ${resizing ? "cursor-ew-resize select-none" : ""}`}
    >
      <div
        ref={folderRef}
        className={`flex min-w-0 flex-1 flex-col ${split || comments.node ? "min-w-80" : ""} ${hideFolder ? "hidden" : ""}`}
      >
        <StorageFrame
          title={props.title}
          sidebar={props.sidebar}
          actions={
            <HeaderActions canWrite={source.canWrite} onNewFolder={folders.start} onFiles={send} />
          }
        >
          <FolderBody
            source={source}
            menu={menu}
            open={open}
            drafts={drafts}
            onNewFolder={folders.start}
            onFiles={send}
          />
          <UploadsPanel />
        </StorageFrame>
      </div>
      {node && (
        // Split, a fixed width that still gives way to the folder's minimum in a narrow window.
        <div
          style={split ? { width: preview.width } : undefined}
          className={`relative flex min-w-0 ${split ? "shrink" : "flex-1"}`}
          onKeyDown={(event) => {
            // ← and → step through the folder's files, Esc closes; not while a control (a
            // video's scrubber, a menu) has them.
            if (event.defaultPrevented || isControl(event.target)) return;
            const step = { ArrowLeft: open.previous, ArrowRight: open.next }[event.key];
            if (step) open.select(step.id, true);
            else if (event.key === "Escape") open.select(null);
            else return;
            event.preventDefault();
          }}
        >
          {split && (
            <ResizeGrip
              label="Resize folder"
              width={() => folderRef.current?.offsetWidth ?? 0}
              onResize={(width) =>
                preview.set((rowRef.current?.offsetWidth ?? 0) - Math.max(FOLDER_MIN, width))
              }
              onReset={preview.reset}
              onResizingChange={setResizing}
            />
          )}
          <PreviewPanel
            node={node}
            url={source.fileUrl(node)}
            previous={open.previous}
            next={open.next}
            onOpen={(other) => open.select(other.id, true)}
            onClose={() => open.select(null)}
            onDownload={() => source.download(node)}
            menu={menu(node)}
            fullScreen={hideFolder}
            onFullScreen={toggleFullScreen}
            shell={shell}
          />
        </div>
      )}
      {comments.node && (
        <div
          style={phone ? undefined : { width: COMMENTS_WIDTH }}
          className={`flex min-w-0 ${phone ? "flex-1" : "shrink"}`}
        >
          {/* Keyed: a reply or a draft on one file never carries over to the next. */}
          <CommentsPanel
            key={comments.node.id}
            node={comments.node}
            shareId={source.shareId}
            onClose={() => comments.select(null)}
          />
        </div>
      )}
      <FolderDialogs dialog={dialog} source={source} onClose={close} />
    </div>
  );
}

/** The dialog a row's action opened, if any. */
function FolderDialogs(props: { dialog: FolderDialog; source: FolderSource; onClose: () => void }) {
  const { dialog, source, onClose } = props;
  if (!dialog) return null;
  const { node } = dialog;
  switch (dialog.dialog) {
    case "rename":
      return <RenameDialog node={node} shareId={source.shareId} onClose={onClose} />;
    case "move":
      return <MoveDialog node={node} scope={source.move} onClose={onClose} />;
    case "share":
      return <ShareDialog node={node} onClose={onClose} />;
    case "versions":
      return <VersionsDialog node={node} shareId={source.shareId} onClose={onClose} />;
    case "comments":
      // A panel beside the folder, not a dialog (see `useCommentsPanel`).
      return null;
  }
}

export interface OpenFile {
  id: string | undefined;
  node: StorageNode | undefined;
  previous: StorageNode | undefined;
  next: StorageNode | undefined;
  /** Opens a file (`replace` while stepping, so Back closes the preview), or closes it. */
  select: (id: string | null, replace?: boolean) => void;
}

/**
 * The URL's open file, the files either side of it, and the way to change it. A file past the
 * folder's loaded pages (a bookmarked or shared `?file=`) loads the next pages until it is found.
 */
function useOpenFile(list: FolderSource["list"]): OpenFile {
  const { nodes } = list;
  const { file } = useSearch({ strict: false }) as { file?: string };
  useLoadUntilFound(list, file);
  const navigate = useNavigate();
  const select = useCallback(
    (id: string | null, replace = false) =>
      void navigate({
        to: ".",
        search: ((prev: Record<string, unknown>) => ({
          ...prev,
          file: id ?? undefined,
          comments: undefined,
        })) as never,
        replace,
      }),
    [navigate],
  );
  return useMemo(() => {
    const files = nodes.filter((n) => n.kind === "file");
    const at = file ? files.findIndex((n) => n.id === file) : -1;
    return {
      id: file,
      node: files[at],
      previous: at > 0 ? files[at - 1] : undefined,
      next: at >= 0 ? files[at + 1] : undefined,
      select,
    };
  }, [nodes, file, select]);
}

/** Loads the folder's next pages until `id` (a bookmarked or shared URL's) is among its nodes. */
function useLoadUntilFound(list: FolderSource["list"], id: string | undefined) {
  const { nodes, hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  const loaded = !id || nodes.some((n) => n.id === id);
  useEffect(() => {
    if (!loaded && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [loaded, hasNextPage, isFetchingNextPage, fetchNextPage]);
}

/** The URL's commented file (a file of this folder), and the way to open or close its comments. */
function useCommentsPanel(list: FolderSource["list"]) {
  const { nodes } = list;
  const { comments } = useSearch({ strict: false }) as { comments?: string };
  useLoadUntilFound(list, comments);
  const navigate = useNavigate();
  const select = useCallback(
    (id: string | null) =>
      void navigate({
        to: ".",
        search: ((prev: Record<string, unknown>) => ({
          ...prev,
          file: undefined,
          comments: id ?? undefined,
        })) as never,
      }),
    [navigate],
  );
  const node = comments ? nodes.find((n) => n.id === comments && n.kind === "file") : undefined;
  return { node, select };
}

/** Keys inside these belong to them: fields, media controls and open menus. */
function isControl(target: EventTarget) {
  return (
    target instanceof Element &&
    !!target.closest("input, textarea, select, video, audio, [role=menu], [role=slider]")
  );
}
