// Editing a text file in Drive (ADR 0043): a Markdown file as a page (Tiptap), any other text file
// as text (CodeMirror), each on its own chunk. Save writes a new version, checked against the
// version the editor opened (decision 3): if someone saved since, the person keeps theirs or
// takes the newer one. While it is open, the others who see the file hear "editing".
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useBlocker } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { SkeletonBox } from "skullet/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useReportEditing } from "@/hooks/use-file-presence.ts";
import { ApiError } from "@/lib/api.ts";
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
  /** Called once the editor is up, with how to read its text now. */
  onReady: (read: () => string) => void;
  onChange: () => void;
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
    if (text === undefined) return false;
    const at = changes.current;
    const mine = session.current;
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
      // Typed while it saved: still unsaved, and not done.
      if (changes.current !== at) return false;
      setDirty(false);
      return true;
    } catch (error) {
      // An upload left open would count against the workspace's room until it expires.
      if (opened) void abortUpload(opened, shareId);
      // An earlier session's file: it was not saved, and nothing of this session changes.
      if (session.current !== mine) {
        storageErrorToast(error, `“${node.name}” was not saved`);
        return false;
      }
      const now = Number((error instanceof ApiError && error.details?.contentVersion) ?? NaN);
      if (error instanceof ApiError && error.code === "version_conflict" && Number.isFinite(now)) {
        setConflict(now);
      } else {
        storageErrorToast(error, `“${node.name}” was not saved`);
      }
      return false;
    } finally {
      setSaving(false);
    }
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
      if (!dirty || (await save())) setEditing(false);
    },
    /** Saves over the newer version: the person's text wins. */
    keepMine: () => {
      base.current = conflict ?? base.current;
      setConflict(null);
      void save();
    },
    /** Drops the unsaved changes and opens the newer version. */
    useTheirs: () => {
      base.current = conflict ?? base.current;
      setConflict(null);
      setDirty(false);
      changes.current = 0;
      setOpened(`${node.updatedAt}#${Date.now()}`);
      void storageChanged(client);
    },
    editor: {
      node,
      url,
      opened,
      onReady: useCallback((reader: () => string) => {
        read.current = reader;
      }, []),
      onChange: useCallback(() => {
        changes.current += 1;
        setDirty(true);
      }, []),
    },
  };
}

export type EditSession = ReturnType<typeof useEditSession>;

/** The editor for the file, on the file's whole text. ⌘S saves. */
export function DocumentEditor(props: { session: EditSession; onDownload: () => void }) {
  const { session } = props;
  const { node, url, opened, onReady, onChange } = session.editor;
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
