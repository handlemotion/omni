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

const EXTENSIONS = [
  StarterKit.configure({ link: { openOnClick: false } }),
  TaskList,
  TaskItem.configure({ nested: true }),
  Markdown,
];

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

  return (
    <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
      <EditorContent editor={editor} />
    </div>
  );
}
