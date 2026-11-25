import { uploadContentId } from "@omni/mail-core/compose";
import type { ComposerFile } from "@/hooks/use-compose.ts";

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Plain text (a signature, a canned reply, an older draft) as the editor's paragraphs. */
export function textToHtml(text: string) {
  return text
    .split("\n")
    .map((line) => `<p>${escape(line)}</p>`)
    .join("");
}

const parse = (html: string) => new DOMParser().parseFromString(html, "text/html").body;

/** Inline images still in the body, by the composer file they show. */
export function shownFiles(html: string) {
  return new Set(
    [...parse(html).querySelectorAll("img[data-file]")].map((img) => img.getAttribute("data-file")),
  );
}

/**
 * The files a send or a draft carries: every attachment, and the inline images the body still
 * shows (one pasted and then deleted is left out).
 */
export function carriedFiles(files: ComposerFile[], html: string) {
  const shown = shownFiles(html);
  return files.filter((f) => !f.inline || shown.has(f.id));
}

/**
 * The body as it goes out (and is saved in a draft): each inline image points at its upload's
 * `cid:`, one not uploaded yet is left out, and lines are `div`s, as mail apps write them, so
 * recipients don't see a paragraph gap after each line.
 */
export function wireHtml(html: string, files: ComposerFile[]) {
  const body = parse(html);
  for (const img of body.querySelectorAll("img[data-file]")) {
    const file = files.find((f) => f.id === img.getAttribute("data-file"));
    if (file?.status !== "ready" || file.attachment?.kind !== "upload") {
      img.remove();
      continue;
    }
    img.setAttribute("src", `cid:${uploadContentId(file.attachment.uploadId)}`);
    img.setAttribute("style", "max-width: 100%; height: auto;");
    img.removeAttribute("data-file");
  }
  for (const p of body.querySelectorAll("p")) {
    const div = body.ownerDocument.createElement("div");
    div.innerHTML = p.innerHTML || "<br>";
    p.replaceWith(div);
  }
  return body.innerHTML;
}

/**
 * The body with each uploaded inline image shown from its upload rather than a local preview, so
 * it still shows after the editor that made the preview is gone (an undone send, reopened).
 */
export function uploadedImages(html: string, files: ComposerFile[]) {
  const body = parse(html);
  for (const img of body.querySelectorAll("img[data-file]")) {
    const file = files.find((f) => f.id === img.getAttribute("data-file"));
    if (file?.status !== "ready" || file.attachment?.kind !== "upload") continue;
    img.setAttribute("src", `/api/uploads/${encodeURIComponent(file.attachment.uploadId)}`);
  }
  return body.innerHTML;
}

/** A saved draft's body back in the editor: its `cid:` images shown from their uploads. */
export function editorHtml(html: string, uploadIds: string[]) {
  const body = parse(html);
  for (const img of body.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    const id = uploadIds.find((u) => src === `cid:${uploadContentId(u)}`);
    if (!id) continue;
    img.setAttribute("src", `/api/uploads/${encodeURIComponent(id)}`);
    img.setAttribute("data-file", id);
    img.removeAttribute("style");
  }
  for (const div of body.querySelectorAll(":scope > div")) {
    const p = body.ownerDocument.createElement("p");
    p.innerHTML = div.innerHTML === "<br>" ? "" : div.innerHTML;
    div.replaceWith(p);
  }
  return body.innerHTML;
}

/**
 * The files a paste carries (a screenshot, an image copied from a page, files copied in Finder),
 * or none when it is text: Word and Excel put a picture of the copied text beside its HTML.
 */
export function pastedFiles(data: DataTransfer | null) {
  const files = [...(data?.files ?? [])];
  if (!files.length) return [];
  const html = data?.getData("text/html");
  if (html && parse(html).textContent?.trim()) return [];
  return files.map(namedPaste);
}

function namedPaste(file: File, index: number) {
  if (file.name && file.name !== "image.png") return file;
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  const stamp = new Date().toISOString().slice(0, 19).replace("T", " at ").replaceAll(":", ".");
  const suffix = index ? ` ${index + 1}` : "";
  return new File([file], `Image ${stamp}${suffix}.${ext}`, { type: file.type });
}
