import { markdownToDoc } from "./markdown.ts";

/**
 * A doc's text as the editor flattens it to place comments: its text runs joined, a line break
 * between blocks, no Markdown. A comment's quote, prefix and suffix are found in this text.
 */
export function docText(markdown: string) {
  const parts: string[] = [];
  let broken = true;
  markdownToDoc(markdown).descendants((node) => {
    if (node.isText) {
      parts.push(node.text ?? "");
      broken = false;
      return false;
    }
    if (node.isTextblock && !broken) {
      parts.push("\n");
      broken = true;
    }
    return true;
  });
  return parts.join("");
}
