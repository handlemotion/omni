import { Extension } from "@tiptap/core";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import type { Editor } from "@tiptap/react";
import type { Fragment, Node } from "@tiptap/pm/model";
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
const none: Range[] = [];

function blocksIn(fragment: Fragment, from: number, to: number) {
  const blocks: { node: Node; at: number }[] = [];
  fragment.forEach((node, at) => {
    if (at >= from && at + node.nodeSize <= to) blocks.push({ node, at });
  });
  return blocks;
}

/**
 * The text a remote change wrote, in the new doc: the span between the first and last positions
 * that differ, less the whole blocks in it that were there before unchanged (an update that
 * touches two far-apart paragraphs doesn't ink everything between them).
 */
export function writtenRanges(before: Node, after: Node) {
  const from = after.content.findDiffStart(before.content);
  if (from === null) return none;
  const end = after.content.findDiffEnd(before.content);
  if (!end) return none;
  const overlap = from - Math.min(end.a, end.b);
  if (overlap > 0) {
    end.a += overlap;
    end.b += overlap;
  }
  if (end.a <= from) return none;
  const kept = blocksIn(before.content, from, end.b).map((each) => each.node);
  const ranges = [...none];
  let at = from;
  for (const block of blocksIn(after.content, from, end.a)) {
    const twin = kept.findIndex((node) => node.eq(block.node));
    if (twin === -1) continue;
    kept.splice(twin, 1);
    if (block.at > at) ranges.push({ from: at, to: block.at });
    at = block.at + block.node.nodeSize;
  }
  if (end.a > at) ranges.push({ from: at, to: end.a });
  return ranges;
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
