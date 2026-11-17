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
// Not `_`: it ends real tokens (`?token=abc_`), and cutting it opens the wrong address.
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", "*"]);

const OPENERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/**
 * Drops trailing punctuation, and closing brackets that close none inside the URL. One count of
 * each bracket, then one walk back from the end: a run of `)` costs linear time, not quadratic.
 */
function trimEnd(url: string) {
  const counts = new Map<string, number>();
  for (const char of url) {
    if (char in OPENERS || Object.values(OPENERS).includes(char)) {
      counts.set(char, (counts.get(char) ?? 0) + 1);
    }
  }
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1] ?? "";
    const open = OPENERS[last];
    if (TRAILING.has(last)) end--;
    else if (open && (counts.get(open) ?? 0) < (counts.get(last) ?? 0)) {
      counts.set(last, (counts.get(last) ?? 0) - 1);
      end--;
    } else break;
  }
  return url.slice(0, end);
}

function webAddress(candidate: string) {
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
export function linkSegments(text: string) {
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
  return segments satisfies TextSegment[];
}
