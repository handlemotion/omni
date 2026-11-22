import * as Y from "yjs";
import { columnIndex, columnLetters, type Area } from "./a1.ts";
import { gridLayout, type GridTab, type LiveCell } from "./doc.ts";
import { EditError, EditSession, fail, type InputValue } from "./edit-session.ts";
import {
  isFormula,
  limitProblem,
  SHEET_LIMITS,
  type ColumnType,
  type Filter,
  type FilterOp,
  type NumberFormat,
} from "./format.ts";
import { evaluateGrid, cellKey, scalarValue } from "./formula/evaluate.ts";
import { shiftA1, toA1, toLive } from "./formula/translate.ts";
import { compare, isError } from "./formula/values.ts";
import { newId, positionBetween } from "./ids.ts";
import { structureEdit } from "./edits-structure.ts";
import { saveSheet } from "./save.ts";

type OnTab = { tab?: string };

/** One change to a sheet, addressed in A1 (`docs/spec/sheets.md`, "Agents"). */
export type SheetEdit =
  | (OnTab & { set: string; value?: InputValue; values?: InputValue[][] })
  | (OnTab & { clear: string })
  | (OnTab & { append: InputValue[][] })
  | (OnTab & { insert_rows: { before?: number; after?: number; count?: number } })
  | (OnTab & { delete_rows: string })
  | (OnTab & { insert_columns: { before?: string; after?: string; count?: number } })
  | (OnTab & { delete_columns: string })
  | (OnTab & {
      column: string;
      type?: ColumnType;
      format?: NumberFormat;
      options?: string[];
      width?: number;
      time?: boolean;
    })
  | (OnTab & { fill_down: string })
  | (OnTab & { sort: { range?: string; by: { column: string; desc?: boolean }[] } })
  | { add_tab: string }
  | (OnTab & { rename_tab: string })
  | { delete_tab: string }
  | (OnTab & { freeze: { rows?: number; cols?: number } })
  | (OnTab & {
      view: {
        name: string;
        filter?: { column: string; op: FilterOp; value?: Filter["value"] }[];
        sort?: { column: string; desc?: boolean }[];
        hidden?: string[];
      };
    });

export type EditOutcome =
  | { ok: true; changed: string[]; update: Uint8Array }
  | { ok: false; error: string };

/** An edit's value as the live document holds it. */
export function inputCell(value: InputValue, session: EditSession, tab: GridTab) {
  if (value === null || value === "") return null;
  if (typeof value === "number" && !Number.isFinite(value)) fail("a number must be finite");
  if (typeof value !== "string") return value;
  if (value.length > SHEET_LIMITS.cellChars)
    fail(`a cell holds at most ${SHEET_LIMITS.cellChars} characters`);
  if (value.startsWith("'")) return value.slice(1);
  if (value.startsWith("=")) return { f: toLive(value, gridLayout(session.grid), tab.id) };
  return value;
}

function bounded(area: Area, what: string) {
  if (area.row0 === null || area.col0 === null)
    fail(`${what} needs cells, not whole rows or columns`);
  return { row0: area.row0!, col0: area.col0!, row1: area.row1!, col1: area.col1! };
}

function setRange(
  session: EditSession,
  edit: OnTab & { set: string; value?: InputValue; values?: InputValue[][] },
) {
  let tab = session.tab(edit.tab);
  const { row0, col0, row1, col1 } = bounded(session.area(edit.set), "set");
  const values =
    edit.values ?? (edit.value === undefined ? fail("set needs value or values") : null);
  const height = values ? values.length : row1 - row0 + 1;
  const width = values ? Math.max(0, ...values.map((r) => r.length)) : col1 - col0 + 1;
  if (values && edit.set.includes(":") && (height !== row1 - row0 + 1 || width > col1 - col0 + 1)) {
    fail(`values are ${height}×${width}, but ${edit.set} is ${row1 - row0 + 1}×${col1 - col0 + 1}`);
  }
  tab = session.ensure(tab, row0 + height, col0 + Math.max(width, 1));
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const value = values ? (values[r]?.[c] ?? null) : edit.value!;
      session.setCell(tab, row0 + r, col0 + c, inputCell(value, session, tab));
    }
  }
  session.record(tab, row0, col0, row0 + height - 1, col0 + Math.max(width, 1) - 1);
}

