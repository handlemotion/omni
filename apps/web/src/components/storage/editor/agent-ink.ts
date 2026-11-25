import { Extension } from "@tiptap/core";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import type { Editor } from "@tiptap/react";
import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { useEffect } from "react";
import type { LiveDoc } from "@/lib/live-doc.ts";
import { agentOf } from "@/hooks/use-agent-editing.ts";

/** How long text an agent wrote keeps its ink: the `agent-ink` animation, and a frame to spare. */
export const AGENT_INK_MS = 2_600;

interface Range {
  from: number;
  to: number;
}

interface InkState {
  pending: Range[];
  inked: DecorationSet;
}

type InkMeta = { ink: number } | { forget: true } | { dry: number };

const key = new PluginKey<InkState>("agentInk");

const MOST_CELLS = 250_000;

/**
 * The pairs `[i, j]` of `a[i]` and `b[j]` that stay the same from `a` to `b`, in order: a
 * longest common subsequence, after trimming the ends both share.
 */
export function sameItems<T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean) {
  const pairs: [number, number][] = [];
  let head = 0;
  while (head < a.length && head < b.length && same(a[head] as T, b[head] as T)) {
    pairs.push([head, head]);
    head++;
  }
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    same(a[a.length - 1 - tail] as T, b[b.length - 1 - tail] as T)
  ) {
    tail++;
  }
  const rows = a.length - head - tail;
  const cols = b.length - head - tail;
  if (rows * cols <= MOST_CELLS) pairs.push(...middlePairs(a, b, same, { head, rows, cols }));
  for (let k = tail; k > 0; k--) pairs.push([a.length - k, b.length - k]);
  return pairs;
}

function middlePairs<T>(
  a: readonly T[],
  b: readonly T[],
  same: (x: T, y: T) => boolean,
  { head, rows, cols }: { head: number; rows: number; cols: number },
) {
  const width = cols + 1;
  const table = new Uint32Array((rows + 1) * width);
  const at = (i: number, j: number) => table[i * width + j] ?? 0;
  const alike = (i: number, j: number) => same(a[head + i] as T, b[head + j] as T);
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i * width + j] = alike(i, j)
        ? at(i + 1, j + 1) + 1
        : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (alike(i, j)) pairs.push([head + i++, head + j++]);
    else if (at(i + 1, j) >= at(i, j + 1)) i++;
    else j++;
  }
  return pairs;
}

function add(ranges: Range[], from: number, to: number) {
  const last = ranges.at(-1);
  if (last && last.to === from) last.to = to;
  else if (to > from) ranges.push({ from, to });
}

function wordsOf(block: Node) {
  const text = block.textBetween(0, block.content.size, undefined, "\ufffc");
  return text.length === block.content.size ? (text.match(/\s+|\S+/g) ?? []) : null;
}

function wordRanges(before: Node, after: Node, at: number) {
  const ranges: Range[] = [];
  const was = wordsOf(before);
  const now = wordsOf(after);
  if (!was || !now) {
    add(ranges, at, at + after.content.size);
    return ranges;
  }
  const kept = new Set(sameItems(was, now, (x, y) => x === y).map(([, j]) => j));
  let pos = at;
  now.forEach((word, j) => {
    const between = /^\s/.test(word) && !kept.has(j - 1) && !kept.has(j + 1);
    if (!kept.has(j) || between) add(ranges, pos, pos + word.length);
    pos += word.length;
  });
  return ranges;
}

function childrenOf(node: Node) {
  const children: { node: Node; offset: number }[] = [];
  node.forEach((child, offset) => children.push({ node: child, offset }));
  return children;
}

function nodeRanges(before: Node, after: Node, at: number) {
  if (before.isTextblock && after.isTextblock) return wordRanges(before, after, at);
  const ranges: Range[] = [];
  const was = childrenOf(before);
  const now = childrenOf(after);
  const pairs = sameItems(was, now, (x, y) => x.node.eq(y.node));
  let i = 0;
  let j = 0;
  for (const [nextI, nextJ] of [...pairs, [was.length, now.length]] as const) {
    for (; j < nextJ; i++, j++) {
      const child = now[j];
      if (child) ranges.push(...childRanges(i < nextI ? was[i]?.node : undefined, child, at));
    }
    i = nextI + 1;
    j = nextJ + 1;
  }
  return ranges;
}

function childRanges(old: Node | undefined, child: { node: Node; offset: number }, at: number) {
  const from = at + child.offset;
  if (old && old.type === child.node.type && !child.node.isLeaf) {
    return nodeRanges(old, child.node, from + 1);
  }
  return [{ from, to: from + child.node.nodeSize }];
}

/**
 * The text a remote change wrote, in the new doc: the blocks it added whole, and the words it
 * added inside the blocks it changed, so text between two edits keeps its own ink.
 */
export function writtenRanges(before: Node, after: Node) {
  return nodeRanges(before, after, 0);
}

function next(tr: Transaction, was: InkState) {
  const meta = tr.getMeta(key) as InkMeta | undefined;
  let inked = was.inked.map(tr.mapping, tr.doc);
  let pending = was.pending.flatMap((range) => {
    const from = tr.mapping.map(range.from, 1);
    const to = tr.mapping.map(range.to, -1);
    return to > from ? [{ from, to }] : [];
  });
  if (tr.docChanged && isChangeOrigin(tr)) pending = writtenRanges(tr.before, tr.doc);
  if (meta && "ink" in meta) {
    const marks = pending.map((range) =>
      Decoration.inline(range.from, range.to, { class: "agent-ink" }, { id: meta.ink }),
    );
    inked = inked.add(tr.doc, marks);
  }
  if (meta && !("dry" in meta)) pending = [];
  if (meta && "dry" in meta) {
    inked = inked.remove(inked.find(undefined, undefined, (spec) => spec.id === meta.dry));
  }
  return { pending, inked } satisfies InkState;
}

/**
 * Text an agent writes into an open doc arrives in the accent blue and settles into the page's
 * ink (`.agent-ink` in `rich-editor.css`). The sync plugin applies a remote change before its
 * live record says who wrote it, so the plugin holds what the change wrote and `useAgentInk`
 * inks it once the record names an agent.
 */
export const AgentInk = Extension.create({
  name: "agentInk",
  addProseMirrorPlugins() {
    return [
      new Plugin<InkState>({
        key,
        state: {
          init: () => ({ pending: [], inked: DecorationSet.empty }),
          apply: next,
        },
        props: {
          decorations: (state) => key.getState(state)?.inked,
        },
      }),
    ];
  },
});

function mark(editor: Editor, meta: InkMeta) {
  if (editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(key, meta).setMeta("addToHistory", false));
}

/**
 * Inks each change an agent's live record brings, and dries it `AGENT_INK_MS` later; a change
 * anyone else's record brings is forgotten.
 */
export function useAgentInk(editor: Editor, doc: LiveDoc | null) {
  useEffect(() => {
    if (!doc) return;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let inks = 0;
    const stop = doc.onUpdate((by) => {
      if (agentOf(by) === undefined) return mark(editor, { forget: true });
      const id = ++inks;
      mark(editor, { ink: id });
      const timer = setTimeout(() => {
        timers.delete(timer);
        mark(editor, { dry: id });
      }, AGENT_INK_MS);
      timers.add(timer);
    });
    return () => {
      stop();
      for (const timer of timers) clearTimeout(timer);
    };
  }, [editor, doc]);
}
