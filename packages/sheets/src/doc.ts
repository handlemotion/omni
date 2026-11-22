import * as Y from "yjs";
import type { Column, FileCell, Frozen, Scalar, SheetFile, View } from "./format.ts";
import { isFormula } from "./format.ts";
import { toA1, toLive, type Layout } from "./formula/translate.ts";
import { byPosition, positionsBetween } from "./ids.ts";

/** A cell in the live document: a value, or a formula with its references by id. */
export type LiveCell = Scalar | { f: string };

export interface GridColumn extends Column {
  p: string;
}

export interface GridRow {
  id: string;
  p: string;
  cells: Map<string, LiveCell>;
}

export interface GridView extends View {
  p: string;
}

export interface GridTab {
  id: string;
  name: string;
  p: string;
  frozen: Frozen;
  columns: GridColumn[];
  rows: GridRow[];
  views: GridView[];
  rowAt: Map<string, number>;
  colAt: Map<string, number>;
}

/** A sheet's live document read in order: what edits, evaluation and saving work from. */
export interface Grid {
  tabs: GridTab[];
  byId: Map<string, GridTab>;
}

const ROW_FIELDS = new Set(["tab", "p"]);

/** The four maps of a sheet's live document (`docs/spec/sheets.md`, "The live document"). */
export const sheetMaps = (doc: Y.Doc) => ({
  tabs: doc.getMap<Y.Map<unknown>>("tabs"),
  cols: doc.getMap<Y.Map<unknown>>("cols"),
  rows: doc.getMap<Y.Map<unknown>>("rows"),
  views: doc.getMap<Y.Map<unknown>>("views"),
});

function readColumn(id: string, map: Y.Map<unknown>) {
  const column: GridColumn = { id, p: String(map.get("p") ?? "") };
  for (const key of ["width", "type", "format", "options", "time"] as const) {
    const value = map.get(key);
    if (value !== undefined && value !== null)
      (column as unknown as Record<string, unknown>)[key] = value;
  }
  return column;
}

function readView(id: string, map: Y.Map<unknown>) {
  const view: GridView = { id, p: String(map.get("p") ?? ""), name: String(map.get("name") ?? "") };
  for (const key of ["filter", "sort", "hidden"] as const) {
    const value = map.get(key);
    if (Array.isArray(value)) (view as unknown as Record<string, unknown>)[key] = value;
  }
  return view;
}

function emptyTab(id: string, map: Y.Map<unknown>) {
  return {
    id,
    name: String(map.get("name") ?? "Sheet"),
    p: String(map.get("p") ?? ""),
    frozen: { rows: Number(map.get("frozenRows") ?? 0), cols: Number(map.get("frozenCols") ?? 0) },
    columns: [],
    rows: [],
    views: [],
    rowAt: new Map(),
    colAt: new Map(),
  };
}

/** Reads the live document in order. Columns and cells of deleted tabs or columns are left out. */
export function readGrid(doc: Y.Doc) {
  const maps = sheetMaps(doc);
  const byId = new Map<string, GridTab>();
  maps.tabs.forEach((map, id) => byId.set(id, emptyTab(id, map)));
  maps.cols.forEach((map, id) =>
    byId.get(String(map.get("tab")))?.columns.push(readColumn(id, map)),
  );
  maps.views.forEach((map, id) => byId.get(String(map.get("tab")))?.views.push(readView(id, map)));
  maps.rows.forEach((map, id) => {
    const tab = byId.get(String(map.get("tab")));
    if (!tab) return;
    const cells = new Map<string, LiveCell>();
    map.forEach((value, key) => {
      if (!ROW_FIELDS.has(key)) cells.set(key, value as LiveCell);
    });
    tab.rows.push({ id, p: String(map.get("p") ?? ""), cells });
  });
  const tabs = [...byId.values()].sort(byPosition);
  for (const tab of tabs) {
    tab.columns.sort(byPosition);
    tab.rows.sort(byPosition);
    tab.views.sort(byPosition);
    tab.colAt = new Map(tab.columns.map((c, i) => [c.id, i]));
    tab.rowAt = new Map(tab.rows.map((r, i) => [r.id, i]));
    for (const row of tab.rows) {
      for (const key of row.cells.keys()) if (!tab.colAt.has(key)) row.cells.delete(key);
    }
  }
  return { tabs, byId };
}

