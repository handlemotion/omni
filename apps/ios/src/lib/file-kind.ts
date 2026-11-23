import { TEXT_PREVIEW_BYTES, extensionOf, fileType, isTextExtension } from "@omni/client";

/**
 * How a Drive file previews on the phone:
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
const HASH_COMMENTS = new Set([
  "py",
  "rb",
  "sh",
  "bash",
  "zsh",
  "yml",
  "yaml",
  "toml",
  "dockerfile",
  "ex",
  "exs",
]);
const OMNI_NON_DOC_MIME = /^text\/vnd\.omni\.(?!doc\b)/i;

/** The extension or, failing it, the MIME type, as a way to preview. */
export function previewKindOf(file: { name: string; mimeType: string | null; size: number }) {
  const ext = extensionOf(file.name);
  const mime = (file.mimeType ?? "").toLowerCase();
  if (IMAGE.has(ext) || (!ext && mime.startsWith("image/"))) return "image" satisfies PreviewKind;
  if (NATIVE.has(ext) || mime === "application/pdf") return "native" satisfies PreviewKind;
  if (isTextExtension(ext) || mime.startsWith("text/")) {
    return file.size <= TEXT_PREVIEW_BYTES
      ? ("text" satisfies PreviewKind)
      : ("none" satisfies PreviewKind);
  }
  if (mime.startsWith("video/") || mime.startsWith("audio/")) return "native" satisfies PreviewKind;
  if (mime.startsWith("image/")) return "image" satisfies PreviewKind;
  return "none" satisfies PreviewKind;
}

/** What a file is: which glyph its tile draws. */
export const fileKindOf = (file: { name: string; mimeType: string | null }) =>
  fileType(file.name, file.mimeType).kind;

/** Short uppercase label for a file card's metadata: the extension, else the MIME subtype. */
export const fileLabelOf = (file: { name: string; mimeType: string | null }) =>
  fileType(file.name, file.mimeType).label;

/** Whether a file card renders a mini page preview (doc, code, plain text, or CSV/TSV). */
export function hasCardPage(file: { name: string; mimeType: string | null }) {
  const mime = (file.mimeType ?? "").toLowerCase();
  if (OMNI_NON_DOC_MIME.test(mime)) return false;
  const kind = fileKindOf(file);
  return kind === "doc" || kind === "code" || kind === "text" || kind === "csv";
}

/** Whether a code file uses `#` for line comments (for syntax tinting on its card). */
export function usesHashComments(name: string) {
  return HASH_COMMENTS.has(extensionOf(name));
}
