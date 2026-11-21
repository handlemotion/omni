import { Details, DetailsContent, DetailsSummary } from "@tiptap/extension-details";
import type { JSONContent, MarkdownToken } from "@tiptap/core";

const OPEN = /^<details( open)?>[ \t]*\n/;
const TAG = /<(\/?)details\b[^>]*>/g;
const SUMMARY = /^\s*<summary>([\s\S]*?)<\/summary>[ \t]*\n?/;

function closingEnd(src: string) {
  let depth = 0;
  TAG.lastIndex = 0;
  for (let match = TAG.exec(src); match; match = TAG.exec(src)) {
    depth += match[1] ? -1 : 1;
    if (depth === 0) return match.index + match[0].length;
  }
  return -1;
}

const textOf = (node: JSONContent | undefined, h: { renderChildren: Function }) =>
  node?.content ? (h.renderChildren(node.content) as string) : "";

/**
 * A dropdown: a line that opens to show the blocks under it. In Markdown it is the HTML that
 * GitHub and most readers show folded, so an agent reads and writes it as it would anywhere:
 *
 *     <details>
 *     <summary>The line</summary>
 *
 *     The blocks inside.
 *
 *     </details>
 */
export const Dropdown = Details.extend({
  markdownTokenizer: {
    name: "details",
    level: "block",
    start: (src: string) => src.search(/^<details[ >]/m),
    tokenize(src: string, _tokens: MarkdownToken[], lexer) {
      const open = src.match(OPEN);
      if (!open) return undefined;
      const end = closingEnd(src);
      if (end === -1) return undefined;
      const inner = src.slice(open[0].length, src.lastIndexOf("</details>", end));
      const summary = inner.match(SUMMARY);
      const body = summary ? inner.slice(summary[0].length) : inner;
      return {
        type: "details",
        raw: src.slice(0, end),
        open: !!open[1],
        summary: lexer.inlineTokens(summary?.[1]?.trim() ?? ""),
        tokens: lexer.blockTokens(body),
      };
    },
  },
  parseMarkdown: (token, h) =>
    h.createNode("details", { open: !!token.open }, [
      h.createNode("detailsSummary", {}, h.parseInline((token.summary as MarkdownToken[]) ?? [])),
      h.createNode("detailsContent", {}, h.parseChildren(token.tokens ?? [])),
    ]),
  renderMarkdown: (node, h) => {
    const [summary, content] = node.content ?? [];
    const body = content?.content ? h.renderChildren(content.content, "\n\n") : "";
    const tag = node.attrs?.open ? "<details open>" : "<details>";
    return `${tag}\n<summary>${textOf(summary, h)}</summary>\n\n${body}\n\n</details>`;
  },
}).configure({ persist: true });

/** Its line and its blocks: read and written only as part of the dropdown. */
export const DropdownSummary = DetailsSummary.extend({
  markdownTokenizer: undefined,
  parseMarkdown: undefined,
  renderMarkdown: undefined,
});

export const DropdownContent = DetailsContent.extend({
  markdownTokenizer: undefined,
  parseMarkdown: undefined,
  renderMarkdown: undefined,
});
