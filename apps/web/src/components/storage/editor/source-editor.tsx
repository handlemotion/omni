import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { Compartment, EditorState } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { useEffect, useRef } from "react";
import type { EditorProps } from "./document-editor.tsx";

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", color: "var(--foreground)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    lineHeight: "20px",
    overscrollBehavior: "contain",
  },
  ".cm-content": { padding: "16px 0", caretColor: "var(--foreground)" },
  ".cm-line": { padding: "0 20px 0 0" },
  ".cm-gutters": {
    backgroundColor: "var(--background)",
    color: "var(--subtle-foreground)",
    border: "none",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 16px 0 20px" },
  ".cm-activeLine": { backgroundColor: "var(--secondary)" },
});

const label = new Compartment();
const writable = new Compartment();

const editableAs = (editable: boolean) => [
  EditorState.readOnly.of(!editable),
  EditorView.editable.of(editable),
];

export default function SourceEditor(props: EditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const { onReady, onChange, name, text } = props;
  const editable = props.editable ?? true;
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
  const view = useRef<EditorView | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const made = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          EditorState.tabSize.of(2),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          label.of(EditorView.contentAttributes.of({ "aria-label": name })),
          writable.of(editableAs(editable)),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current();
          }),
          theme,
        ],
      }),
    });
    made.focus();
    onReady(() => made.state.doc.toString());
    view.current = made;
    return () => {
      view.current = null;
      made.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, onReady]);
  useEffect(() => {
    view.current?.dispatch({ effects: writable.reconfigure(editableAs(editable)) });
  }, [editable]);
  useEffect(() => {
    view.current?.dispatch({
      effects: label.reconfigure(EditorView.contentAttributes.of({ "aria-label": name })),
    });
  }, [name]);
  return <div ref={host} className="min-h-0 flex-1" />;
}
