import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { SkeletonBox } from "skullet/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useReportEditing } from "@/hooks/use-file-presence.ts";
import { ApiError } from "@/lib/api.ts";
import type { LiveDoc } from "@/lib/live-doc.ts";
import { fileType, TEXT_PREVIEW_BYTES } from "@/lib/file-kind.ts";
import { storageChanged, type StorageNode } from "@/lib/storage.ts";
import { previewTextQuery } from "@/lib/storage-preview.ts";
import { abortUpload, uploadFile } from "@/lib/storage-upload.ts";
import { identityChecks, identityOf } from "@/lib/storage-uploads.ts";
import { NoPreview, StageLoading } from "../preview/shared.tsx";
import { storageErrorToast } from "../storage-errors.ts";

const RichEditor = lazy(() => import("./rich-editor.tsx"));
const SourceEditor = lazy(() => import("./source-editor.tsx"));

/** What both editors take: the text to start from, and how to read what it has become. */
export interface EditorProps {
  text: string;
  name: string;
  nodeId: string;
  /** What shows while the editor gets ready. */
  loading: ReactNode;
  /** The live document to join (a member's Markdown page); absent, the text is edited alone. */
  live?: LiveSetup | undefined;
  /** The file being edited, and the shared link it was opened through, if any. */
  file: StorageNode;
  shareId: string | undefined;
  /** Called once the editor is up, with how to read its text now. */
  onReady: (read: () => string) => void;
  onChange: () => void;
  /** False while the person only reads and comments on the doc (Commenting). */
  editable?: boolean;
}

function conflictOf(error: unknown) {
  if (!(error instanceof ApiError) || error.code !== "version_conflict") return undefined;
  const now = Number(error.details?.contentVersion ?? NaN);
  return Number.isFinite(now) ? now : undefined;
}

/** Whether a file opens in an editor: text, whole (the preview reads only its start), unlocked. */
export function canEditFile(node: StorageNode) {
  return (
    node.kind === "file" &&
    fileType(node.name, node.mimeType).preview === "text" &&
    node.size <= TEXT_PREVIEW_BYTES &&
    !node.lockedAt
  );
}

/** How a page joins its file's live document, and hears what happens to it. */
export interface LiveSetup {
  orgId: string;
  contentVersion: number;
  /** The live document, once joined; null when the live layer is off, or on close. */
  onLive: (doc: LiveDoc | null) => void;
  /** Someone started the document again from the file at `contentVersion`. */
  onReplaced: (contentVersion: number) => void;
  /** The document was saved as `contentVersion`. */
  onFolded: (contentVersion: number) => void;
  /** The stream took one of this page's changes. */
  onAcked: () => void;
}

const FOLD_MS = 2000;
const AUTOSAVE_MS = 1000;

const savedLive = async (live: LiveDoc | null, contentVersion: number) =>
  !!live && (await live.savedAs(contentVersion));
const FOLD_WAIT_MS = 5000;

const isMarkdown = (node: StorageNode) =>
  fileType(node.name, node.mimeType).language === "markdown";

/** Whether a file is a doc: Markdown that opens as a page, ready to write in. */
export function isDoc(node: StorageNode) {
  return isMarkdown(node) && canEditFile(node);
}

export type DocMode = "editing" | "commenting";

