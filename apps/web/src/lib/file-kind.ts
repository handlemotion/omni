// What a stored file is, for its icon, its type badge and how it previews (ADR 0040). Read from
// the name's extension first (what the person sees), then the type the browser gave at upload.

export type FileKind =
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "code"
  | "text"
  | "csv"
  | "spreadsheet"
  | "document"
  | "presentation"
  | "archive"
  | "other";

/** How a file previews; `none` shows its type and Download. */
export type PreviewKind = "image" | "video" | "audio" | "pdf" | "text" | "csv" | "none";

/** Rasters a `Blob` may be re-typed as for `<img>`. Never SVG: it is a document (ADR 0040). */
const RASTER: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
};

const VIDEO = new Set(["mp4", "m4v", "webm", "mov", "ogv"]);
const AUDIO = new Set(["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac"]);
const ARCHIVE = new Set(["zip", "gz", "tgz", "tar", "rar", "7z", "bz2", "xz"]);
const SPREADSHEET = new Set(["xls", "xlsx", "numbers", "ods"]);
const DOCUMENT = new Set(["doc", "docx", "pages", "odt", "rtf"]);
const PRESENTATION = new Set(["ppt", "pptx", "key", "odp"]);
const PLAIN = new Set(["txt", "log", "text", "env"]);
const CSV = new Set(["csv", "tsv"]);

/** Code extensions and the Shiki grammar each one reads with. */
const CODE: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  json: "json",
  jsonc: "jsonc",
  md: "markdown",
  mdx: "mdx",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  xml: "xml",
  svg: "xml",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  vue: "vue",
  svelte: "svelte",
  graphql: "graphql",
  dockerfile: "docker",
  ini: "ini",
  lua: "lua",
  dart: "dart",
  ex: "elixir",
  exs: "elixir",
};

export interface FileType {
  kind: FileKind;
  preview: PreviewKind;
  /** The badge: the extension in capitals, or the kind when there is none. */
  label: string;
  /** For `image`: the raster type its bytes are shown as. */
  raster?: string | undefined;
  /** For `code`: the Shiki grammar. */
  language?: string | undefined;
}

/** "report.final.PDF" → "pdf"; "Dockerfile" → "dockerfile"; "notes" → "". */
export function extensionOf(name: string) {
  const dot = name.lastIndexOf(".");
  if (dot > 0) return name.slice(dot + 1).toLowerCase();
  return name.toLowerCase() === "dockerfile" ? "dockerfile" : "";
}

/** Checked in order: the first a file matches decides its kind and how it previews. */
const RULES: {
  kind: FileKind;
  preview: PreviewKind;
  matches: (ext: string, mime: string) => boolean;
}[] = [
  { kind: "pdf", preview: "pdf", matches: (e, m) => e === "pdf" || m === "application/pdf" },
  { kind: "video", preview: "video", matches: (e, m) => VIDEO.has(e) || m.startsWith("video/") },
  { kind: "audio", preview: "audio", matches: (e, m) => AUDIO.has(e) || m.startsWith("audio/") },
  { kind: "csv", preview: "csv", matches: (e, m) => CSV.has(e) || m === "text/csv" },
  { kind: "code", preview: "text", matches: (e) => e in CODE },
  { kind: "text", preview: "text", matches: (e, m) => PLAIN.has(e) || m.startsWith("text/") },
  { kind: "archive", preview: "none", matches: (e) => ARCHIVE.has(e) },
  { kind: "spreadsheet", preview: "none", matches: (e) => SPREADSHEET.has(e) },
  { kind: "document", preview: "none", matches: (e) => DOCUMENT.has(e) },
  { kind: "presentation", preview: "none", matches: (e) => PRESENTATION.has(e) },
  // SVG and other image types: an image, with no preview (ADR 0040).
  { kind: "image", preview: "none", matches: (_, m) => m.startsWith("image/") },
];

/** The extension or, failing it, the MIME type, as a known kind. */
export function fileType(name: string, mimeType: string | null): FileType {
  const ext = extensionOf(name);
  const mime = (mimeType ?? "").toLowerCase();
  const label = (ext && ext.length <= 5 ? ext : (mime.split("/")[1] ?? "")).toUpperCase() || "FILE";
  const raster = RASTER[ext] ?? (Object.values(RASTER).includes(mime) ? mime : undefined);
  if (raster) return { kind: "image", preview: "image", label, raster };
  const rule = RULES.find((r) => r.matches(ext, mime));
  if (!rule) return { kind: "other", preview: "none", label };
  return { kind: rule.kind, preview: rule.preview, label, language: CODE[ext] };
}

/** Images over this are not fetched to preview; their tile and Download stand in. */
export const IMAGE_PREVIEW_MAX_BYTES = 40 * 1024 * 1024;
/** Text and CSV previews read this much of the file's start. */
export const TEXT_PREVIEW_BYTES = 512 * 1024;
/** Grid thumbnails come from originals up to this size. */
export const THUMBNAIL_MAX_BYTES = 20 * 1024 * 1024;
