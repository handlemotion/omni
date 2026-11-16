// A folder's page, whichever door it is opened through (a member's My files or Shared, or a
// shared link): the folder as a list or a grid, files dropped anywhere on it uploaded here, the
// upload actions for whoever may write, the dialogs its rows open, and the open file's preview
// beside it (ADR 0040). The open file is the URL's `?file=`, so Back closes it.
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SettingsRowMenuItem } from "@/components/settings/kit/settings-row-menu";
import { ResizeGrip, useStoredWidth } from "@/components/ui/resize-grip";
import { useFullScreen } from "@/hooks/use-full-screen.ts";
import { useIsMobile } from "@/hooks/use-mobile.ts";
import { useUploads } from "@/hooks/use-storage.ts";
import type { StorageNode, StoragePlace } from "@/lib/storage.ts";
import { MoveDialog, NewFolderDialog, RenameDialog, type MoveScope } from "./file-dialogs.tsx";
import { FolderBody, HeaderActions } from "./folder-body.tsx";
import { PreviewPanel } from "./preview/preview-panel.tsx";
import { ShareDialog } from "./share-dialog.tsx";
import { storageErrorToast } from "./storage-errors.ts";
import { StorageFrame } from "./storage-frame.tsx";
import { UploadsPanel } from "./uploads-panel.tsx";

export type FolderDialog =
  | { dialog: "new" }
  | { dialog: "rename" | "move" | "share"; node: StorageNode }
  | null;

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
  const menu = useCallback(
    (node: StorageNode) => source.menu(node, setDialog),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the menu builder is the dependency
    [source.menu],
  );

  // Beside the preview, the folder keeps at least its minimum; full screen or on a phone the
  // preview takes the whole width.
  const [fullScreen, toggleFullScreen] = useFullScreen();
  const phone = useIsMobile();
  const node = open.node;
  const hideFolder = !!node && (fullScreen || phone);
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
        className={`flex min-w-0 flex-1 flex-col ${split ? "min-w-80" : ""} ${hideFolder ? "hidden" : ""}`}
      >
        <StorageFrame
          title={props.title}
          sidebar={props.sidebar}
          actions={
            <HeaderActions
              canWrite={source.canWrite}
              onNewFolder={() => setDialog({ dialog: "new" })}
              onFiles={send}
            />
          }
        >
          <FolderBody
            source={source}
            menu={menu}
            open={open}
            onNewFolder={() => setDialog({ dialog: "new" })}
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
      {dialog?.dialog === "new" && (
        <NewFolderDialog place={source.place} shareId={source.shareId} onClose={close} />
      )}
      {dialog?.dialog === "rename" && (
        <RenameDialog node={dialog.node} shareId={source.shareId} onClose={close} />
      )}
      {dialog?.dialog === "move" && (
        <MoveDialog node={dialog.node} scope={source.move} onClose={close} />
      )}
      {dialog?.dialog === "share" && <ShareDialog node={dialog.node} onClose={close} />}
    </div>
  );
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
  const { nodes, hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  const { file } = useSearch({ strict: false }) as { file?: string };
  const loaded = !file || nodes.some((n) => n.id === file);
  useEffect(() => {
    if (!loaded && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [loaded, hasNextPage, isFetchingNextPage, fetchNextPage]);
  const navigate = useNavigate();
  const select = useCallback(
    (id: string | null, replace = false) =>
      void navigate({
        to: ".",
        search: ((prev: Record<string, unknown>) => ({ ...prev, file: id ?? undefined })) as never,
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

/** Keys inside these belong to them: fields, media controls and open menus. */
function isControl(target: EventTarget) {
  return (
    target instanceof Element &&
    !!target.closest("input, textarea, select, video, audio, [role=menu], [role=slider]")
  );
}
