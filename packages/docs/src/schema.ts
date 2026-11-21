import { Image } from "@tiptap/extension-image";
import { OrderedList, TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import type { Extensions } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Dropdown, DropdownContent, DropdownSummary } from "./dropdown.ts";

const numbered = OrderedList.config.markdownTokenizer!;
const NumberedList = OrderedList.extend({
  markdownTokenizer: {
    ...numbered,
    tokenize: (src, tokens, lexer) =>
      /^ {0,3}\d{1,9}[.)][ \t]/.test(src) ? numbered.tokenize(src, tokens, lexer) : undefined,
  },
});

/**
 * The blocks a doc is made of, and how they read and write as Markdown: the one schema the
 * editor, its live copy and every export share. `history: false` when Yjs keeps the undo stack.
 */
export function docExtensions(options: { history: boolean }) {
  const result: Extensions = [
    StarterKit.configure({
      orderedList: false,
      link: { openOnClick: false },
      ...(options.history ? {} : { undoRedo: false }),
    }),
    NumberedList,
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    Image,
    Dropdown,
    DropdownSummary,
    DropdownContent,
    Markdown,
  ];
  return result;
}