function clear(session: EditSession, edit: OnTab & { clear: string }) {
  const tab = session.tab(edit.tab);
  const area = session.area(edit.clear);
  const r1 = Math.min(area.row1 ?? tab.rows.length - 1, tab.rows.length - 1);
  const c1 = Math.min(area.col1 ?? tab.columns.length - 1, tab.columns.length - 1);
  for (let r = area.row0 ?? 0; r <= r1; r++) {
    for (let c = area.col0 ?? 0; c <= c1; c++) {
      if (tab.rows[r]!.cells.has(tab.columns[c]!.id)) session.setCell(tab, r, c, null);
    }
  }
  session.record(tab, area.row0 ?? 0, area.col0 ?? 0, Math.max(r1, 0), Math.max(c1, 0));
}

function lastUsedRow(tab: GridTab) {
  for (let r = tab.rows.length - 1; r >= 0; r--) if (tab.rows[r]!.cells.size) return r;
  return -1;
}

function append(session: EditSession, edit: OnTab & { append: InputValue[][] }) {
  const tab = session.tab(edit.tab);
  if (!edit.append.length) return;
  const row0 = lastUsedRow(tab) + 1;
  const range = `${columnLetters(0)}${row0 + 1}`;
  setRange(session, { set: range, values: edit.append, ...(edit.tab ? { tab: edit.tab } : {}) });
}

function fillDown(session: EditSession, edit: OnTab & { fill_down: string }) {
  const tab = session.tab(edit.tab);
  const { row0, col0, row1, col1 } = bounded(session.area(edit.fill_down), "fill_down");
  const filled = session.ensure(tab, row1 + 1, col1 + 1);
  const layout = gridLayout(session.grid);
  for (let c = col0; c <= col1; c++) {
    const source = filled.rows[row0]!.cells.get(filled.columns[c]!.id);
    for (let r = row0 + 1; r <= row1; r++) {
      if (source === undefined) {
        session.setCell(filled, r, c, null);
        continue;
      }
      const cell: LiveCell = isFormula(source)
        ? { f: toLive(shiftA1(toA1(source.f, layout, tab.id), r - row0, 0), layout, tab.id) }
        : source;
      session.setCell(filled, r, c, cell);
    }
  }
  session.record(filled, row0, col0, row1, col1);
}

function column(session: EditSession, edit: Extract<SheetEdit, { column: string }>) {
  const index = columnIndex(edit.column) ?? fail(`${edit.column} is not a column`);
  const tab = session.ensure(session.tab(edit.tab), 0, index + 1);
  const map = session.maps.cols.get(tab.columns[index]!.id)!;
  for (const field of ["type", "format", "options", "width", "time"] as const) {
    if (edit[field] !== undefined) map.set(field, edit[field]);
  }
  session.relayout();
}

