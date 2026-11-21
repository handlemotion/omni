import type { Editor, Range } from "@tiptap/core";
import {
  IconBlockquote,
  IconBold,
  IconBulletList,
  IconCodeBlock,
  IconDivider,
  IconH1,
  IconH2,
  IconH3,
  IconNumberedList,
  IconParagraph,
  IconTable,
  IconChecklist,
  IconImage,
  IconDropdown,
} from "@/components/icons/central";
import { pickImages } from "./drive-files.tsx";

/** A kind of block the `/` menu and the block handle's add can put in a doc. */
export interface BlockKind {
  id: string;
  label: string;
  icon: typeof IconBold;
  /** More words that find it from the `/` menu. */
  words: string[];
  /** Turns the block at the cursor into this kind (or inserts it there). */
  run: (editor: Editor) => void;
}

const chain = (editor: Editor) => editor.chain().focus();

function addDropdown(editor: Editor) {
  const { $from } = editor.state.selection;
  if ($from.parent.type.name !== "paragraph") return chain(editor).setDetails().run();
  const text = $from.parent.textContent;
  const at = $from.before();
  return chain(editor)
    .insertContentAt(
      { from: at, to: $from.after() },
      {
        type: "details",
        attrs: { open: true },
        content: [
          { type: "detailsSummary", content: text ? [{ type: "text", text }] : [] },
          { type: "detailsContent", content: [{ type: "paragraph" }] },
        ],
      },
    )
    .setTextSelection(at + 2 + text.length)
    .run();
}

export const BLOCKS: BlockKind[] = [
  {
    id: "text",
    label: "Text",
    icon: IconParagraph,
    words: ["paragraph", "plain"],
    run: (editor) => chain(editor).setParagraph().run(),
  },
  {
    id: "h1",
    label: "Heading 1",
    icon: IconH1,
    words: ["title", "h1", "big"],
    run: (editor) => chain(editor).setHeading({ level: 1 }).run(),
  },
  {
    id: "h2",
    label: "Heading 2",
    icon: IconH2,
    words: ["subtitle", "h2"],
    run: (editor) => chain(editor).setHeading({ level: 2 }).run(),
  },
  {
    id: "h3",
    label: "Heading 3",
    icon: IconH3,
    words: ["h3", "small"],
    run: (editor) => chain(editor).setHeading({ level: 3 }).run(),
  },
  {
    id: "todo",
    label: "To-do list",
    icon: IconChecklist,
    words: ["todo", "task", "check", "checkbox"],
    run: (editor) => chain(editor).toggleTaskList().run(),
  },
  {
    id: "bullets",
    label: "Bulleted list",
    icon: IconBulletList,
    words: ["unordered", "ul", "list"],
    run: (editor) => chain(editor).toggleBulletList().run(),
  },
  {
    id: "numbers",
    label: "Numbered list",
    icon: IconNumberedList,
    words: ["ordered", "ol", "list"],
    run: (editor) => chain(editor).toggleOrderedList().run(),
  },
  {
    id: "table",
    label: "Table",
    icon: IconTable,
    words: ["grid", "rows", "columns"],
    run: (editor) => chain(editor).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: "image",
    label: "Image",
    icon: IconImage,
    words: ["picture", "photo", "img"],
    run: (editor) => pickImages(editor),
  },
  {
    id: "dropdown",
    label: "Dropdown",
    icon: IconDropdown,
    words: ["toggle", "collapse", "details", "fold", "accordion"],
    run: (editor) => addDropdown(editor),
  },
  {
    id: "quote",
    label: "Quote",
    icon: IconBlockquote,
    words: ["blockquote", "citation"],
    run: (editor) => chain(editor).toggleBlockquote().run(),
  },
  {
    id: "code",
    label: "Code",
    icon: IconCodeBlock,
    words: ["snippet", "pre"],
    run: (editor) => chain(editor).toggleCodeBlock().run(),
  },
  {
    id: "divider",
    label: "Divider",
    icon: IconDivider,
    words: ["rule", "line", "separator", "hr"],
    run: (editor) => chain(editor).setHorizontalRule().run(),
  },
];

/** A kind by its id, for the toolbar's buttons. */
export const block = (id: string) => BLOCKS.find((each) => each.id === id)!;

/** The kinds a `/` query finds: by the start of a word in the label, or of another word. */
export function findBlocks(query: string) {
  const q = query.trim().toLowerCase();
  if (!q) return BLOCKS;
  return BLOCKS.filter((block) =>
    [...block.label.toLowerCase().split(/[\s-]+/), ...block.words].some((word) =>
      word.startsWith(q),
    ),
  );
}

/** Runs a kind picked from the `/` menu: the typed `/query` goes, then the block changes. */
export function runBlock(editor: Editor, range: Range, block: BlockKind) {
  editor.chain().focus().deleteRange(range).run();
  block.run(editor);
}
