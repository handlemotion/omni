import type { Editor } from "@tiptap/react";
import { useEffect, useMemo, useRef } from "react";
import type { DocComments } from "@/hooks/use-doc-comments.ts";
import {
  DocComments as DocCommentsExtension,
  showThreads,
  textAnchorOf,
  threadRange,
} from "./doc-comments.ts";

/** The comments extension for a page, tied to its panel through `comments`. */
export function useCommentsExtension(comments: DocComments | null) {
  const latest = useRef(comments);
  useEffect(() => {
    latest.current = comments;
  });
  const on = !!comments;
  return useMemo(
    () =>
      on ? [DocCommentsExtension.configure({ onPick: (id) => latest.current?.pick(id) })] : [],
    [on],
  );
}

/** Keeps the doc's marks on its threads, and brings the picked one into view. */
export function useCommentMarks(editor: Editor, comments: DocComments | null) {
  const marked = comments?.marked;
  const active = comments?.pending ? "pending" : (comments?.active ?? null);
  useEffect(() => {
    if (!marked || editor.isDestroyed) return;
    showThreads(editor.view, marked, active);
  }, [editor, marked, active]);
  useEffect(() => {
    if (!active || active === "pending" || editor.isDestroyed) return;
    const range = threadRange(editor.state, active);
    if (!range) return;
    const { node } = editor.view.domAtPos(range.from);
    const element = node instanceof Element ? node : node.parentElement;
    element?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [editor, active]);
}

/** Starts a comment on the selected text. */
export function commentOnSelection(editor: Editor, comments: DocComments) {
  const { from, to } = editor.state.selection;
  const anchor = textAnchorOf(editor.state.doc, from, to);
  if (anchor) comments.start(anchor);
}
