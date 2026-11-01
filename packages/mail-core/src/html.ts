// DOM-backed helpers, exported from `@omni/mail-core/clean`.
//
// DOMPurify runs on jsdom, not linkedom or happy-dom: DOMPurify reports itself unsupported on
// linkedom and returns input untouched, and on happy-dom it kept <script> and javascript:
// links. The read-only passes (quote cutting, the long-form rule) and the pre-pass before
// DOMPurify use parse5 (`./tree`), which is far cheaper than a jsdom DOM.
import createDOMPurify from "dompurify";
import { convert } from "html-to-text";
import { JSDOM } from "jsdom";
import type { ParsedMessage } from "./parse";
import { stripReply, type StrippedText } from "./reply";
import {
  attribute,
  capDepth,
  type Element,
  elements,
  hasClass,
  innerHtml,
  isElement,
  MAX_HTML_DEPTH,
  parseBody,
  parseBodyFragment,
  remove,
} from "./tree";

export { MAX_HTML_DEPTH } from "./tree";

/**
 * HTML past this many characters is not processed: sanitizing keeps only this much (the
 * result says `clipped`), and text extraction reads only this much. Gmail clips at about
 * 100 KB; real newsletters sit well under this.
 */
export const MAX_HTML_LENGTH = 1_000_000;

/**
 * Tags nested deeper than this make the HTML unrenderable: the HTML parser's work grows with
 * nesting depth, so a few hundred KB of `<div>` takes seconds. Estimated by a linear scan.
 */
export const MAX_TAG_NESTING = 2_000;

const { window } = new JSDOM("");

function clip(html: string): string {
  return html.length > MAX_HTML_LENGTH ? html.slice(0, MAX_HTML_LENGTH) : html;
}

// Elements whose end tag may be left out (the parser closes them) or that never nest.
const NON_NESTING = new Set(
  "area base br col embed hr img input link meta source track wbr p li dt dd option optgroup tr td th thead tbody tfoot colgroup caption rb rt rp rtc html head body".split(
    " ",
  ),
);

/**
 * Upper-bound estimate of how deep `html` nests, from its tags alone. Implied end tags make
 * it overestimate, never underestimate, so a pass means the parser will not be slow.
 */
function nestsTooDeep(html: string): boolean {
  const open = new Map<string, number>();
  let depth = 0;
  for (const match of html.matchAll(/<(\/?)([a-zA-Z][^\s/>]*)/g)) {
    const name = (match[2] ?? "").toLowerCase();
    if (NON_NESTING.has(name)) continue;
    const count = open.get(name) ?? 0;
    if (match[1] === "/") {
      if (count > 0) {
        open.set(name, count - 1);
        depth--;
      }
    } else {
      open.set(name, count + 1);
      if (++depth > MAX_TAG_NESTING) return true;
    }
  }
  return false;
}

/** `true` for mail-client quote containers (and Gmail's signature). */
function isQuoteContainer(element: Element): boolean {
  if (element.tagName === "blockquote" && attribute(element, "type")?.toLowerCase() === "cite") {
    return true;
  }
  return [
    "gmail_quote_container",
    "gmail_quote",
    "gmail_signature",
    "moz-cite-prefix",
    "yahoo_quoted",
  ].some((name) => hasClass(element, name));
}
// Outlook web marks where quoted history starts; everything after it is history too.
// Outlook desktop has no marker: its "From: … Sent: …" block is cut by the text rules.
const OUTLOOK_WEB_MARKERS = ["appendonsend", "divRplyFwdMsg"];

/** The body with quoted history and signatures removed. */
function newContent(html: string): Element | null {
  const input = clip(html);
  if (nestsTooDeep(input)) return null;
  const body = parseBody(input);
  for (const id of OUTLOOK_WEB_MARKERS) {
    for (const element of elements(body)) {
      if (attribute(element, "id") !== id) continue;
      removeFrom(element, body);
      break;
    }
  }
  for (const element of [...elements(body)].filter(isQuoteContainer)) remove(element);
  capDepth(body);
  return body;
}

/** Removes quoted history and signatures from HTML, keeping only the new content. */
export function stripQuotedHtml(html: string): string {
  const body = newContent(html);
  return body === null ? clip(html) : innerHtml(body);
}

