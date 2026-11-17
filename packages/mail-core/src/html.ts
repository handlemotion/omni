import createDOMPurify from "dompurify";
import { convert } from "html-to-text";
import { JSDOM } from "jsdom";
import type { ParsedMessage } from "./parse.ts";
import { CSS_UNSAFE, dropUnsafeRules, removeImports, replaceUrls } from "./css.ts";
import { stripReply, type StrippedText } from "./reply.ts";
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
} from "./tree.ts";

export { MAX_HTML_DEPTH } from "./tree.ts";

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

function clip(html: string) {
  return html.length > MAX_HTML_LENGTH ? html.slice(0, MAX_HTML_LENGTH) : html;
}

const NON_NESTING = new Set(
  "area base br col embed hr img input link meta source track wbr p li dt dd option optgroup tr td th thead tbody tfoot colgroup caption rb rt rp rtc html head body".split(
    " ",
  ),
);

function nestsTooDeep(html: string) {
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

function isQuoteContainer(element: Element) {
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
const OUTLOOK_WEB_MARKERS = ["appendonsend", "divRplyFwdMsg"];

const newContent: (html: string) => Element | null = (html) => {
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
};

/** Removes quoted history and signatures from HTML, keeping only the new content. */
export function stripQuotedHtml(html: string) {
  const body = newContent(html);
  return body === null ? clip(html) : innerHtml(body);
}

function removeFrom(node: Element, body: Element) {
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
export function htmlToPlainText(html: string) {
  let input = clip(html);
  if (nestsTooDeep(input)) input = input.replace(/<[^<>]*>/g, " ");
  return convert(input, {
    wordwrap: false,
    limits: { maxDepth: MAX_HTML_DEPTH },
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
      ...["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({
        selector,
        options: { uppercase: false },
      })),
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
export const cleanMessage: (
  message: Pick<ParsedMessage, "text" | "html" | "subject">,
) => StrippedText = (message) => {
  if (message.text !== null) return stripReply(message.text, message.subject);
  if (message.html === null) return { cleanText: "", forwarded: null };

  const full = stripReply(htmlToPlainText(message.html), message.subject);
  if (full.forwarded) return full;
  return stripReply(htmlToPlainText(stripQuotedHtml(message.html)), message.subject);
};

const LONG_FORM_WORDS = 120;

/** Spec rendering rule: long (over ~120 words) or tabular messages render as cards, not bubbles. */
export function isLongForm(message: { cleanText: string; html: string | null }) {
  const words = message.cleanText.split(/\s+/).filter(Boolean).length;
  if (words > LONG_FORM_WORDS) return true;
  if (message.html === null) return false;
  const body = newContent(message.html);
  if (body === null) return true;
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
  "template",
];
const FORBID_ATTR = ["srcset", "background", "poster", "ping", "action", "formaction"];

const BODY_TAG = /<body\b([^>]*)>/i;

function restoreBodyStyle(fragment: ReturnType<typeof parseBodyFragment>, html: string) {
  const attrs = BODY_TAG.exec(html)?.[1];
  if (!attrs) return;
  const body = parseBodyFragment(`<div${attrs}>`).childNodes.find(isElement);
  if (!body) return;
  const bgcolor = attribute(body, "bgcolor");
  const style = attribute(body, "style") ?? "";
  const hint =
    bgcolor && /^#?[\da-z]+$/i.test(bgcolor) ? `:where(body){background-color:${bgcolor}}` : "";
  const inline = style && !/[{}<]/.test(style) ? `html body{${style}}` : "";
  if (!hint && !inline) return;
  const rule = parseBodyFragment(`<style>${hint}${inline}</style>`).childNodes.find(isElement);
  if (!rule) return;
  rule.parentNode = fragment;
  fragment.childNodes.unshift(rule);
}

/**
 * Email-safe HTML: no scripts, forms or handlers; remote images blocked or proxied; cid:
 * mapped; links open outside the frame without a referrer.
 */
export function sanitizeHtml(html: string, options: SanitizeOptions) {
  const input = clip(html);
  const limit = input === html ? null : "clipped";
  if (nestsTooDeep(input)) {
    const result: SanitizedHtml = {
      html: "",
      remoteImageCount: 0,
      linkMismatches: [],
      limit: "too-deep",
    };
    return result;
  }

  const fragment = parseBodyFragment(input);
  restoreBodyStyle(fragment, input);
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
    ADD_URI_SAFE_ATTR: [STYLE_ATTR],
    ALLOW_DATA_ATTR: false,
    FORCE_BODY: true,
  });
  const result: SanitizedHtml = {
    html: clean.replaceAll(` ${STYLE_ATTR}="`, ' style="'),
    remoteImageCount,
    linkMismatches,
    limit,
  };
  return result;
}

const HOST_TEXT =
  /^(?:https?:\/\/)?((?:[\p{L}\p{N}-]+\.)+\p{L}[\p{L}\p{N}-]{1,62})(?::\d{1,5})?(?:[/?#]\S*)?$/iu;

function hostOf(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

const linkMismatch: (rawText: string, href: string) => LinkMismatch | null = (rawText, href) => {
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
};

function contentIdFromUrl(url: string) {
  const id = url.slice(4).replace(/^<|>$/g, "");
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

const classifyUrl: (url: string) => "data" | "cid" | "remote" | "other" = (url) => {
  if (/^data:image\//i.test(url)) return "data";
  if (/^cid:/i.test(url)) return "cid";
  if (/^(?:https?:)?\/\//i.test(url)) return "remote";
  return "other";
};

function rewriteCss(input: string, options: SanitizeOptions, block: boolean) {
  const css = CSS_UNSAFE.test(input) ? dropUnsafeRules(input) : input;
  if (CSS_UNSAFE.test(css)) return "";
  const rewritten = replaceUrls(removeImports(css), (raw) => {
    let url = raw.trim();
    const quote = url[0];
    if ((quote === '"' || quote === "'") && url.length >= 2 && url.endsWith(quote)) {
      url = url.slice(1, -1).trim();
    }
    if (/["'()]/.test(url)) return "none";
    const kind = classifyUrl(url);
    if (kind === "data") return `url("${url}")`;
    if (kind === "cid") {
      const target = options.cidUrl(contentIdFromUrl(url));
      return target === null ? "none" : `url("${target}")`;
    }
    if (kind === "remote" && !block) return `url("${options.proxyUrl(url)}")`;
    return "none";
  });
  return rewritten ?? "";
}
