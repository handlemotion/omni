import { Extension, type Editor } from "@tiptap/core";
import { FileHandler } from "@tiptap/extension-file-handler";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { Node as PmNode } from "@tiptap/pm/model";
import { Suggestion } from "@tiptap/suggestion";
import type { DocFiles } from "@/hooks/use-doc-files.ts";
import { docLinkFile } from "@/lib/doc-files.ts";
import { fileType } from "@/lib/file-kind.ts";
import type { StorageNode } from "@/lib/storage.ts";
import { FileGlyph } from "../file-glyph.tsx";
import { menuRenderer, type MenuItem } from "./slash-menu.tsx";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

interface DriveFilesOptions {
  files: DocFiles | null;
  /** The app link that opens a file, as an @ link writes it. */
  hrefOf: (node: StorageNode) => string;
  /** Opens the Drive file a link names. */
  open: (fileId: string) => void;
  /** Says an image did not make it into Drive. */
  failed: (error: unknown, name: string) => void;
}

interface FileItem extends MenuItem {
  node: StorageNode;
}

const asItem = (node: StorageNode) => {
  const kind = fileType(node.name, node.mimeType).kind;
  const item: FileItem = {
    id: node.id,
    label: node.name,
    icon: (props) => <FileGlyph kind={kind} className={props.className} />,
    node,
  };
  return item;
};

const optionsOf = (editor: Editor) =>
  editor.extensionManager.extensions.find((each) => each.name === "driveFiles")?.options as
    | DriveFilesOptions
    | undefined;

/** Uploads images into Drive beside the doc and puts each in at `at` (the cursor when absent). */
export function addImages(editor: Editor, files: File[], at?: number) {
  const options = optionsOf(editor);
  const drive = options?.files;
  if (!options || !drive) return;
  for (const file of files.filter((each) => IMAGE_TYPES.includes(each.type))) {
    drive
      .upload(file)
      .then((src) => {
        if (editor.isDestroyed) return;
        const content = { type: "image", attrs: { src, alt: file.name } };
        const end = editor.state.doc.content.size;
        if (at === undefined) editor.chain().focus().insertContent(content).run();
        else editor.chain().insertContentAt(Math.min(at, end), content).run();
      })
      .catch((error: unknown) => options.failed(error, file.name));
  }
}

/** Asks for image files from the computer and adds them where the cursor was when asked. */
export function pickImages(editor: Editor) {
  const at = editor.state.selection.from;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = IMAGE_TYPES.join(",");
  input.multiple = true;
  input.hidden = true;
  input.addEventListener("change", () => {
    addImages(editor, [...(input.files ?? [])], at);
    input.remove();
  });
  input.addEventListener("cancel", () => input.remove());
  document.body.append(input);
  input.click();
}

function imageView(drive: DocFiles | null) {
  return (node: PmNode) => {
    const dom = document.createElement("img");
    dom.alt = String(node.attrs.alt ?? "");
    dom.draggable = true;
    const src = String(node.attrs.src ?? "");
    void (drive?.image(src) ?? Promise.resolve(null))
      .then((shown) => {
        dom.src = shown ?? src;
      })
      .catch(() => dom.classList.add("document-image-missing"));
    return { dom };
  };
}

function linkedFile(node: PmNode | null | undefined) {
  const href = node?.marks.find((mark) => mark.type.name === "link")?.attrs.href;
  return typeof href === "string" ? docLinkFile(href) : null;
}

/**
 * A doc's ties to the rest of Drive: images pasted, dropped or picked go into Drive next to it and
 * show from there; `@` links another file; a click on such a link opens that file.
 */
export const DriveFiles = Extension.create<DriveFilesOptions>({
  name: "driveFiles",
  addOptions: () => ({ files: null, hrefOf: () => "", open: () => {}, failed: () => {} }),
  addExtensions() {
    return [
      FileHandler.configure({
        allowedMimeTypes: IMAGE_TYPES,
        onPaste: (editor, files) => addImages(editor, files),
        onDrop: (editor, files, pos) => addImages(editor, files, pos),
      }),
    ];
  },
  addProseMirrorPlugins() {
    const { files, hrefOf, open } = this.options;
    return [
      Suggestion<FileItem, FileItem>({
        editor: this.editor,
        pluginKey: new PluginKey("driveLinks"),
        char: "@",
        placement: "bottom-start",
        offset: { mainAxis: 6 },
        items: async ({ query }) => ((await files?.find(query)) ?? []).slice(0, 8).map(asItem),
        allow: ({ editor }) => !!files && !editor.isActive("codeBlock"),
        command: ({ editor, range, props }) =>
          editor
            .chain()
            .focus()
            .insertContentAt(range, [
              {
                type: "text",
                text: props.node.name,
                marks: [{ type: "link", attrs: { href: hrefOf(props.node) } }],
              },
              { type: "text", text: " " },
            ])
            .run(),
        render: menuRenderer<FileItem>("Files"),
      }),
      new Plugin({
        key: new PluginKey("driveFileViews"),
        props: {
          nodeViews: { image: imageView(files) },
          handleClick: (view, pos, event) => {
            const id = linkedFile(view.state.doc.nodeAt(pos));
            if (!id || event.button !== 0) return false;
            open(id);
            return true;
          },
        },
      }),
    ];
  },
});
