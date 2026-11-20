import { updateYFragment, yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import * as Y from "yjs";
import { docSchema, docToMarkdown, markdownToDoc } from "./markdown.ts";

const FIELD = "default";

/** The Markdown a live document holds now. */
export function liveMarkdown(doc: Y.Doc) {
  return docToMarkdown(yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(FIELD), docSchema()));
}

/**
 * Changes a live document to hold `markdown`, touching only the blocks and words that differ, and
 * answers the change as an update the others merge (so their own edits in the meantime are kept).
 */
export function rewriteLive(doc: Y.Doc, markdown: string) {
  const before = Y.encodeStateVector(doc);
  const next = markdownToDoc(markdown);
  doc.transact(() => {
    updateYFragment(doc, doc.getXmlFragment(FIELD), next, {
      mapping: new Map(),
      isOMark: new Map(),
    });
  });
  return Y.encodeStateAsUpdate(doc, before);
}
