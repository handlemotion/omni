import { useQuery } from "@tanstack/react-query";
import { Collaboration, isChangeOrigin } from "@tiptap/extension-collaboration";
import { CollaborationCaret } from "@tiptap/extension-collaboration-caret";
import { Editor, EditorContent, useEditor } from "@tiptap/react";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDocComments, useLiveComments } from "@/hooks/use-doc-comments.ts";
import { useDocFiles } from "@/hooks/use-doc-files.ts";
import { useFilePlace } from "@/hooks/use-storage.ts";
import type * as Y from "yjs";
import { openLiveDoc, type LiveDoc } from "@/lib/live-doc.ts";
import { sessionQuery } from "@/lib/session.ts";
import type { StorageNode } from "@/lib/storage.ts";
import type { EditorProps } from "./document-editor.tsx";
import { BlockHandle, FormatBar } from "./block-tools.tsx";
import { commentOnSelection, useCommentMarks, useCommentsExtension } from "./comment-marks.ts";
import { useStorageHref } from "../file-list.tsx";
import { storageErrorToast } from "../storage-errors.ts";
import { docExtensions } from "./doc-schema.ts";
import { DriveFiles } from "./drive-files.tsx";
import { SlashMenu } from "./slash-menu.tsx";
import SourceEditor from "./source-editor.tsx";
import "./rich-editor.css";

const blocks = (live: boolean) => [...docExtensions({ history: !live }), SlashMenu];

const EXTENSIONS = blocks(false);

const liveExtensions = (doc: Y.Doc) => [
  ...blocks(true),
  Collaboration.configure({ document: doc }),
];

/** Who this tab is to the others in the doc: a name, a picture, and a colour that stays theirs. */
export interface Collaborator {
  name: string;
  color: string;
  image: string | null;
}

const COLLABORATOR_COLORS = 6;

/** The same person gets the same colour on every screen: picked from their member id, as hex. */
export function collaboratorColor(memberId: string) {
  let hash = 0;
  for (const char of memberId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const token = `--collaborator-${(hash % COLLABORATOR_COLORS) + 1}`;
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
}

const caret = (user: Record<string, unknown>) => {
  const color = typeof user.color === "string" ? user.color : "";
  const name = typeof user.name === "string" ? user.name : "";
  const line = document.createElement("span");
  line.className = "collaboration-carets__caret";
  line.style.borderColor = color;
  const tag = document.createElement("span");
  tag.className = "collaboration-carets__label";
  tag.style.backgroundColor = color;
  if (typeof user.image === "string" && user.image) {
    const picture = document.createElement("img");
    picture.src = user.image;
    picture.alt = "";
    picture.className = "collaboration-carets__avatar";
    tag.append(picture);
  } else {
    const initial = document.createElement("span");
    initial.className = "collaboration-carets__avatar";
    initial.textContent = name.slice(0, 1).toUpperCase();
    tag.append(initial);
  }
  tag.append(document.createTextNode(name));
  line.append(tag);
  return line;
};

const withCarets = (live: LiveDoc, me: Collaborator) => [
  ...liveExtensions(live.doc),
  CollaborationCaret.configure({
    provider: { awareness: live.awareness },
    user: me,
    render: caret,
  }),
];

const useCollaborator = () => {
  const session = useQuery(sessionQuery()).data;
  return useMemo(() => {
    const name = session?.user.name || session?.user.email.split("@")[0] || "Someone";
    const me: Collaborator = {
      name,
      color: collaboratorColor(session?.member?.id ?? name),
      image: session?.user.image ?? null,
    };
    return me;
  }, [session?.user.name, session?.user.email, session?.user.image, session?.member?.id]);
};

function seedFrom(markdown: string) {
  return (doc: Y.Doc) => {
    const editor = new Editor({ extensions: liveExtensions(doc) });
    editor.commands.setContent(markdown, { contentType: "markdown" });
    editor.destroy();
  };
}

const words = (markdown: string) =>
  markdown.replace(/^\s*\d+[.)]\s/gm, "").replace(/[^\p{L}\p{N}]+/gu, "");

function roundTrips(markdown: string) {
  const editor = new Editor({ extensions: EXTENSIONS, content: markdown, contentType: "markdown" });
  const back = editor.getMarkdown();
  editor.destroy();
  return words(back) === words(markdown);
}