function sortRows(session: EditSession, edit: Extract<SheetEdit, { sort: unknown }>, now: number) {
  const tab = session.tab(edit.tab);
  const area = edit.sort.range ? session.area(edit.sort.range) : null;
  const r0 = area?.row0 ?? tab.frozen.rows;
  const r1 = Math.min(area?.row1 ?? tab.rows.length - 1, tab.rows.length - 1);
  if (r1 <= r0) return;
  const by = edit.sort.by.map((b) => ({
    col: columnIndex(b.column) ?? fail(`${b.column} is not a column`),
    desc: !!b.desc,
  }));
  const values = evaluateGrid(session.grid, now);
  const valueAt = (r: number, c: number) => {
    const row = tab.rows[r]!;
    const colId = tab.columns[c]?.id;
    if (!colId) return null;
    const cell = row.cells.get(colId);
    return isFormula(cell)
      ? (values.get(cellKey(row.id, colId)) ?? null)
      : scalarValue(tab, cell, c);
  };
  const indices = Array.from({ length: r1 - r0 + 1 }, (_, i) => r0 + i);
  indices.sort((a, b) => {
    for (const { col, desc } of by) {
      const x = valueAt(a, col);
      const y = valueAt(b, col);
      if (x === null || y === null || isError(x) || isError(y)) {
        const blankX = x === null || isError(x);
        const blankY = y === null || isError(y);
        if (blankX !== blankY) return blankX ? 1 : -1;
        continue;
      }
      const c = compare(x, y);
      if (c) return desc ? -c : c;
    }
    return a - b;
  });
  session.reorder(
    tab,
    indices.map((i) => tab.rows[i]!),
  );
  session.record(tab, r0, 0, r1, Math.max(tab.columns.length - 1, 0));
}

function view(session: EditSession, edit: Extract<SheetEdit, { view: unknown }>) {
  const tab = session.tab(edit.tab);
  const colId = (letters: string) => {
    const i = columnIndex(letters) ?? fail(`${letters} is not a column`);
    return tab.columns[i]?.id ?? fail(`column ${letters} is empty`);
  };
  const existing = tab.views.find((v) => v.name.toLowerCase() === edit.view.name.toLowerCase());
  const id = existing?.id ?? newId("v", session.maps.views);
  const map = session.maps.views.get(id) ?? new Y.Map<unknown>();
  if (!existing) {
    map.set("tab", tab.id);
    map.set("p", positionBetween(tab.views.at(-1)?.p ?? null, null));
  }
  map.set("name", edit.view.name);
  map.set(
    "filter",
    (edit.view.filter ?? []).map((f) => ({
      col: colId(f.column),
      op: f.op,
      ...(f.value === undefined ? {} : { value: f.value }),
    })),
  );
  map.set(
    "sort",
    (edit.view.sort ?? []).map((s) => ({ col: colId(s.column), dir: s.desc ? "desc" : "asc" })),
  );
  map.set("hidden", (edit.view.hidden ?? []).map(colId));
  if (!existing) session.maps.views.set(id, map);
  session.relayout();
}

function applyOne(session: EditSession, edit: SheetEdit, now: number) {
  if ("set" in edit) return setRange(session, edit);
  if ("clear" in edit) return clear(session, edit);
  if ("append" in edit) return append(session, edit);
  if ("fill_down" in edit) return fillDown(session, edit);
  if ("column" in edit) return column(session, edit);
  if ("sort" in edit) return sortRows(session, edit, now);
  if ("view" in edit) return view(session, edit);
  if (!structureEdit(session, edit))
    fail(`edit ${JSON.stringify(Object.keys(edit))} is not one this tool knows`);
}

/**
 * Applies `edits` in order to a copy of `doc`; when all of them apply, merges the change into
 * `doc` and answers it as one update for the others. All of them or none.
 */
export function applySheetEdits(doc: Y.Doc, edits: SheetEdit[], now: number) {
  if (edits.length > SHEET_LIMITS.editsPerCall) {
    return { ok: false, error: `at most ${SHEET_LIMITS.editsPerCall} edits a call` };
  }
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  const before = Y.encodeStateVector(doc);
  const session = new EditSession(copy);
  for (const [index, edit] of edits.entries()) {
    try {
      copy.transact(() => {
        applyOne(session, edit, now);
        session.bindPositional();
      });
    } catch (error) {
      if (error instanceof EditError)
        return { ok: false, error: `Edit ${index + 1}: ${error.message}` };
      throw error;
    }
  }
  const problem = limitProblem(saveSheet(copy, now).file);
  if (problem) return { ok: false, error: `The sheet would have ${problem}.` };
  const update = Y.encodeStateAsUpdate(copy, before);
  Y.applyUpdate(doc, update);
  return { ok: true, changed: session.changed(), update };
}
