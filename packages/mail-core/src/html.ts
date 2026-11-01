// DOM-backed helpers, exported from `@omni/mail-core/clean`.
//
// jsdom, not linkedom or happy-dom: DOMPurify reports itself unsupported on linkedom and
// returns input untouched, and on happy-dom it kept <script> and javascript: links.
import createDOMPurify from "dompurify";
import { convert } from "html-to-text";
import { JSDOM } from "jsdom";
import type { ParsedMessage } from "./parse";
import { stripReply, type StrippedText } from "./reply";

const { window } = new JSDOM("");

function parseDocument(html: string): Document {
  return new window.DOMParser().parseFromString(html, "text/html");
}

// Containers clients wrap quoted history (and Gmail its signature) in.
const QUOTE_SELECTORS = [
  ".gmail_quote_container",
  ".gmail_quote",
  ".gmail_signature",
  "blockquote[type=cite]",
  ".moz-cite-prefix",
  ".yahoo_quoted",
];
// Outlook web marks where quoted history starts; everything after it is history too.
// Outlook desktop has no marker: its "From: … Sent: …" block is cut by the text rules.
const OUTLOOK_WEB_MARKERS = ["#appendonsend", "#divRplyFwdMsg"];

/** Removes quoted history and signatures from HTML, keeping only the new content. */
export function stripQuotedHtml(html: string): string {
  const doc = parseDocument(html);
  for (const selector of OUTLOOK_WEB_MARKERS) {
    const marker = doc.querySelector(selector);
    if (marker) removeFrom(marker);
  }
  for (const node of doc.querySelectorAll(QUOTE_SELECTORS.join(","))) node.remove();
  return doc.body.innerHTML;
}

/** Removes `node`, everything after it, and everything after each of its ancestors. */
function removeFrom(node: Element): void {
  const previous = node.previousElementSibling;
  if (previous?.tagName === "HR") previous.remove();
  for (
    let current: Element | null = node;
    current && current.tagName !== "BODY";
    current = current.parentElement
  ) {
    while (current.nextSibling) current.nextSibling.remove();
  }
  node.remove();
}

/** Readable plain text from HTML: no link targets, no images, blockquotes as "> " lines. */
export function htmlToPlainText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      ...["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({
        selector,
        options: { uppercase: false },
      })),
      // Layout tables are everywhere in mail; read them as blocks, not ASCII grids.
      { selector: "table", format: "block" },
      { selector: "tr", format: "block" },
      { selector: "td", format: "block" },
      { selector: "th", format: "block" },
      ...["button", "input", "select", "textarea"].map((selector) => ({
        selector,
        format: "skip",
      })),
    ],
  });
}

/**
 * `clean_text` for a message. Uses the text part when there is one; for HTML-only mail it
 * cuts quoted history out of the HTML structure first, which is more reliable than text rules.
 */
export function cleanMessage(
  message: Pick<ParsedMessage, "text" | "html" | "subject">,
): StrippedText {
  if (message.text !== null) return stripReply(message.text, message.subject);
  if (message.html === null) return { cleanText: "", forwarded: null };

  // Forward detection reads the full body: the forwarded part sits inside the quote containers.
  const full = stripReply(htmlToPlainText(message.html), message.subject);
  if (full.forwarded) return full;
  return stripReply(htmlToPlainText(stripQuotedHtml(message.html)), message.subject);
}

const LONG_FORM_WORDS = 120;

/** Spec rendering rule: long (over ~120 words) or tabular messages render as cards, not bubbles. */
export function isLongForm(message: { cleanText: string; html: string | null }): boolean {
  const words = message.cleanText.split(/\s+/).filter(Boolean).length;
  if (words > LONG_FORM_WORDS) return true;
  if (message.html === null) return false;
  // Only data tables count: Outlook and many signatures lay out a single row with a table.
  const doc = parseDocument(stripQuotedHtml(message.html));
  return [...doc.querySelectorAll("table")].some((table) => {
    const rows = [...table.rows].filter((row) => row.cells.length >= 2);
    return rows.length >= 2;
  });
}

