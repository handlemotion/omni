import type * as Y from "yjs";
import { gridToFile, readGrid, sheetDoc, type Computed, type Grid } from "./doc.ts";
import {
  isFormula,
  serializeSheet,
  type FileFormula,
  type Scalar,
  type SheetFile,
} from "./format.ts";
import { cellKey, evaluateGrid } from "./formula/evaluate.ts";
import { isError, serialOf, SheetError, type Value } from "./formula/values.ts";

/** Now as a formula's serial number. */
export const nowSerial = (ms = Date.now()) => serialOf(ms);

export const computedOf = (value: Value | undefined) => {
  if (value === undefined) return undefined;
  if (isError(value)) return { e: value.code } satisfies Computed;
  return {
    v: typeof value === "number" ? Number(value.toPrecision(15)) : (value as Scalar | null),
  } satisfies Computed;
};

/** A grid with its formulas evaluated: what is shown, indexed and saved. */
export interface Evaluated {
  grid: Grid;
  values: Map<string, Value>;
}

export function evaluateDoc(doc: Y.Doc, now = nowSerial()) {
  const grid = readGrid(doc);
  return { grid, values: evaluateGrid(grid, now) };
}

/** The file of a live document, values computed: what saving writes. */
export function saveSheet(doc: Y.Doc, now = nowSerial()) {
  const evaluated = evaluateDoc(doc, now);
  const file = gridToFile(evaluated.grid, (row, col) =>
    computedOf(evaluated.values.get(cellKey(row, col))),
  );
  return { ...evaluated, file, text: serializeSheet(file) };
}

/** A sheet as its file saved it: formulas show the values the file holds, not ones computed now. */
export function savedEvaluated(file: SheetFile) {
  const grid = readGrid(sheetDoc(file));
  const values = new Map<string, Value>();
  for (const tab of file.tabs) {
    for (const row of tab.rows) {
      for (const [col, cell] of Object.entries(row.cells)) {
        if (!isFormula(cell)) continue;
        const { v, e } = cell as FileFormula;
        values.set(cellKey(row.id, col), e ? new SheetError(e) : (v ?? null));
      }
    }
  }
  return { grid, values } satisfies Evaluated;
}
