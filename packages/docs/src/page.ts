import { readableMarkdown } from "./entities.ts";
import { docToMarkdown, markdownToDoc } from "./markdown.ts";

const LETTER = /[\p{L}\p{N}]/gu;

const words = (markdown: string) =>
  markdown
    .replace(/&#(x?)([\da-f]{1,6});/gi, (_, hex: string, code: string) =>
      String.fromCodePoint(parseInt(code, hex ? 16 : 10) || 32),
    )
    .replace(/\[([^\]]*)\]\(mailto:[^)]*\)/g, "$1")
    .replace(/<([^<>\s@]+@[^<>\s]+)>/g, "$1")
    .replace(/^\s*\d+[.)]\s/gm, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");

const written = (markdown: string) => {
  try {
    return docToMarkdown(markdownToDoc(markdown));
  } catch {
    return "";
  }
};

function lineAt(markdown: string, at: number) {
  let seen = 0;
  for (const line of markdown.split("\n")) {
    seen += line.match(LETTER)?.length ?? 0;
    if (seen > at) return line;
  }
  return markdown.split("\n").at(-1) ?? "";
}

/**
 * Where a doc's Markdown stops reading the same once the page has read and written it back: the
 * first line whose words it drops or changes, or undefined when every word survives. A doc with
 * such a line opens as its Markdown source instead of as a page, so nothing in it is lost.
 */
export function pageLoss(markdown: string) {
  const text = readableMarkdown(markdown);
  const before = words(text);
  const after = words(written(text));
  if (before === after) return undefined;
  let at = 0;
  while (at < before.length && before[at] === after[at]) at++;
  return lineAt(text, at).trim() || "(the end of the doc)";
}
