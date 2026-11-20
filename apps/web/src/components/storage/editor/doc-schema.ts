import { TaskItem, TaskList } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import { Markdown } from "@tiptap/markdown";
import type { Extensions } from "@tiptap/react";
import { StarterKit } from "@tiptap/starter-kit";

/**
 * The blocks a doc is made of, and how they read and write as Markdown: the one schema the
 * editor, its live copy and every export share. `history: false` when Yjs keeps the undo stack.
 */
export function docExtensions(options: { history: boolean }) {
  const result: Extensions = [
    StarterKit.configure({
      link: { openOnClick: false },
      ...(options.history ? {} : { undoRedo: false }),
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TableKit.configure({ table: { resizable: false } }),
    Markdown,
  ];
  return result;
}
