/**
 * How a Drive file previews on the phone, after the web's `lib/file-kind.ts`:
 * - `image`: the photo viewer (pinch, double tap, swipe to the folder's next image), HEIC too.
 * - `text`: its text, for code, notes and CSV under `TEXT_PREVIEW_BYTES`.
 * - `native`: iOS draws it from a local copy (PDF, video, audio, Office and iWork documents).
 * - `none`: nothing on the phone can show it; Download stands in.
 */
export type PreviewKind = "image" | "text" | "native" | "none";

const IMAGE = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "heic",
  "heif",
  "tif",
  "tiff",
]);
const NATIVE = new Set([
  "pdf",
  "mp4",
  "m4v",
  "mov",
  "mp3",
  "m4a",
  "aac",
  "wav",
  "doc",
  "docx",
  "pages",
  "rtf",
  "xls",
  "xlsx",
  "numbers",
  "ppt",
  "pptx",
  "key",
]);
const TEXT = new Set([
  "txt",
  "log",
  "text",
  "env",
  "csv",
  "tsv",
  "md",
  "mdx",
  "json",
  "jsonc",
  "xml",
  "svg",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "mts",
  "cts",
  "tsx",
  "html",
  "htm",
  "css",
  "scss",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cpp",
  "cc",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "sql",
  "yml",
  "yaml",
  "toml",
  "ini",
  "lua",
  "dart",
  "ex",
  "exs",
  "vue",
  "svelte",
  "graphql",
  "dockerfile",
]);

/** Text over this shows Download instead: the preview reads the whole file. */
export const TEXT_PREVIEW_BYTES = 512 * 1024;

/** "report.final.PDF" → "pdf"; "Dockerfile" → "dockerfile"; "notes" → "". */
export function extensionOf(name: string) {
  const dot = name.lastIndexOf(".");
  if (dot > 0) return name.slice(dot + 1).toLowerCase();
  return name.toLowerCase() === "dockerfile" ? "dockerfile" : "";
}

/** The extension or, failing it, the MIME type, as a way to preview. */
export function previewKindOf(file: { name: string; mimeType: string | null; size: number }) {
  const ext = extensionOf(file.name);
  const mime = (file.mimeType ?? "").toLowerCase();
  if (IMAGE.has(ext) || (!ext && mime.startsWith("image/"))) return "image" satisfies PreviewKind;
  if (NATIVE.has(ext) || mime === "application/pdf") return "native" satisfies PreviewKind;
  if (TEXT.has(ext) || mime.startsWith("text/")) {
    return file.size <= TEXT_PREVIEW_BYTES
      ? ("text" satisfies PreviewKind)
      : ("none" satisfies PreviewKind);
  }
  if (mime.startsWith("video/") || mime.startsWith("audio/")) return "native" satisfies PreviewKind;
  if (mime.startsWith("image/")) return "image" satisfies PreviewKind;
  return "none" satisfies PreviewKind;
}

/** What a file is, as the web's `fileType` names it: which glyph its tile draws. */
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

const VIDEO = new Set(["mp4", "m4v", "webm", "mov", "ogv"]);
const AUDIO = new Set(["mp3", "m4a", "aac", "wav", "ogg", "oga", "opus", "flac"]);
const ARCHIVE = new Set(["zip", "gz", "tgz", "tar", "rar", "7z", "bz2", "xz"]);
const SPREADSHEET = new Set(["xls", "xlsx", "numbers", "ods"]);
const DOCUMENT = new Set(["doc", "docx", "pages", "odt", "rtf"]);
const PRESENTATION = new Set(["ppt", "pptx", "key", "odp"]);
const PLAIN = new Set(["txt", "log", "text", "env"]);
const CSV = new Set(["csv", "tsv"]);

const KINDS: { kind: FileKind; matches: (ext: string, mime: string) => boolean }[] = [
  { kind: "image", matches: (e, m) => IMAGE.has(e) || m.startsWith("image/") },
  { kind: "pdf", matches: (e, m) => e === "pdf" || m === "application/pdf" },
  { kind: "video", matches: (e, m) => VIDEO.has(e) || m.startsWith("video/") },
  { kind: "audio", matches: (e, m) => AUDIO.has(e) || m.startsWith("audio/") },
  { kind: "csv", matches: (e, m) => CSV.has(e) || m === "text/csv" },
  { kind: "text", matches: (e) => PLAIN.has(e) },
  { kind: "code", matches: (e) => TEXT.has(e) },
  { kind: "text", matches: (_, m) => m.startsWith("text/") },
  { kind: "archive", matches: (e) => ARCHIVE.has(e) },
  { kind: "spreadsheet", matches: (e) => SPREADSHEET.has(e) },
  { kind: "document", matches: (e) => DOCUMENT.has(e) },
  { kind: "presentation", matches: (e) => PRESENTATION.has(e) },
];

/** The extension or, failing it, the MIME type, as a kind of file. */
export function fileKindOf(file: { name: string; mimeType: string | null }) {
  const ext = extensionOf(file.name);
  const mime = (file.mimeType ?? "").toLowerCase();
  return KINDS.find((rule) => rule.matches(ext, mime))?.kind ?? "other";
}
