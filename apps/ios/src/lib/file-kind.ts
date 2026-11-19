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
