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
import { docExtensions, readableMarkdown } from "@omni/docs";
import "./rich-editor.css";

/** What a doc can leave Drive as. */
export type DocExport = "pdf" | "docx" | "md";

const parse = (markdown: string) =>
  new Editor({
    element: null,
    extensions: docExtensions({ history: false }),
    content: readableMarkdown(markdown),
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
  details: (state, node) => state.renderContent(node),
  detailsSummary: (state, node) => {
    state.renderInline(node);
    state.closeBlock(node);
  },
  detailsContent: (state, node) => state.renderContent(node),
  taskItem: (state, node: PmNode) => {
    state.text(node.attrs.checked ? "☑ " : "☐ ");
    state.renderContent(node);
  },
};

const marks: MarkSerializer = {
  ...defaultMarks,
  strike: () => ({ strike: true }),
};

type Images = Map<string, { blob: Blob; data: Uint8Array; type: "png" | "jpg" | "gif" }>;

/** Reads an image of the doc; null when it is not there to embed. */
export type ImageLoader = (src: string) => Promise<Blob | null>;

async function asPng(blob: Blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

async function embeddable(blob: Blob) {
  const kind = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif" } as const;
  const type = kind[blob.type as keyof typeof kind];
  const usable = type ? blob : await asPng(blob);
  return { blob: usable, data: new Uint8Array(await usable.arrayBuffer()), type: type ?? "png" };
}

async function loadImages(doc: PmNode, load: ImageLoader) {
  const sources = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === "image" && node.attrs.src) sources.add(String(node.attrs.src));
  });
  const images: Images = new Map();
  await Promise.all(
    [...sources].map(async (src) => {
      const blob = await load(src).catch(() => null);
      const image = blob ? await embeddable(blob).catch(() => null) : null;
      if (image) images.set(src, image);
    }),
  );
  return images;
}

const serializerFor = (images: Images) =>
  new DocxSerializer(
    {
      ...nodes,
      image: (state, node) => {
        const src = String(node.attrs.src);
        const image = images.get(src);
        if (!image) return;
        state.image(src, 70, "center", undefined, image.type);
        state.closeBlock(node);
      },
    },
    marks,
  );

const baseName = (name: string) => name.replace(/\.(md|markdown)$/i, "") || "Untitled";

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function toWord(markdown: string, name: string, load: ImageLoader) {
  const editor = parse(markdown);
  const images = await loadImages(editor.state.doc, load);
  const doc = serializerFor(images).serialize(editor.state.doc, {
    getImageBuffer: (src) => images.get(src)?.data ?? new Uint8Array(),
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

async function toPdf(markdown: string, name: string, load: ImageLoader) {
  const editor = parse(markdown);
  const images = await loadImages(editor.state.doc, load);
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
  const shown: string[] = [];
  for (const image of page.querySelectorAll("img")) {
    const found = images.get(image.getAttribute("src") ?? "");
    if (!found) {
      image.remove();
      continue;
    }
    image.src = URL.createObjectURL(found.blob);
    shown.push(image.src);
  }
  view.addEventListener(
    "afterprint",
    () => {
      for (const url of shown) URL.revokeObjectURL(url);
      frame.remove();
    },
    { once: true },
  );
  await Promise.all([...page.images].map((image) => image.decode().catch(() => {})));
  await page.fonts.ready;
  view.print();
}

/**
 * Saves a doc as a Word file or as its Markdown, or opens the print dialog on it laid out as a
 * page (where Save as PDF makes the PDF). Word and PDF read the same blocks the editor shows.
 */
export async function exportDoc(
  markdown: string,
  name: string,
  format: DocExport,
  load: ImageLoader,
) {
  if (format === "md")
    save(new Blob([markdown], { type: "text/markdown" }), `${baseName(name)}.md`);
  else if (format === "docx") await toWord(markdown, name, load);
  else await toPdf(markdown, name, load);
}
