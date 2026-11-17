// Editing a text file in Drive (ADR 0043): a Markdown file as a page (Tiptap), any other text file
// as text (CodeMirror), each on its own chunk. Save writes a new version, checked against the
// version the editor opened (decision 3): if someone saved since, the person keeps theirs or
// takes the newer one. While it is open, the others who see the file hear "editing". With the
// live layer, a member's Markdown page is the file's live document (step 2): everyone editing it
// types into the same page, and the last to type saves it a moment after they stop.
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
  /** Called once the editor is up, with how to read its text now. */
  onReady: (read: () => string) => void;
  onChange: () => void;
}

/** The file's content version now, when a save was refused because someone saved since. */
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

/** A moment after the last keystroke, the live document is saved. */
const FOLD_MS = 2000;
/** How long a save waits for the others to hear it was saved. */
const FOLD_WAIT_MS = 5000;

const isMarkdown = (node: StorageNode) =>
  fileType(node.name, node.mimeType).language === "markdown";

/** The open file's editing: on or off, unsaved changes, and saving them. */
export function useEditSession(node: StorageNode, url: string, shareId: string | undefined) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  /** The file's content version now, when a save found someone saved since the editor opened. */
  const [conflict, setConflict] = useState<number | null>(null);
  /**
   * Which read of the file the editor is on: set when it opens, and again for "use theirs". The
   * editor's own saves change the node but not this, so they never reload what is being typed.
   */
  const [opened, setOpened] = useState("");
  const read = useRef<(() => string) | null>(null);
  /** The content version the editor's text was made from: what a save is checked against. */
  const base = useRef<number | undefined>(undefined);
  /** Changes since the editor opened, so a save does not clear a change typed while it ran. */
  const changes = useRef(0);
  /** Which editing session this is: a save that ends after it closed changes nothing of the next. */
  const session = useRef(0);
  /** Who opened the editor: a save goes out as them or not at all (`identityOf`). */
  const identity = useRef<string | null>(null);
  /** The file's live document while the page is on it. */
  const live = useRef<LiveDoc | null>(null);
  const foldTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  /** A save on its way: a second at once would be refused as stale by the first. */
  const inFlight = useRef(false);

  // Another file: not editing it.
  useEffect(() => {
    session.current += 1;
    setEditing(false);
    setDirty(false);
    setConflict(null);
  }, [node.id]);

  // Leaving the page with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Leaving the file, the folder or the page in the app with unsaved changes asks first.
  const leaving = useBlocker({
    shouldBlockFn: () => dirty,
    enableBeforeUnload: false,
    withResolver: true,
  });

  // Shared links have no socket: presence is for members.
  useReportEditing(editing && !shareId ? node : undefined);

  const save = async () => {
    const text = read.current?.();
    // What of the live document this text holds: its fold claims that much, not what lands later.
    const boundary = live.current?.boundary;
    if (text === undefined || inFlight.current) return false;
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
        // Another tab may have switched the account or workspace since the editor opened.
        ...identityChecks(client, shareId, identity.current, new AbortController().signal),
      });
      void storageChanged(client);
      if (session.current !== mine) return false;
      base.current = saved.contentVersion;
      // The others on the live document learn it is saved, and as which version.
      if (saved.contentVersion !== undefined && boundary !== undefined) {
        // Not past a while: with the socket down the fold waits for it, and the save is done.
        const folded = live.current?.folded(saved.contentVersion, boundary);
        await Promise.race([folded, new Promise((resolve) => setTimeout(resolve, FOLD_WAIT_MS))]);
      }
      // Typed while it saved: still unsaved, and not done. On a live document the save that
      // came due meanwhile was skipped for this one, so the next is scheduled here.
      if (changes.current !== at) {
        if (live.current) latestFold.current();
        return false;
      }
      setDirty(false);
      return true;
    } catch (error) {
      // An upload left open would count against the workspace's room until it expires.
      if (opened) void abortUpload(opened, shareId);
      // An earlier session's file was not saved, and nothing of this session changes.
      const now = session.current === mine ? conflictOf(error) : undefined;
      if (now === undefined) storageErrorToast(error, `“${node.name}” was not saved`);
      else setConflict(now);
      return false;
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  // On a live document only the last to type saves, so a page saves once for everyone.
  const fold = () => {
    clearTimeout(foldTimer.current);
    foldTimer.current = setTimeout(() => {
      if (live.current?.needsFold) void save();
    }, FOLD_MS);
  };
  useEffect(() => () => clearTimeout(foldTimer.current), []);
  // The live document keeps the callbacks of the render that opened it: this one is always now's.
  const latestFold = useRef(fold);
  useEffect(() => {
    latestFold.current = fold;
  });
  const reopen = (contentVersion: number) => {
    base.current = contentVersion;
    changes.current = 0;
    setDirty(false);
    setOpened(`${node.updatedAt}#${Date.now()}`);
  };

  return {
    editing,
    dirty,
    saving,
    conflict,
    /** A move away from the file while it has unsaved changes, held until the person picks. */
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
    /** Saves what is unsaved, then closes the editor. */
    done: async () => {
      clearTimeout(foldTimer.current);
      // This tab's changes reach the others first: closing would drop those still on their way.
      await live.current?.settle();
      const unsaved = dirty || !!live.current?.needsFold;
      if (!unsaved || (await save())) setEditing(false);
    },
    /** Saves over the newer version: the person's text wins. */
    keepMine: () => {
      base.current = conflict ?? base.current;
      setConflict(null);
      void save();
    },
    /**
     * Drops the unsaved changes and opens the newer version. A live document starts again from it,
     * and everyone on it reopens.
     */
    useTheirs: () => {
      setConflict(null);
      reopen(conflict ?? base.current ?? 0);
      void storageChanged(client);
    },
    editor: {
      node,
      url,
      opened,
      onReady: useCallback((reader: () => string) => {
        read.current = reader;
      }, []),
      onChange: () => {
        changes.current += 1;
        setDirty(true);
        if (live.current) fold();
      },
      /** For a member's Markdown page: its file's live document. */
      live:
        isMarkdown(node) && !shareId && base.current !== undefined
          ? ({
              orgId: node.orgId,
              contentVersion: base.current,
              onLive: (doc: LiveDoc | null) => {
                live.current = doc;
              },
              onReplaced: reopen,
              // A change the stream took late (after a drop) is saved as one typed now would be.
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
export function DocumentEditor(props: { session: EditSession; onDownload: () => void }) {
  const { session } = props;
  const { node, url, opened, onReady, onChange, live } = session.editor;
  const kind = fileType(node.name, node.mimeType).kind;
  // Read afresh for each opening, never from the preview's cache: it may be an older version.
  const text = useQuery(previewTextQuery({ url, version: `edit:${opened}`, size: node.size }));
  // Not UTF-8 (a replacement character where a byte did not decode): a save would write the
  // replacement in place of what was there.
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
          loading={loading}
          live={live}
          onReady={onReady}
          onChange={onChange}
        />
      </Suspense>
      <ConflictDialog session={session} />
      <LeaveDialog session={session} />
    </div>
  );
}

/** Leaving with unsaved changes: save them first, drop them, or stay. */
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

/** Someone saved since the editor opened: keep this text over theirs, or take theirs. */
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