/** Removes `node`, everything after it, and everything after each of its ancestors. */
function removeFrom(node: Element, body: Element): void {
  const siblings = node.parentNode?.childNodes ?? [];
  const previous = siblings.slice(0, siblings.indexOf(node)).findLast(isElement);
  if (previous?.tagName === "hr") remove(previous);
  for (let current: Element = node; current !== body;) {
    const parent = current.parentNode as Element | null;
    if (!parent) break;
    parent.childNodes.splice(parent.childNodes.indexOf(current) + 1);
    current = parent;
  }
  remove(node);
}

/** Readable plain text from HTML: no link targets, no images, blockquotes as "> " lines. */
export function htmlToPlainText(html: string): string {
  let input = clip(html);
  // The converter's parser also slows down with depth; hostile nesting is read as tagless text.
  if (nestsTooDeep(input)) input = input.replace(/<[^<>]*>/g, " ");
  return convert(input, {
    wordwrap: false,
    // Nesting past this is dropped (and shown as "..."); the converter recurses per level.
    limits: { maxDepth: MAX_HTML_DEPTH },
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
  const body = newContent(message.html);
  // HTML too deep to parse is not a reply anyone typed.
  if (body === null) return true;
  // Only data tables count: Outlook and many signatures lay out a single row with a table.
  for (const table of elements(body)) {
    if (table.tagName !== "table") continue;
    const rows = table.childNodes
      .filter(isElement)
      .flatMap((child) =>
        ["thead", "tbody", "tfoot"].includes(child.tagName)
          ? child.childNodes.filter(isElement)
          : [child],
      )
      .filter((row) => row.tagName === "tr");
    const dataRows = rows.filter(
      (row) =>
        row.childNodes.filter(
          (cell) => isElement(cell) && (cell.tagName === "td" || cell.tagName === "th"),
        ).length >= 2,
    );
    if (dataRows.length >= 2) return true;
  }
  return false;
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

/** A link whose visible text names a different site than it opens: a phishing hint. */
export interface LinkMismatch {
  /** The link's visible text. */
  text: string;
  href: string;
  /** Host named by the text, punycoded. */
  textHost: string;
  /** Host the link opens, punycoded. */
  hrefHost: string;
}

export interface SanitizedHtml {
  html: string;
  /** Remote images found, so the client knows whether to offer "load images". */
  remoteImageCount: number;
  linkMismatches: LinkMismatch[];
  /**
   * `clipped`: only the first `MAX_HTML_LENGTH` characters are in `html`.
   * `too-deep`: the HTML nests past `MAX_TAG_NESTING`, so `html` is empty; show the text.
   */
  limit: "clipped" | "too-deep" | null;
}

/** The client swaps this into `src` when the reader loads remote images. */
export const BLOCKED_SRC_ATTR = "data-omni-src";

// jsdom parses every `style` attribute through cssstyle each time it is set, which was most
// of sanitizing time. Inline styles travel under this name through DOMPurify and are renamed
// back in the output string; serialized attribute values escape `"`, so the rename cannot
// reach into a value.
const STYLE_ATTR = "data-omni-style";

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
  // Never rendered, and its content sits outside the tree the pre-pass walks.
  "template",
];
// Attributes that fetch remote resources we cannot proxy one by one.
const FORBID_ATTR = ["srcset", "background", "poster", "ping", "action", "formaction"];

/**
 * Email-safe HTML: no scripts, forms or handlers; remote images blocked or proxied; cid:
 * mapped; links open outside the frame without a referrer.
 */
export function sanitizeHtml(html: string, options: SanitizeOptions): SanitizedHtml {
  const input = clip(html);
  const limit = input === html ? null : "clipped";
  if (nestsTooDeep(input)) {
    return { html: "", remoteImageCount: 0, linkMismatches: [], limit: "too-deep" };
  }

  const fragment = parseBodyFragment(input);
  capDepth(fragment);
  for (const element of elements(fragment)) {
    element.attrs = element.attrs
      .filter((attr) => attr.name !== STYLE_ATTR)
      .map((attr) => (attr.name === "style" ? { ...attr, name: STYLE_ATTR } : attr));
  }

  const purify = createDOMPurify(window);
  const block = (options.remoteImages ?? "block") === "block";
  let remoteImageCount = 0;
  const linkMismatches: LinkMismatch[] = [];

  purify.addHook("uponSanitizeElement", (node, data) => {
    if (data.tagName === "style" && node.textContent) {
      node.textContent = rewriteCss(node.textContent, options, block);
    }
  });

  purify.addHook("afterSanitizeAttributes", (node) => {
    const element = node as globalThis.Element;
    for (const name of [STYLE_ATTR, "style"]) {
      const style = element.getAttribute(name);
      if (style === null) continue;
      const css = rewriteCss(style, options, block);
      if (css.trim() === "") element.removeAttribute(name);
      else element.setAttribute(name, css);
    }

    if ((element.tagName === "A" || element.tagName === "AREA") && element.hasAttribute("href")) {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener noreferrer nofollow");
      const mismatch = linkMismatch(element.textContent ?? "", element.getAttribute("href") ?? "");
      if (mismatch) linkMismatches.push(mismatch);
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

  const clean = purify.sanitize(innerHtml(fragment), {
    USE_PROFILES: { html: true },
    FORBID_TAGS,
    FORBID_ATTR,
    ADD_ATTR: [STYLE_ATTR],
    // Like `style`, its value is not a URL: without this DOMPurify reads "color:" as a scheme.
    ADD_URI_SAFE_ATTR: [STYLE_ATTR],
    // Senders must not be able to supply `data-omni-src` themselves.
    ALLOW_DATA_ATTR: false,
    // Keep <style> from <head>: newsletters depend on it.
    FORCE_BODY: true,
  });
  return {
    html: clean.replaceAll(` ${STYLE_ATTR}="`, ' style="'),
    remoteImageCount,
    linkMismatches,
    limit,
  };
}

// A domain, optionally with scheme, port and path: "paypal.com", "https://www.paypal.com/x".
const HOST_TEXT =
  /^(?:https?:\/\/)?((?:[\p{L}\p{N}-]+\.)+\p{L}[\p{L}\p{N}-]{1,62})(?::\d{1,5})?(?:[/?#]\S*)?$/iu;

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Set when the text reads as a domain and the href opens a host outside it. */
function linkMismatch(rawText: string, href: string): LinkMismatch | null {
  const text = rawText.trim();
  if (text.length > 300) return null;
  const named = HOST_TEXT.exec(text)?.[1];
  if (named === undefined) return null;
  const textHost = hostOf(`http://${named}`);
  const hrefHost = hostOf(href.trim());
  if (textHost === null || hrefHost === null) return null;
  const related =
    textHost === hrefHost || hrefHost.endsWith(`.${textHost}`) || textHost.endsWith(`.${hrefHost}`);
  return related ? null : { text, href, textHost, hrefHost };
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

// CSS escapes can spell `url(` in ways a scan cannot see; image-set(), image(), src() take
// URLs outside url(); expression() is old IE script. All rare in mail: drop such CSS whole.
const CSS_UNSAFE = /\\|image-set\s*\(|\bimage\s*\(|\bsrc\s*\(|expression\s*\(/i;

/** CSS with every fetch removed or pointed at our proxy and attachments; "" to drop it. */
function rewriteCss(css: string, options: SanitizeOptions, block: boolean): string {
  if (CSS_UNSAFE.test(css)) return "";
  const rewritten = replaceUrls(removeImports(css), (raw) => {
    let url = raw.trim();
    const quote = url[0];
    if ((quote === '"' || quote === "'") && url.length >= 2 && url.endsWith(quote)) {
      url = url.slice(1, -1).trim();
    }
    // A quote or paren left inside could close url() early and smuggle in a second one.
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
  return rewritten ?? "";
}

// Both scans jump past each match, so they stay linear on hostile input (the regexes they
// replace were quadratic on a run of "url(").

/** Removes `@import` rules, each up to its `;` (or the end of the CSS). */
function removeImports(css: string): string {
  const pattern = /@import/gi;
  let out = "";
  let from = 0;
  for (let match = pattern.exec(css); match; match = pattern.exec(css)) {
    out += css.slice(from, match.index);
    const end = css.indexOf(";", pattern.lastIndex);
    from = end === -1 ? css.length : end + 1;
    pattern.lastIndex = from;
  }
  return out + css.slice(from);
}

/**
 * Replaces each `url(…)` with `replace(…)`. Returns null for an unterminated `url(`: browsers
 * close it at the end of the CSS and load it, so the whole CSS has to go.
 */
function replaceUrls(css: string, replace: (raw: string) => string): string | null {
  const pattern = /url\(/gi;
  let out = "";
  let from = 0;
  for (let match = pattern.exec(css); match; match = pattern.exec(css)) {
    const end = css.indexOf(")", pattern.lastIndex);
    if (end === -1) return null;
    out += css.slice(from, match.index) + replace(css.slice(pattern.lastIndex, end));
    from = end + 1;
    pattern.lastIndex = from;
  }
  return out + css.slice(from);
}
