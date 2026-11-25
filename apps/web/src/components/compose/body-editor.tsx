import { Extension } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { Placeholder } from "@tiptap/extensions";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useImperativeHandle, useRef } from "react";
import { pastedFiles, textToHtml } from "./body-html.ts";

const InlineImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      file: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-file"),
        renderHTML: (attrs) => (attrs.file ? { "data-file": attrs.file } : {}),
      },
    };
  },
  renderText({ node }) {
    return `[image: ${node.attrs.alt || "image"}]`;
  },
});

const OUTSIDE = "outside";

const Lock = Extension.create<{ locked: () => boolean }>({
  name: "lock",
  addOptions: () => ({ locked: () => false }),
  addProseMirrorPlugins() {
    const { locked } = this.options;
    return [
      new Plugin({
        filterTransaction: (tr) => !tr.docChanged || !locked() || tr.getMeta(OUTSIDE) === true,
        view: (view) => {
          const sync = () => view.dom.setAttribute("aria-readonly", String(locked()));
          sync();
          return { update: sync };
        },
      }),
    ];
  },
});

const EXTENSIONS = [
  StarterKit.configure({
    heading: false,
    codeBlock: false,
    horizontalRule: false,
    link: { openOnClick: false },
  }),
  InlineImage,
  Placeholder.configure({ placeholder: "Write…" }),
];

/** What the composer does with the body beyond typing. */
export interface BodyHandle {
  /** Puts plain text (a canned reply) at the caret. */
  insertText: (text: string) => void;
  focus: () => void;
}

/** The body as HTML for the editor and the send, and as the plain-text part. */
export interface BodyContent {
  html: string;
  text: string;
}

/**
 * The message being written: rich text with images in it. A pasted or dropped image is shown
 * where it lands and uploaded as an inline image (`onImages`); any other file is attached
 * (`onFiles`). Cmd/Ctrl+Enter sends.
 */
export function BodyEditor(props: {
  ref: React.Ref<BodyHandle>;
  label: string;
  /** The editor's HTML; a change from outside (a draft, an undone send) replaces the body. */
  value: string;
  onChange: (next: BodyContent) => void;
  onSend: () => void;
  /** Starts uploading images shown in the body; answers their composer file ids, in order. */
  onImages: (files: File[]) => string[];
  onFiles: (files: File[]) => void;
  readOnly?: boolean | undefined;
  autoFocus?: boolean | undefined;
  fill?: boolean | undefined;
}) {
  const latest = useRef(props);
  latest.current = props;
  const emitted = useRef(props.value);
  const previews = useRef<string[]>([]);

  const place = (editor: Editor, files: File[], at?: number) => {
    const images = files.filter((f) => f.type.startsWith("image/"));
    const others = files.filter((f) => !f.type.startsWith("image/"));
    if (others.length) latest.current.onFiles(others);
    if (!images.length) return;
    const ids = latest.current.onImages(images);
    const nodes = images.map((file, i) => {
      const src = URL.createObjectURL(file);
      previews.current.push(src);
      return { type: "image", attrs: { src, alt: file.name, file: ids[i] } };
    });
    const chain = editor.chain().focus();
    (at === undefined ? chain : chain.setTextSelection(at))
      .insertContent(nodes)
      .command(({ tr }) => {
        const end = tr.selection.to;
        if (!tr.doc.resolve(end).nodeAfter?.isTextblock) {
          tr.insert(end, editor.schema.nodes.paragraph!.create());
        }
        tr.setSelection(TextSelection.create(tr.doc, end + 1));
        return true;
      })
      .run();
  };

  const locked = useRef(!!props.readOnly);
  locked.current = !!props.readOnly;
  const editor = useEditor({
    extensions: [...EXTENSIONS, Lock.configure({ locked: () => locked.current })],
    content: props.value,
    autofocus: props.autoFocus ? "start" : false,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-multiline": "true",
        "aria-label": props.label,
        "data-composer-body": "",
        class: [
          "overscroll-contain px-[var(--composer-x,--spacing(3))] pt-[var(--composer-y,--spacing(3))] pb-1 text-base/6 text-foreground outline-hidden sm:text-sm/6",
          "[&_img]:my-1 [&_img]:max-h-96 [&_img]:max-w-full [&_img]:rounded-md [&_img.ProseMirror-selectednode]:ring-2 [&_img.ProseMirror-selectednode]:ring-ring",
          "[&_ul]:list-disc [&_ul]:ps-5 [&_ol]:list-decimal [&_ol]:ps-5 [&_a]:text-primary [&_a]:underline [&_blockquote]:border-s-2 [&_blockquote]:ps-3 [&_blockquote]:text-muted-foreground",
          "[&_p.is-editor-empty:first-child]:before:pointer-events-none [&_p.is-editor-empty:first-child]:before:float-start [&_p.is-editor-empty:first-child]:before:h-0 [&_p.is-editor-empty:first-child]:before:text-muted-foreground [&_p.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]",
        ].join(" "),
      },
      handlePaste: (view, event) => {
        const files = pastedFiles(event.clipboardData);
        if (!files.length || !editorRef.current) return false;
        event.preventDefault();
        place(editorRef.current, files);
        return true;
      },
      handleDrop: (view, event) => {
        const files = [...(event.dataTransfer?.files ?? [])];
        if (!files.length || !editorRef.current) return false;
        event.preventDefault();
        event.stopPropagation();
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        place(editorRef.current, files, at);
        return true;
      },
      handleKeyDown: (_view, event) => {
        if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return false;
        event.preventDefault();
        latest.current.onSend();
        return true;
      },
    },
    onUpdate: ({ editor: current }) => {
      const html = current.getHTML();
      emitted.current = html;
      latest.current.onChange({ html, text: current.getText({ blockSeparator: "\n" }) });
    },
  });
  const editorRef = useRef(editor);
  editorRef.current = editor;

  useEffect(() => {
    if (!editor || props.value === emitted.current) return;
    emitted.current = props.value;
    editor.chain().setMeta(OUTSIDE, true).setContent(props.value, { emitUpdate: false }).run();
  }, [editor, props.value]);

  useEffect(() => {
    if (editor?.view.dom.isConnected) editor.view.dispatch(editor.state.tr);
  }, [editor, props.readOnly]);

  useEffect(
    () => () => {
      for (const src of previews.current) URL.revokeObjectURL(src);
    },
    [],
  );

  useImperativeHandle(
    props.ref,
    () => ({
      insertText: (text) => editor?.chain().focus().insertContent(textToHtml(text)).run(),
      focus: () => editor?.commands.focus(),
    }),
    [editor],
  );

  return (
    <EditorContent
      editor={editor}
      className={`${props.fill ? "min-h-24 flex-1" : "max-h-[min(24rem,30vh)] min-h-24"} flex flex-col overflow-y-auto [&>.tiptap]:flex-1`}
    />
  );
}