export interface SanitizeOptions {
  /** Our image-proxy URL for a remote image URL. */
  proxyUrl: (src: string) => string;
  /** URL for an inline attachment by Content-ID, or null to drop the image. */
  cidUrl: (contentId: string) => string | null;
  /**
   * `block` (default) leaves remote images unloaded: their proxied URL goes in
   * `data-omni-src` for the client to swap in when the reader asks. `proxy` loads them now.
   */
  remoteImages?: "block" | "proxy";
}

export interface SanitizedHtml {
  html: string;
  /** Remote images found, so the client knows whether to offer "load images". */
  remoteImageCount: number;
}

/** The client swaps this into `src` when the reader loads remote images. */
export const BLOCKED_SRC_ATTR = "data-omni-src";

const FORBID_TAGS = [
  "base",
  "link",
  "meta",
  "form",
  "input",
  "button",
  "select",
  "option",
  "textarea",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "audio",
  "video",
  "source",
  "track",
  "portal",
];
// Attributes that fetch remote resources we cannot proxy one by one.
const FORBID_ATTR = ["srcset", "background", "poster", "ping", "action", "formaction"];

/** Email-safe HTML: no scripts, forms or handlers; remote images blocked or proxied; cid: mapped. */
export function sanitizeHtml(html: string, options: SanitizeOptions): SanitizedHtml {
  const purify = createDOMPurify(window);
  const block = (options.remoteImages ?? "block") === "block";
  let remoteImageCount = 0;

  purify.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style" && node.textContent) {
      node.textContent = rewriteCss(node.textContent, options, block);
    }
  });

  purify.addHook("afterSanitizeAttributes", (node) => {
    const element = node as Element;
    const style = element.getAttribute("style");
    if (style) element.setAttribute("style", rewriteCss(style, options, block));

    if (element.tagName === "A" && element.hasAttribute("href")) {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener noreferrer nofollow");
    }

    if (element.tagName !== "IMG") return;
    const src = (element.getAttribute("src") ?? "").trim();
    const kind = classifyUrl(src);
    if (kind === "data") return;
    element.removeAttribute("src");
    if (kind === "cid") {
      const url = options.cidUrl(contentIdFromUrl(src));
      if (url === null) element.remove();
      else element.setAttribute("src", url);
    } else if (kind === "remote") {
      remoteImageCount++;
      const proxied = options.proxyUrl(src.startsWith("//") ? `https:${src}` : src);
      element.setAttribute(block ? BLOCKED_SRC_ATTR : "src", proxied);
    } else {
      element.remove();
    }
  });

  const clean = purify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS,
    FORBID_ATTR,
    // Senders must not be able to supply `data-omni-src` themselves.
    ALLOW_DATA_ATTR: false,
    // Keep <style> from <head>: newsletters depend on it.
    FORCE_BODY: true,
  });
  return { html: clean, remoteImageCount };
}

function contentIdFromUrl(url: string): string {
  const id = url.slice(4).replace(/^<|>$/g, "");
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

function classifyUrl(url: string): "data" | "cid" | "remote" | "other" {
  if (/^data:image\//i.test(url)) return "data";
  if (/^cid:/i.test(url)) return "cid";
  if (/^(?:https?:)?\/\//i.test(url)) return "remote";
  return "other";
}

const CSS_URL = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;

function rewriteCss(css: string, options: SanitizeOptions, block: boolean): string {
  // CSS escapes can spell `url(` in ways a regex cannot see, and image-set() takes bare
  // strings as URLs. Both are rare in mail, so drop such CSS rather than parse it.
  if (/\\|image-set\s*\(/i.test(css)) return "";
  return css
    .replace(/@import[^;]*;?/gi, "")
    .replace(CSS_URL, (_match, _quote: string, raw: string) => {
      const url = raw.trim();
      // A quote or paren inside the URL could close url() early and smuggle in a second one.
      if (/["'()]/.test(url)) return "none";
      const kind = classifyUrl(url);
      if (kind === "data") return `url("${url}")`;
      if (kind === "cid") {
        const target = options.cidUrl(contentIdFromUrl(url));
        return target === null ? "none" : `url("${target}")`;
      }
      // Background images cannot be swapped in later like <img>, so blocked means gone.
      if (kind === "remote" && !block) return `url("${options.proxyUrl(url)}")`;
      return "none";
    });
}
