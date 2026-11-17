// A Markdown file as a page (ADR 0043): Tiptap edits headings, lists, checklists, quotes, code
// and links, and saves the page back as Markdown. A file with more than that (a table, an image,
// HTML) edits as text instead, so a save never drops what the page cannot show. Its own chunk,
// loaded when a .md file is edited.
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Markdown } from "@tiptap/markdown";
import { Editor, EditorContent, useEditor } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";
import { useEffect, useMemo } from "react";
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

export default function RichEditor(props: EditorProps) {
  const page = useMemo(() => roundTrips(props.text), [props.text]);
  return page ? <Page {...props} /> : <SourceEditor {...props} />;
}

function Page(props: EditorProps) {
  const { onReady, onChange, name } = props;
  const editorProps = useMemo(
    () => ({ attributes: { class: "document-page", "aria-label": name } }),
    [name],
  );
  const editor = useEditor({
    extensions: EXTENSIONS,
    content: props.text,
    contentType: "markdown",
    editorProps,
    onUpdate: () => onChange(),
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
