import { canvasText, sceneFromJson } from "@omni/canvas";
import { CANVAS_TYPE } from "@omni/canvas/file";
import { unzipSync, type UnzipFileInfo } from "fflate";
import { fileIndexText, parseSheet, SHEET_TYPE } from "@omni/sheets";
import { extractText } from "unpdf";

/** The most text kept from one file; past it the text is cut and marked truncated. */
export const TEXT_MAX_CHARS = 400_000;
const PLAIN_MAX_BYTES = 10 * 1024 * 1024;
const PARSED_MAX_BYTES = 25 * 1024 * 1024;
const ZIP_ENTRY_MAX_BYTES = 64 * 1024 * 1024;

export type Reader = "plain" | "html" | "pdf" | "docx" | "pptx" | "xlsx" | "canvas" | "sheet";

const PLAIN_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "yaml",
  "yml",
  "toml",
  "ini",
  "log",
  "xml",
  "svg",
  "sql",
  "js",
  "jsx",
  "mjs",
  "ts",
  "tsx",
  "py",
  "rb",
  "go",
  "rs",
  "swift",
  "kt",
  "java",
  "c",
  "h",
  "cpp",
  "cs",
  "php",
  "sh",
  "css",
  "scss",
  "tex",
  "srt",
  "vtt",
  "ics",
  "vcf",
  "eml",
]);

const BY_EXTENSION: Record<string, Reader> = {
  html: "html",
  htm: "html",
  pdf: "pdf",
  docx: "docx",
  pptx: "pptx",
  xlsx: "xlsx",
};

const BY_MIME: Record<string, Reader> = {
  "text/html": "html",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/json": "plain",
  "application/xml": "plain",
  "application/x-yaml": "plain",
  "application/javascript": "plain",
};

/** How a file's text is read, from its name first and its type second; null when we do not. */
export const readerFor: (name: string, mimeType: string | null) => Reader | null = (
  name,
  mimeType,
) => {
  const type = mimeType?.split(";")[0]!.trim().toLowerCase() ?? "";
  if (type === CANVAS_TYPE) return "canvas";
  if (type === SHEET_TYPE) return "sheet";
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (BY_EXTENSION[extension]) return BY_EXTENSION[extension];
  if (PLAIN_EXTENSIONS.has(extension)) return "plain";
  if (BY_MIME[type]) return BY_MIME[type];
  return type.startsWith("text/") ? "plain" : null;
};

/** The largest file `reader` reads. */
export const maxBytesFor = (reader: Reader) =>
  reader === "plain" || reader === "html" || reader === "canvas"
    ? PLAIN_MAX_BYTES
    : PARSED_MAX_BYTES;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X"
          ? Number.parseInt(name.slice(2), 16)
          : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const squeeze = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");

const tidy = (text: string) => squeeze(text).trim();

function html(source: string) {
  return decodeEntities(
    source
      .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6])\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " "),
  );
}

function runs(xml: string, text: RegExp, paragraph: string) {
  const out: string[] = [];
  const pattern = new RegExp(`${text.source}|${paragraph}|<w:tab/>|<w:br/>`, "g");
  for (const match of xml.matchAll(pattern)) {
    if (match[1] !== undefined) out.push(decodeEntities(match[1]));
    else if (match[0] === "<w:tab/>") out.push("\t");
    else out.push("\n");
  }
  return out.join("");
}

function unzip(bytes: Uint8Array, wanted: (name: string) => boolean) {
  const files = unzipSync(bytes, {
    filter: (file: UnzipFileInfo) => wanted(file.name) && file.originalSize <= ZIP_ENTRY_MAX_BYTES,
  });
  const decoder = new TextDecoder();
  return new Map(Object.entries(files).map(([name, data]) => [name, decoder.decode(data)]));
}

const numbered = (pattern: RegExp) => (a: string, b: string) =>
  Number(pattern.exec(a)?.[1] ?? 0) - Number(pattern.exec(b)?.[1] ?? 0);

function docx(bytes: Uint8Array) {
  const parts = unzip(bytes, (name) =>
    /^word\/(document|footnotes|endnotes|header\d*|footer\d*)\.xml$/.test(name),
  );
  const order = ["word/document.xml", "word/footnotes.xml", "word/endnotes.xml"];
  return [...parts.keys()]
    .toSorted((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
    .map((name) => runs(parts.get(name)!, /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/, "</w:p>"))
    .join("\n\n");
}

function pptx(bytes: Uint8Array) {
  const slide = /^ppt\/slides\/slide(\d+)\.xml$/;
  const parts = unzip(bytes, (name) => slide.test(name));
  return [...parts.keys()]
    .toSorted(numbered(slide))
    .map(
      (name, i) =>
        `--- Slide ${i + 1} ---\n${runs(parts.get(name)!, /<a:t>([^<]*)<\/a:t>/, "</a:p>")}`,
    )
    .join("\n\n");
}

function sharedStrings(xml: string | undefined) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((item) =>
    [...item[1]!.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)]
      .map((t) => decodeEntities(t[1]!))
      .join(""),
  );
}

function cellText(cell: string, strings: string[]) {
  const type = /\bt="([^"]+)"/.exec(cell)?.[1];
  if (type === "inlineStr") {
    return [...cell.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)]
      .map((t) => decodeEntities(t[1]!))
      .join("");
  }
  const value = /<v>([^<]*)<\/v>/.exec(cell)?.[1];
  if (value === undefined) return "";
  return type === "s" ? (strings[Number(value)] ?? "") : decodeEntities(value);
}