type Phase = { kind: "opening" } | { kind: "live"; doc: LiveDoc } | { kind: "off" };

export default function RichEditor(props: EditorProps) {
  const page = useMemo(() => roundTrips(props.text), [props.text]);
  return page ? <LivePage {...props} /> : <SourceEditor {...props} live={undefined} />;
}

function LivePage(props: EditorProps) {
  const { live, nodeId } = props;
  const [phase, setPhase] = useState<Phase>(live ? { kind: "opening" } : { kind: "off" });
  useEffect(() => {
    if (!live) return;
    let opened: LiveDoc | null = null;
    let gone = false;
    void openLiveDoc({
      orgId: live.orgId,
      nodeId,
      contentVersion: live.contentVersion,
      seed: seedFrom(props.text),
      onReplaced: live.onReplaced,
      onFolded: live.onFolded,
      onAcked: live.onAcked,
    })
      .catch(() => null)
      .then((doc) => {
        if (gone) return doc?.close();
        opened = doc;
        live.onLive(doc);
        setPhase(doc ? { kind: "live", doc } : { kind: "off" });
      });
    return () => {
      gone = true;
      opened?.close();
      live.onLive(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (phase.kind === "opening") return props.loading;
  return <Page {...props} doc={phase.kind === "live" ? phase.doc : null} />;
}

function useDriveOptions(props: EditorProps) {
  const drive = useDocFiles(props.file, props.shareId);
  const storageHref = useStorageHref();
  const filePlace = useFilePlace();
  const router = useRouter();
  const hrefOf = (node: { id: string; space: StorageNode["space"]; parentId: string | null }) => {
    const folder = storageHref(node.space, node.parentId ?? undefined);
    return `${folder}${folder.includes("?") ? "&" : "?"}file=${encodeURIComponent(node.id)}`;
  };
  const latest = useRef({ drive, hrefOf, filePlace, router });
  useEffect(() => {
    latest.current = { drive, hrefOf, filePlace, router };
  });
  return useMemo(
    () => ({
      files: {
        upload: (file: File) => latest.current.drive.upload(file),
        image: (src: string) => latest.current.drive.image(src),
        find: (q: string) => latest.current.drive.find(q),
      },
      hrefOf: (node: StorageNode) => latest.current.hrefOf(node),
      open: (fileId: string) =>
        void latest.current.filePlace(fileId).then((place) => {
          if (!place) return;
          const href = latest.current.hrefOf({ id: fileId, ...place, parentId: place.folderId });
          void latest.current.router.navigate({ href });
        }),
      failed: (error: unknown, name: string) => storageErrorToast(error, `“${name}” was not added`),
    }),
    [],
  );
}

function Page(props: EditorProps & { doc: LiveDoc | null }) {
  const { onReady, onChange, name, doc } = props;
  const me = useCollaborator();
  const drive = useDriveOptions(props);
  const comments = useDocComments();
  const commenting = useCommentsExtension(comments);
  useLiveComments(doc, props.nodeId);
  const editorProps = useMemo(
    () => ({ attributes: { class: "document-page", "aria-label": name } }),
    [name],
  );
  const extensions = useMemo(
    () => [...(doc ? withCarets(doc, me) : EXTENSIONS), DriveFiles.configure(drive), ...commenting],
    [doc, me, drive, commenting],
  );
  const editor = useEditor({
    extensions,
    ...(doc ? {} : { content: props.text, contentType: "markdown" as const }),
    editorProps,
    onUpdate: ({ transaction }) => {
      if (!doc || !isChangeOrigin(transaction)) onChange();
    },
    onCreate: ({ editor: created }) => {
      if (!created.view.dom.contains(document.activeElement)) created.view.focus();
    },
  });
  useEffect(() => {
    onReady(() => editor.getMarkdown());
  }, [editor, onReady]);
  useCommentMarks(editor, comments);

  return (
    <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
      <EditorContent editor={editor} />
      <BlockHandle editor={editor} />
      <FormatBar
        editor={editor}
        onComment={comments ? () => commentOnSelection(editor, comments) : undefined}
      />
    </div>
  );
}