/** The layout formulas are written against, from a grid. */
export const gridLayout = (grid: Grid) => ({
  tabs: grid.tabs.map((tab) => ({
    id: tab.id,
    name: tab.name,
    rowIds: tab.rows.map((r) => r.id),
    colIds: tab.columns.map((c) => c.id),
  })),
});

const fileLayout = (file: SheetFile) => ({
  tabs: file.tabs.map((tab) => ({
    id: tab.id,
    name: tab.name,
    rowIds: tab.rows.map((r) => r.id),
    colIds: tab.columns.map((c) => c.id),
  })),
});

/** A cell as the live document holds it, from the file's. */
export function liveCell(cell: FileCell, layout: Layout, tabId: string) {
  return isFormula(cell) ? { f: toLive(cell.f, layout, tabId) } : cell;
}

function fieldMap(entries: Record<string, unknown>) {
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(entries)) if (value !== undefined) map.set(key, value);
  return map;
}

/** Fills an empty live document from a sheet's file: the start of a new epoch. */
export function fillDoc(doc: Y.Doc, file: SheetFile) {
  const maps = sheetMaps(doc);
  const layout = fileLayout(file);
  doc.transact(() => {
    const tabKeys = positionsBetween(null, null, file.tabs.length);
    file.tabs.forEach((tab, t) => {
      maps.tabs.set(
        tab.id,
        fieldMap({
          name: tab.name,
          p: tabKeys[t],
          frozenRows: tab.frozen?.rows,
          frozenCols: tab.frozen?.cols,
        }),
      );
      const colKeys = positionsBetween(null, null, tab.columns.length);
      tab.columns.forEach(({ id, ...column }, c) =>
        maps.cols.set(id, fieldMap({ ...column, tab: tab.id, p: colKeys[c] })),
      );
      const viewKeys = positionsBetween(null, null, tab.views?.length ?? 0);
      tab.views?.forEach(({ id, ...view }, v) =>
        maps.views.set(id, fieldMap({ ...view, tab: tab.id, p: viewKeys[v] })),
      );
      const rowKeys = positionsBetween(null, null, tab.rows.length);
      tab.rows.forEach((row, r) => {
        const map = fieldMap({ tab: tab.id, p: rowKeys[r] });
        for (const [col, cell] of Object.entries(row.cells))
          map.set(col, liveCell(cell, layout, tab.id));
        maps.rows.set(row.id, map);
      });
    });
  });
}

/** A live document of `file`. */
export function sheetDoc(file: SheetFile) {
  const doc = new Y.Doc();
  fillDoc(doc, file);
  return doc;
}

/** What a formula cell computed: its value, or its error's code. */
export type Computed = { v: Scalar | null } | { e: string };

/** The file of a grid, formulas back in A1 with the values `computed` gives them. */
export function gridToFile(
  grid: Grid,
  computed?: (rowId: string, colId: string) => Computed | undefined,
) {
  const layout = gridLayout(grid);
  const file: SheetFile = {
    tabs: grid.tabs.map((tab) => ({
      id: tab.id,
      name: tab.name,
      ...(tab.frozen.rows || tab.frozen.cols ? { frozen: { ...tab.frozen } } : {}),
      columns: tab.columns.map(({ p: _p, ...column }) => column),
      ...(tab.views.length ? { views: tab.views.map(({ p: _p, ...view }) => view) } : {}),
      rows: tab.rows.map((row) => {
        const cells: Record<string, FileCell> = {};
        for (const { id: col } of tab.columns) {
          const cell = row.cells.get(col);
          if (cell === undefined || cell === "") continue;
          cells[col] = isFormula(cell)
            ? { f: toA1(cell.f, layout, tab.id), ...computed?.(row.id, col) }
            : cell;
        }
        return { id: row.id, cells };
      }),
    })),
  };
  return file;
}

function fnv(text: string, seed: number) {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * A token that changes whenever rows or columns are inserted, deleted or reordered: a hash of
 * every tab's ordered row and column ids, from the merged document as it is now.
 */
export function layoutToken(grid: Grid) {
  const text = grid.tabs
    .map(
      (tab) =>
        `${tab.id}:${tab.columns.map((c) => c.id).join(",")}:${tab.rows.map((r) => r.id).join(",")}`,
    )
    .join(";");
  return fnv(text, 0x811c9dc5) + fnv(text, 0x01234567);
}