const LAST_COLUMN = 16_383;
const MAX_EMPTY_COLUMNS = 32;

function columnOf(cell: string) {
  const letters = /\br="([A-Z]{1,3})\d+"/.exec(cell)?.[1];
  if (!letters) return null;
  const column = [...letters].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  return column <= LAST_COLUMN ? column : null;
}

function sheetRow(row: string, strings: string[]) {
  const values: string[] = [];
  let at = -1;
  for (const [cell] of row.matchAll(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)) {
    const column = Math.max(columnOf(cell) ?? at + 1, at + 1);
    const gap = Math.min(column - at - 1, MAX_EMPTY_COLUMNS);
    for (let i = 0; i < gap; i++) values.push("");
    values.push(cellText(cell, strings));
    at = column;
  }
  return values.join("\t").trimEnd();
}

function sheetsInOrder(parts: Map<string, string>, sheet: RegExp) {
  const targets = new Map(
    [...(parts.get("xl/_rels/workbook.xml.rels") ?? "").matchAll(/<Relationship\b[^>]*>/g)].map(
      ([tag]) => [
        /\bId="([^"]+)"/.exec(tag)?.[1] ?? "",
        (/\bTarget="([^"]+)"/.exec(tag)?.[1] ?? "").replace(/^\/?(xl\/)?/, "xl/"),
      ],
    ),
  );
  const listed = [...(parts.get("xl/workbook.xml") ?? "").matchAll(/<sheet\b[^>]*>/g)].map(
    ([tag]) => ({
      name: decodeEntities(/\bname="([^"]*)"/.exec(tag)?.[1] ?? ""),
      part: targets.get(/\br:id="([^"]+)"/.exec(tag)?.[1] ?? ""),
    }),
  );
  const found = listed.filter(
    (entry): entry is { name: string; part: string } => !!entry.part && parts.has(entry.part),
  );
  if (found.length) return found;
  return [...parts.keys()]
    .filter((name) => sheet.test(name))
    .toSorted(numbered(sheet))
    .map((part, i) => ({ name: listed[i]?.name || String(i + 1), part }));
}

function xlsx(bytes: Uint8Array) {
  const sheet = /^xl\/worksheets\/sheet(\d+)\.xml$/;
  const parts = unzip(
    bytes,
    (name) =>
      sheet.test(name) ||
      name === "xl/sharedStrings.xml" ||
      name === "xl/workbook.xml" ||
      name === "xl/_rels/workbook.xml.rels",
  );
  const strings = sharedStrings(parts.get("xl/sharedStrings.xml"));
  const out: string[] = [];
  let size = 0;
  for (const { name, part } of sheetsInOrder(parts, sheet)) {
    out.push(`--- Sheet: ${name} ---`);
    for (const [, row] of parts.get(part)!.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const line = squeeze(sheetRow(row!, strings));
      if (!line) continue;
      out.push(line);
      size += line.length + 1;
      if (size > TEXT_MAX_CHARS) return out.join("\n");
    }
    out.push("");
  }
  return out.join("\n");
}

async function pdf(bytes: Uint8Array) {
  const { text, totalPages } = await extractText(bytes, { mergePages: false });
  const marked = text
    .map((page, i) => ({ page: i + 1, text: page.trim() }))
    .filter((page) => page.text.length > 0)
    .map((page) => `--- Page ${page.page} ---\n${page.text}`)
    .join("\n\n");
  return { text: marked, pages: totalPages };
}

/** `text` tidied and cut at `TEXT_MAX_CHARS`. */
export const finish = (text: string) => {
  const tidied = tidy(text.replaceAll("\u0000", ""));
  const truncated = tidied.length > TEXT_MAX_CHARS;
  return { text: truncated ? tidied.slice(0, TEXT_MAX_CHARS) : tidied, truncated };
};

function canvasWords(bytes: Uint8Array) {
  const read = sceneFromJson(new TextDecoder().decode(bytes));
  if (!read.ok) throw new Error(read.error);
  return canvasText(read.scene);
}

/**
 * The file's text, tidied and cut at `TEXT_MAX_CHARS`, and a PDF's page count. Throws when the
 * file is not what it says.
 */
export async function extract(reader: Reader, bytes: Uint8Array) {
  if (reader === "pdf") {
    const { text, pages } = await pdf(bytes);
    return { ...finish(text), pages };
  }
  if (reader === "canvas") return { ...finish(canvasWords(bytes)), pages: null };
  const raw =
    reader === "docx"
      ? docx(bytes)
      : reader === "pptx"
        ? pptx(bytes)
        : reader === "xlsx"
          ? xlsx(bytes)
          : reader === "sheet"
            ? fileIndexText(parseSheet(new TextDecoder().decode(bytes)))
            : reader === "html"
              ? html(new TextDecoder().decode(bytes))
              : new TextDecoder().decode(bytes);
  return { ...finish(raw), pages: null };
}

const PICTURE_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const PICTURE_EXTENSIONS = new Set(["avif", "gif", "heic", "heif", "jpg", "jpeg", "png", "webp"]);

/** A picture whose words only OCR reads, by type first and name second. */
export const isPicture = (name: string, mimeType: string | null) => {
  const type = mimeType?.split(";")[0]!.trim().toLowerCase() ?? "";
  if (type) return PICTURE_TYPES.has(type);
  const dot = name.lastIndexOf(".");
  return dot > 0 && PICTURE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
};
