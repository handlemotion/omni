import { Editor } from "@tiptap/core";
import { Fragment, type Node as PmNode } from "@tiptap/pm/model";
import { Packer, TextRun } from "docx";
import {
  defaultMarks,
  defaultNodes,
  DocxSerializer,
  type DocxSerializerState,
  type MarkSerializer,
  type NodeSerializer,
} from "prosemirror-docx";
import { docExtensions } from "./doc-schema.ts";
import "./rich-editor.css";

/** What a doc can leave Drive as, besides its own Markdown. */
export type DocExport = "pdf" | "docx";

const parse = (markdown: string) =>
  new Editor({
    element: null,
    extensions: docExtensions({ history: false }),
    content: markdown,
    contentType: "markdown",
  });

type ListStyle = "bullets" | "numbered";

const listStyles = new Map<string, ListStyle>();

function list(state: DocxSerializerState, node: PmNode, style: ListStyle) {
  const outer = state.currentNumbering;
  const start = style === "numbered" ? Number(node.attrs.start ?? 1) : 1;
  if (start === 1 && (!outer || listStyles.get(outer.reference) === style)) {
    const at = state.numbering.length;
    state.renderList(node, style);
    if (!outer) listStyles.set(state.numbering[at]?.reference ?? "", style);
    return;
  }
  const level = outer ? outer.level + 1 : 0;
  state.currentNumbering = undefined;
  state.renderList(node.copy(Fragment.empty), style);
  const last = state.numbering.length - 1;
  const numbering = state.numbering[last];
  if (!numbering) return;
  state.numbering[last] = {
    ...numbering,
    levels: numbering.levels.map((each) => (each.level === level ? { ...each, start } : each)),
  };
  listStyles.set(numbering.reference, style);
  state.currentNumbering = { reference: numbering.reference, level };
  state.renderContent(node);
  state.currentNumbering = outer;
}

const nodes: NodeSerializer = {
  ...defaultNodes,
  codeBlock: (state, node) => {
    let breaks = 0;
    for (const line of node.textContent.split("\n")) {
      if (line) state.text(line, { break: breaks || undefined, font: "Courier New" });
      breaks = line ? 1 : breaks + 1;
    }
    state.closeBlock(node);
  },
  horizontalRule: (state, node) => {
    state.closeBlock(node, { thematicBreak: true });
    state.closeBlock(node);
  },
  hardBreak: (state) => {
    state.current.push(new TextRun({ break: 1 }));
  },
  bulletList: (state, node) => list(state, node, "bullets"),
  orderedList: (state, node) => list(state, node, "numbered"),
  listItem: (state, node) => state.renderListItem(node),
  taskList: (state, node) => state.renderContent(node),
  taskItem: (state, node: PmNode) => {
    state.text(node.attrs.checked ? "☑ " : "☐ ");
    state.renderContent(node);
  },
};

const marks: MarkSerializer = {
  ...defaultMarks,
  strike: () => ({ strike: true }),
};

const serializer = new DocxSerializer(nodes, marks);

const baseName = (name: string) => name.replace(/\.(md|markdown)$/i, "") || "Untitled";

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function toWord(markdown: string, name: string) {
  const editor = parse(markdown);
  const doc = serializer.serialize(editor.state.doc, {
    getImageBuffer: () => new Uint8Array(),
    sections: [{}],
  });
  editor.destroy();
  save(await Packer.toBlob(doc), `${baseName(name)}.docx`);
}

function pageStyles() {
  return [...document.styleSheets]
    .map((sheet) => {
      try {
        return [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
      } catch {
        return "";
      }
    })
    .join("\n");
}

function toPdf(markdown: string, name: string) {
  const editor = parse(markdown);
  const html = editor.getHTML();
  editor.destroy();
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden";
  document.body.append(frame);
  const page = frame.contentDocument;
  const view = frame.contentWindow;
  if (!page || !view) return frame.remove();
  page.open();
  page.write(
    `<!doctype html><html><head><meta charset="utf-8"><title></title><style>${pageStyles()}
@page { margin: 18mm; }
body { background: white; }
.document-page { max-width: none; padding: 0; }
.document-page h1, .document-page h2, .document-page h3 { break-after: avoid; }
.document-page tr, .document-page pre, .document-page li { break-inside: avoid; }
</style></head><body><div class="document-page"></div></body></html>`,
  );
  page.close();
  page.title = baseName(name);
  const body = page.querySelector(".document-page");
  if (body) body.innerHTML = html;
  view.addEventListener("afterprint", () => frame.remove(), { once: true });
  void page.fonts.ready.then(() => view.print());
}

/**
 * Saves a doc's Markdown as a Word file, or opens the print dialog on it laid out as a page
 * (where Save as PDF makes the PDF). Both read the same blocks the editor shows.
 */
export async function exportDoc(markdown: string, name: string, format: DocExport) {
  if (format === "docx") await toWord(markdown, name);
  else toPdf(markdown, name);
}
