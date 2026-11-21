import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { SettingsRowMenuItem } from "@/components/settings/kit/settings-row-menu";
import { ResizeGrip, useStoredWidth } from "@/components/ui/resize-grip";
import { useFullScreen } from "@/hooks/use-full-screen.ts";
import { useFolderDrafts } from "@/hooks/use-folder-drafts.ts";
import { useInlineRename, type RenameAt } from "@/hooks/use-inline-rename.ts";
import { useIsMobile } from "@/hooks/use-mobile.ts";
import { useNewDoc } from "@/hooks/use-new-doc.ts";
import { useNodeSelection, type NodeSelection } from "@/hooks/use-node-selection.ts";
import { useUploads } from "@/hooks/use-storage.ts";
import { storageNodeQuery } from "@/lib/storage-comments.ts";
import type { StorageNode, StoragePlace } from "@/lib/storage.ts";
import type { Picked } from "@/lib/storage-upload-tree.ts";
import { MoveDialog, type MoveScope } from "./file-dialogs.tsx";
import { FolderIconDialog } from "./folder-icons.tsx";
import { FolderBody, folderIsEmpty, HeaderActions } from "./folder-body.tsx";
import { PreviewPanel } from "./preview/preview-panel.tsx";
import { SelectionBar, useBulkTrash } from "./selection-bar.tsx";
import { ShareDialog } from "./share-dialog.tsx";
import { SignaturesDialog } from "./signatures-dialog.tsx";
import { storageErrorToast } from "./storage-errors.ts";
import { StorageFrame } from "./storage-frame.tsx";
import { UploadsPanel } from "./uploads-panel.tsx";
import { VersionsDialog } from "./versions-dialog.tsx";
import { CommentsPanel } from "./comments-panel.tsx";

export type FolderDialog = {
  dialog: "rename" | "move" | "share" | "versions" | "comments" | "signatures" | "icon";
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
  /** Absent on a view-only link: no Download, alone or as a zip. */
  download?: ((node: StorageNode) => void) | undefined;
  /** The rows' actions, given the way to open this page's dialogs. */
  menu: (node: StorageNode, open: (dialog: FolderDialog) => void) => SettingsRowMenuItem[];
  /** Whether Move to trash is offered for it, alone or in a selection. */
  canTrash: (node: StorageNode) => boolean;
  move: MoveScope;
  empty: { title: string; description?: string };
}

const PREVIEW_WIDTH = 560;

const downloadOf = (source: FolderSource, node: StorageNode) => {
  const { download } = source;
  return download && (() => download(node));
};
const PREVIEW_MIN = 360;
const PREVIEW_MAX = 4096;
const FOLDER_MIN = 320;
const COMMENTS_WIDTH = 360;

export function FolderView(props: {
  title: ReactNode;
  /** False outside the app shell. */
  sidebar?: boolean;
  source: FolderSource;
  /** More of the header's actions, before New folder and Upload (a CRM record's Add from Drive). */
  actions?: ReactNode;
}) {
  const { source } = props;
  const shell = props.sidebar !== false;
  const { upload } = useUploads();
  const [dialog, setDialog] = useState<FolderDialog>(null);
  const close = () => setDialog(null);
  const send = (files: File[] | Picked) =>
    (Array.isArray(files) ? files.length > 0 : files.files.length + files.folders.length > 0) &&
    upload(files, { place: source.place, shareId: source.shareId }, (name, error) =>
      storageErrorToast(error, `“${name}” was not uploaded`),
    );
  const open = useOpenFile(source.list, source.shareId ? undefined : source.place);
  const selection = useNodeSelection(source.list.nodes, placeKeyOf(source), open.id);
  const [movingSelection, setMovingSelection] = useState(false);
  const selectionKeys = useSelectionKeys(selection, source);
  const comments = useCommentsPanel(source.list);
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
  const { rename, start: startRename } = useInlineRename({
    shareId: source.shareId,
    nodes: source.list.nodes,
  });
  const menuAt = useCallback(
    (at: RenameAt) => (node: StorageNode) =>
      source.menu(node, (next) => {
        if (next?.dialog === "comments") comments.select(next.node.id);
        else if (next?.dialog === "rename") startRename(next.node, at);
        else setDialog(next);
      }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- the menu builder is the dependency
    [source.menu, startRename],
  );
  const menu = useMemo(() => menuAt("list"), [menuAt]);

  const docs = useDocs(source, open);
  const phone = useIsMobile();
  const node = open.node;
  const hideFolder = (!!node && (docs.wide || phone)) || (!!comments.node && phone);
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
            <FolderActions
              extra={props.actions}
              empty={folderIsEmpty(source, drafts)}
              selection={selection}
              source={source}
              onNewFolder={folders.start}
              onNewDoc={docs.make}
              newDocPending={docs.making}
              onFiles={send}
              onMove={() => setMovingSelection(true)}
            />
          }
        >
          <FolderBody
            source={source}
            selection={selection}
            onKeyDown={selectionKeys}
            menu={menu}
            open={open}
            drafts={drafts}
            rename={rename}
            extra={props.actions}
            onNewFolder={folders.start}
            onNewDoc={docs.make}
            newDocPending={docs.making}
            onFiles={send}
          />
          <UploadsPanel />
        </StorageFrame>
      </div>
      {node && (
        <div
          style={split ? { width: preview.width } : undefined}
          className={`relative flex min-w-0 ${split ? "shrink" : "flex-1"}`}
          onKeyDown={(event) => {
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
            onClose={() => open.select(null)}
            onDownload={downloadOf(source, node)}
            menu={menuAt("preview")(node)}
            rename={rename}
            fullScreen={hideFolder}
            onFullScreen={docs.toggleWide}
            shell={shell}
            canWrite={source.canWrite}
            shareId={source.shareId}
          />
        </div>
      )}
      {comments.node && (
        <div
          style={phone ? undefined : { width: COMMENTS_WIDTH }}
          className={`flex min-w-0 ${phone ? "flex-1" : "shrink"}`}
        >
          <CommentsPanel
            key={comments.node.id}
            node={comments.node}
            shareId={source.shareId}
            onClose={() => comments.select(null)}
          />
        </div>
      )}
      <FolderDialogs dialog={dialog} source={source} onClose={close} />
      <MoveSelection
        open={movingSelection}
        selection={selection}
        scope={source.move}
        onClose={() => setMovingSelection(false)}
      />
    </div>
  );
}

function useDocs(source: FolderSource, open: OpenFile) {
  const made = useNewDoc(source.place, source.shareId, (node) => open.select(node.id));
  const [fullScreen, toggleFullScreen] = useFullScreen();
  return {
    make: source.shareId
      ? undefined
      : () =>
          made.mutate(undefined, {
            onError: (error) => storageErrorToast(error, "The doc was not made"),
          }),
    making: made.isPending,
    wide: fullScreen,
    toggleWide: toggleFullScreen,
  };
}

function FolderDialogs(props: { dialog: FolderDialog; source: FolderSource; onClose: () => void }) {
  const { dialog, source, onClose } = props;
  if (!dialog) return null;
  const { node } = dialog;
  switch (dialog.dialog) {
    case "move":
      return <MoveDialog nodes={[node]} scope={source.move} onClose={onClose} />;
    case "share":
      return <ShareDialog node={node} onClose={onClose} />;
    case "versions":
      return <VersionsDialog node={node} shareId={source.shareId} onClose={onClose} />;
    case "icon":
      return <FolderIconDialog node={node} onClose={onClose} />;
    case "comments":
    case "rename":
      return null;
    case "signatures":
      return <SignaturesDialog node={node} onClose={onClose} />;
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

const useOpenFile: (list: FolderSource["list"], place: StoragePlace | undefined) => OpenFile = (
  list,
  place,
) => {
  const { nodes } = list;
  const { file } = useSearch({ strict: false }) as { file?: string };
  useLoadUntilFound(list, file);
  const direct = useDeepLinkedFile(nodes, file, place);
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
      node: files[at] ?? direct,
      previous: at > 0 ? files[at - 1] : undefined,
      next: at >= 0 ? files[at + 1] : undefined,
      select,
    };
  }, [nodes, file, select, direct]);
};

