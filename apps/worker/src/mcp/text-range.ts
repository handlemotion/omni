const PAGE_OR_SLIDE_MARKER = /^--- (?:Page|Slide) (\d+) ---$/gm;

/** The page numbers `spec` names ("3", "2-4", "1,3,5-6"), or null when it names none. */
export function pagesOf(spec: string) {
  const pages = new Set<number>();
  for (const part of spec.split(",")) {
    const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!match) return null;
    const from = Number(match[1]);
    const to = Number(match[2] ?? match[1]);
    if (from < 1 || to < from || to - from > 2_000) return null;
    for (let page = from; page <= to; page++) pages.add(page);
  }
  return pages.size ? pages : null;
}

/**
 * Only the pages or slides in `pages` of a text the readers marked, each under its marker, or
 * null when the text has no markers (it is not a PDF or a deck).
 */
export function selectPages(text: string, pages: Set<number>) {
  const marks = [...text.matchAll(PAGE_OR_SLIDE_MARKER)];
  if (!marks.length) return null;
  const kept = marks.flatMap((mark, i) => {
    if (!pages.has(Number(mark[1]))) return [];
    return [text.slice(mark.index, marks[i + 1]?.index ?? text.length).trimEnd()];
  });
  return kept.join("\n\n");
}
