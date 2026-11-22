import * as Y from "yjs";
import { applySheetEdits, type SheetEdit } from "./edits.ts";
import { createSheetFile, type TabInput } from "./create.ts";
import { sheetDoc } from "./doc.ts";
import { agentText } from "./render.ts";
import { evaluateDoc, saveSheet } from "./save.ts";

export const NOW = 46_348;

export const docOf = (...tabs: TabInput[]) => sheetDoc(createSheetFile(tabs));

/** Applies edits, failing the test when they are refused. */
export function edit(doc: Y.Doc, ...edits: SheetEdit[]) {
  const outcome = applySheetEdits(doc, edits, NOW);
  if (!outcome.ok) throw new Error(outcome.error);
  return outcome;
}

/** A second peer holding the same document. */
export function peer(doc: Y.Doc) {
  const other = new Y.Doc();
  Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
  return other;
}

/** Brings two peers level, each taking what the other has. */
export function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
}

/** Each tab's shown values, row by row. */
export function values(doc: Y.Doc) {
  const { grid, values: computed } = evaluateDoc(doc, NOW);
  return grid.tabs.map((tab) =>
    tab.rows.map((row) =>
      tab.columns.map((column) => {
        const cell = row.cells.get(column.id);
        if (typeof cell === "object") return computed.get(`${row.id}|${column.id}`);
        return cell ?? null;
      }),
    ),
  );
}

export const firstTab = (doc: Y.Doc) => values(doc)[0]!;
export const text = (doc: Y.Doc) => agentText(evaluateDoc(doc, NOW));
export const saved = (doc: Y.Doc) => saveSheet(doc, NOW);
