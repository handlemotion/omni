// A Markdown file as a page (ADR 0043): Tiptap edits headings, lists, checklists, quotes, code
// and links, and saves the page back as Markdown. With the live layer (decision 3 step 2) the page
// is the file's live document, shared with everyone editing it. A file with more than the page
// shows (a table, an image, HTML) edits as text instead, so a save never drops it. Its own chunk,
// loaded when a .md file is edited.
import { Collaboration, isChangeOrigin } from "@tiptap/extension-collaboration";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Markdown } from "@tiptap/markdown";
import { Editor, EditorContent, useEditor, type Extensions } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { useEffect, useMemo, useState } from "react";
import type * as Y from "yjs";
import { openLiveDoc, type LiveDoc } from "@/lib/live-doc.ts";
import type { EditorProps } from "./document-editor.tsx";
import SourceEditor from "./source-editor.tsx";
import "./rich-editor.css";

/**
 * One list for every editor. Options that change identity between renders (a new array, a new
 * `editorProps`) make Tiptap reapply them all, which resets the caret to the editor's last known
 * selection: a click whose selection it has not read yet is undone.
 */
const EXTENSIONS = [
  StarterKit.configure({ link: { openOnClick: false } }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Markdown,
];

/** The same, on a live document: its history is Yjs's, so the editor keeps none of its own. */
const liveExtensions = (doc: Y.Doc) => {
  const result: Extensions = [
    StarterKit.configure({ link: { openOnClick: false }, undoRedo: false }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Markdown,
    Collaboration.configure({ document: doc }),
  ];
  return result;
};

/** Fills an empty live document from the file's Markdown, through an editor nobody sees. */
function seedFrom(markdown: string) {
  return (doc: Y.Doc) => {
    const editor = new Editor({ extensions: liveExtensions(doc) });
    editor.commands.setContent(markdown, { contentType: "markdown" });
    editor.destroy();
  };
}

/**
 * The letters and digits of a Markdown text, in order, leaving out list numbers. Markdown the page
 * writes back differently (`*` for `-`, renumbered lists, escapes) keeps them; anything it drops
 * (a table's cells, an image's address, HTML) loses some.
 */
const words = (markdown: string) =>
  markdown.replace(/^\s*\d+[.)]\s/gm, "").replace(/[^\p{L}\p{N}]+/gu, "");

/** Whether the page keeps every word of `markdown` when it saves it back. */
function roundTrips(markdown: string) {
  const editor = new Editor({ extensions: EXTENSIONS, content: markdown, contentType: "markdown" });
  const back = editor.getMarkdown();
  editor.destroy();
  return words(back) === words(markdown);
}

type Phase = { kind: "opening" } | { kind: "live"; doc: LiveDoc } | { kind: "off" };

export default function RichEditor(props: EditorProps) {
  const page = useMemo(() => roundTrips(props.text), [props.text]);
  // As text, alone: a live page would carry only what the page shows.
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
    // One live document per editor: the editor is keyed by its opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (phase.kind === "opening") return props.loading;
  return <Page {...props} doc={phase.kind === "live" ? phase.doc.doc : null} />;
}

function Page(props: EditorProps & { doc: Y.Doc | null }) {
  const { onReady, onChange, name, doc } = props;
  const editorProps = useMemo(
    () => ({ attributes: { class: "document-page", "aria-label": name } }),
    [name],
  );
  const extensions = useMemo(() => (doc ? liveExtensions(doc) : EXTENSIONS), [doc]);
  const editor = useEditor({
    extensions,
    // A live document brings its own content.
    ...(doc ? {} : { content: props.text, contentType: "markdown" as const }),
    editorProps,
    // Only this person's changes: the others' arrive from the live document.
    onUpdate: ({ transaction }) => {
      if (!doc || !isChangeOrigin(transaction)) onChange();
    },
    // Ready to type at the start (a new document's selection) once it is up, unless the person
    // already clicked into it. ProseMirror's own focus, at once: Tiptap's `autofocus` and focus
    // command finish on a later frame, after a quick click, and move the caret back.
    onCreate: ({ editor: created }) => {
      if (!created.view.dom.contains(document.activeElement)) created.view.focus();
    },
  });
  useEffect(() => {
    onReady(() => editor.getMarkdown());
  }, [editor, onReady]);

  return (
    <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
      <EditorContent editor={editor} />
    </div>
  );
}
