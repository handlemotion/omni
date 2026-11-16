// The web addresses in a plain-text mail, so a reader can open them with a click. Pure
// (`@omni/mail-core/links`), for the web app and iOS.
//
// Only http and https become links: a `javascript:` or `data:` address in someone's mail stays
// text. The result is text and hrefs, never markup, so the reader renders it as text nodes.

export interface TextSegment {
  text: string;
  /** Set when `text` is a web address: the URL to open. */
  href?: string;
}

// Stops at whitespace and at the characters plain-text mail wraps an address in (`<url>`, "url").
const URL_START = /\bhttps?:\/\/[^\s<>"]+/giu;

// Sentence punctuation after an address belongs to the sentence ("see https://a.example.").
const TRAILING = /[.,;:!?'*_]+$/u;

const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** Drops trailing punctuation, and a closing bracket that does not close one inside the URL. */
function trimEnd(raw: string): string {
  let url = raw;
  for (;;) {
    const before = url;
    url = url.replace(TRAILING, "");
    const last = url.at(-1) ?? "";
    const open = CLOSERS[last];
    if (open && count(url, open) < count(url, last)) url = url.slice(0, -1);
    if (url === before) return url;
  }
}

const count = (text: string, char: string) => text.split(char).length - 1;

function webAddress(candidate: string): string | null {
  try {
    const url = new URL(candidate);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** `text` split into plain runs and web addresses, in order; joined, the runs give back `text`. */
export function linkSegments(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let from = 0;
  for (const match of text.matchAll(URL_START)) {
    const shown = trimEnd(match[0]);
    const href = webAddress(shown);
    if (!href) continue;
    if (match.index > from) segments.push({ text: text.slice(from, match.index) });
    segments.push({ text: shown, href });
    from = match.index + shown.length;
  }
  if (from < text.length) segments.push({ text: text.slice(from) });
  return segments;
}