function useDeepLinkedFile(
  nodes: StorageNode[],
  id: string | undefined,
  place: StoragePlace | undefined,
) {
  const listed = !id || nodes.some((n) => n.id === id);
  const read = useQuery({ ...storageNodeQuery(id ?? ""), enabled: !listed && !!place });
  const node = read.data?.node;
  if (listed || !node || !place || node.kind !== "file") return undefined;
  const here =
    "parentId" in place
      ? node.parentId === place.parentId
      : node.parentId === null && node.space === place.space;
  return here ? node : undefined;
}

function useLoadUntilFound(list: FolderSource["list"], id: string | undefined) {
  const { nodes, hasNextPage, isFetchingNextPage, fetchNextPage } = list;
  const loaded = !id || nodes.some((n) => n.id === id);
  useEffect(() => {
    if (!loaded && hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [loaded, hasNextPage, isFetchingNextPage, fetchNextPage]);
}

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

function isControl(target: EventTarget) {
  return (
    target instanceof Element &&
    !!target.closest(
      "input, textarea, select, [contenteditable=true], video, audio, [role=menu], [role=slider]",
    )
  );
}

const placeKeyOf = (source: FolderSource) =>
  `${source.shareId ?? ""}:${"parentId" in source.place ? source.place.parentId : source.place.space}`;

function useSelectionKeys(selection: NodeSelection, source: FolderSource) {
  const trash = useBulkTrash(source.shareId);
  return (event: KeyboardEvent) => {
    if (event.defaultPrevented || isControl(event.target)) return;
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "a") {
      event.stopPropagation();
      selection.selectAll();
    } else if (event.key === "Escape" && selection.active) {
      selection.clear();
    } else if (
      selection.active &&
      ((mod && event.key === "Backspace") || event.key === "Delete") &&
      selection.nodes.every(source.canTrash)
    ) {
      void trash.run(selection.nodes).then(selection.clear);
    } else {
      return;
    }
    event.preventDefault();
  };
}

function FolderActions(props: {
  extra: ReactNode;
  empty: boolean;
  selection: NodeSelection;
  source: FolderSource;
  onNewFolder: () => void;
  onNewDoc: (() => void) | undefined;
  newDocPending: boolean;
  onFiles: (files: File[] | Picked) => void;
  onMove: () => void;
}) {
  const { selection, source } = props;
  if (!selection.active) {
    if (props.empty) return null;
    return (
      <>
        {props.extra}
        <HeaderActions
          canWrite={source.canWrite}
          onNewFolder={props.onNewFolder}
          onNewDoc={props.onNewDoc}
          newDocPending={props.newDocPending}
          onFiles={props.onFiles}
        />
      </>
    );
  }
  return (
    <SelectionBar
      selection={selection}
      shareId={source.shareId}
      canMove={source.canWrite}
      canDownload={!!source.download}
      canTrash={source.canTrash}
      onMove={props.onMove}
    />
  );
}

function MoveSelection(props: {
  open: boolean;
  selection: NodeSelection;
  scope: MoveScope;
  onClose: () => void;
}) {
  const { selection } = props;
  if (!props.open || !selection.active) return null;
  return (
    <MoveDialog
      nodes={selection.nodes}
      scope={props.scope}
      onClose={() => {
        props.onClose();
        selection.clear();
      }}
    />
  );
}