/** The open file's editing: on or off, unsaved changes, and saving them (a doc saves itself). */
export function useEditSession(
  node: StorageNode,
  url: string,
  shareId: string | undefined,
  writable = true,
) {
  const client = useQueryClient();
  const [mode, setMode] = useState<DocMode>("editing");
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<number | null>(null);
  const [opened, setOpened] = useState("");
  const read = useRef<(() => string) | null>(null);
  const base = useRef<number | undefined>(undefined);
  const changes = useRef(0);
  const session = useRef(0);
  const identity = useRef<string | null>(null);
  const live = useRef<LiveDoc | null>(null);
  const foldTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inFlight = useRef(false);
  const autosaves = isDoc(node);

  useEffect(() => {
    session.current += 1;
    clearTimeout(foldTimer.current);
    setEditing(false);
    setDirty(false);
    setConflict(null);
    setMode("editing");
  }, [node.id]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const [isLive, setIsLive] = useState(false);
  const saveRef = useRef<() => Promise<boolean>>(async () => false);
  const running = useRef<Promise<boolean>>(Promise.resolve(true));
  const leaving = useBlocker({
    shouldBlockFn: async () => {
      if (!dirty || !(live.current || autosaves)) return dirty;
      clearTimeout(foldTimer.current);
      while (inFlight.current) await running.current;
      return !(await saveRef.current());
    },
    enableBeforeUnload: false,
    withResolver: true,
  });

  useReportEditing(editing && !shareId ? node : undefined);

  const save = () => {
    if (inFlight.current) return Promise.resolve(false);
    running.current = saveNow();
    return running.current;
  };

  const saveNow = async () => {
    const text = read.current?.();
    const boundary = live.current?.boundary;
    if (!writable || text === undefined || inFlight.current) return false;
    const at = changes.current;
    const mine = session.current;
    inFlight.current = true;
    setSaving(true);
    let opened: string | undefined;
    try {
      const saved = await uploadFile({
        file: new File([text], node.name, { type: node.mimeType ?? "text/plain" }),
        place: node.parentId ? { parentId: node.parentId } : { space: node.space },
        replaces: node.id,
        ifContentVersion: base.current,
        shareId,
        signal: new AbortController().signal,
        onOpened: (uploadId) => {
          opened = uploadId;
        },
        onProgress: () => {},
        ...identityChecks(client, shareId, identity.current, new AbortController().signal),
      });
      void storageChanged(client);
      if (session.current !== mine) return false;
      base.current = saved.contentVersion;
      if (saved.contentVersion !== undefined && boundary !== undefined) {
        const folded = live.current?.folded(saved.contentVersion, boundary);
        await Promise.race([folded, new Promise((resolve) => setTimeout(resolve, FOLD_WAIT_MS))]);
      }
      if (changes.current !== at) {
        if (live.current || autosaves) latestFold.current();
        return false;
      }
      setDirty(false);
      return true;
    } catch (error) {
      if (opened) void abortUpload(opened, shareId);
      const now = session.current === mine ? conflictOf(error) : undefined;
      if (now === undefined) storageErrorToast(error, `“${node.name}” was not saved`);
      else if (await savedLive(live.current, now)) {
        base.current = now;
        latestFold.current();
      } else setConflict(now);
      return false;
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  saveRef.current = save;

  const fold = () => {
    clearTimeout(foldTimer.current);
    const mine = session.current;
    const due = () => session.current === mine && (!live.current || live.current.needsFold);
    foldTimer.current = setTimeout(
      () => due() && void saveRef.current(),
      live.current ? FOLD_MS : AUTOSAVE_MS,
    );
  };
  useEffect(() => () => clearTimeout(foldTimer.current), []);
  const latestFold = useRef(fold);
  useEffect(() => {
    latestFold.current = fold;
  });
  const reopen = (contentVersion: number) => {
    session.current += 1;
    clearTimeout(foldTimer.current);
    base.current = contentVersion;
    changes.current = 0;
    setDirty(false);
    setOpened(`${node.updatedAt}#${Date.now()}`);
  };

  return {
    editing,
    live: isLive,
    dirty,
    saving,
    conflict,
    leaving,
    start: () => {
      session.current += 1;
      identity.current = identityOf(client, shareId);
      base.current = node.contentVersion;
      changes.current = 0;
      setOpened(`${node.updatedAt}#${Date.now()}`);
      setDirty(false);
      setEditing(true);
    },
    save,
    text: () => read.current?.(),
    done: async () => {
      clearTimeout(foldTimer.current);
      await live.current?.settle();
      const unsaved = dirty || !!live.current?.needsFold;
      if (!unsaved || (await save())) setEditing(false);
    },
    keepMine: () => {
      base.current = conflict ?? base.current;
      setConflict(null);
      void save();
    },
    useTheirs: () => {
      setConflict(null);
      reopen(conflict ?? base.current ?? 0);
      void storageChanged(client);
    },
    mode,
    setMode,
    writable,
    editor: {
      editable: writable && mode === "editing",
      node,
      url,
      shareId,
      opened,
      onReady: useCallback((reader: () => string) => {
        read.current = reader;
      }, []),
      onChange: () => {
        if (!writable) return;
        changes.current += 1;
        setDirty(true);
        if (live.current || autosaves) fold();
      },
      live:
        isMarkdown(node) && !shareId && base.current !== undefined
          ? ({
              orgId: node.orgId,
              contentVersion: base.current,
              onLive: (doc: LiveDoc | null) => {
                live.current = doc;
                setIsLive(!!doc);
              },
              onReplaced: reopen,
              onAcked: () => latestFold.current(),
              onFolded: (contentVersion: number) => {
                base.current = contentVersion;
                if (!live.current?.needsFold) setDirty(false);
              },
            } satisfies LiveSetup)
          : undefined,
    },
  };
}

export type EditSession = ReturnType<typeof useEditSession>;

/** The editor for the file, on the file's whole text. ⌘S saves. */
export function DocumentEditor(props: {
  session: EditSession;
  onDownload?: (() => void) | undefined;
}) {
  const { session } = props;
  const { node, url, shareId, opened, onReady, onChange, live, editable } = session.editor;
  const kind = fileType(node.name, node.mimeType).kind;
  const text = useQuery(previewTextQuery({ url, version: `edit:${opened}`, size: node.size }));
  if (
    text.isError ||
    text.data?.binary ||
    text.data?.partial ||
    text.data?.text.includes("\uFFFD")
  ) {
    return <NoPreview kind={kind} onDownload={props.onDownload} />;
  }
  const loading = (
    <StageLoading label="Loading file">
      <div className="flex w-full flex-col gap-2.5">
        {[60, 42, 75, 30, 55].map((width, i) => (
          <SkeletonBox key={i} width={`${width}%`} height={10} />
        ))}
      </div>
    </StageLoading>
  );
  if (!text.data) return loading;
  const Editor = isMarkdown(node) ? RichEditor : SourceEditor;
  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-doc={node.id}
      onKeyDown={(event) => {
        if (event.key !== "s" || !(event.metaKey || event.ctrlKey)) return;
        event.preventDefault();
        if (session.dirty && !session.saving) void session.save();
      }}
    >
      <Suspense fallback={loading}>
        <Editor
          key={opened}
          text={text.data.text}
          name={node.name}
          nodeId={node.id}
          file={node}
          shareId={shareId}
          loading={loading}
          live={live}
          onReady={onReady}
          editable={editable}
          onChange={onChange}
        />
      </Suspense>
      <ConflictDialog session={session} />
      <LeaveDialog session={session} />
    </div>
  );
}

function LeaveDialog(props: { session: EditSession }) {
  const { session } = props;
  const { leaving } = session;
  if (leaving.status !== "blocked") return null;
  return (
    <Dialog role="alertdialog" size="sm" isOpen onOpenChange={(open) => !open && leaving.reset()}>
      <DialogHeader className="pe-0">
        <DialogTitle>Save your changes?</DialogTitle>
      </DialogHeader>
      <DialogFooter>
        <Button intent="plain" onPress={leaving.reset}>
          Cancel
        </Button>
        <Button intent="outline" onPress={leaving.proceed}>
          Don’t save
        </Button>
        <Button
          isPending={session.saving}
          onPress={() =>
            void session.save().then((saved) => (saved ? leaving.proceed : leaving.reset)())
          }
        >
          Save
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

function ConflictDialog(props: { session: EditSession }) {
  const { session } = props;
  return (
    <Dialog role="alertdialog" size="sm" isOpen={session.conflict !== null}>
      <DialogHeader className="pe-0">
        <DialogTitle>Someone saved a newer version</DialogTitle>
      </DialogHeader>
      <DialogFooter>
        <Button intent="outline" onPress={session.useTheirs}>
          Use theirs
        </Button>
        <Button onPress={session.keepMine}>Keep mine</Button>
      </DialogFooter>
    </Dialog>
  );
}
