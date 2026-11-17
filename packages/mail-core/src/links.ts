export interface TextSegment {
  text: string;
  /** Set when `text` is a web address: the URL to open. */
  href?: string;
}

const URL_START = /\bhttps?:\/\/[^\s<>"]+/giu;

const TRAILING = new Set([".", ",", ";", ":", "!", "?", "'", "*"]);

const OPENERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

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
