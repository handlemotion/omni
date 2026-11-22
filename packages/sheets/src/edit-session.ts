import * as Y from "yjs";
import { columnLetters, parseArea } from "./a1.ts";
import { gridLayout, readGrid, sheetMaps, type Grid, type GridTab, type LiveCell } from "./doc.ts";
import { isFormula, SHEET_LIMITS } from "./format.ts";
import { toA1, toLive } from "./formula/translate.ts";
import { byPosition, newId, positionBetween, positionsBetween } from "./ids.ts";

export class EditError extends Error {}

export const fail = (message: string): never => {
  throw new EditError(message);
};

const POSITIONAL = /[[|!]\$?#\d/;

/** What an edit names a value with: `=` starts a formula, `'=` is text that starts with `=`. */
export type InputValue = string | number | boolean | null;

/** A live document under edit: the grid read from it, read again after a change to its layout. */
export class EditSession {
  readonly doc: Y.Doc;
  readonly maps: ReturnType<typeof sheetMaps>;
  private readonly written: { tab: string; rows: string[]; cols: string[] }[] = [];
  cells = 0;
  private cached: Grid | null = null;
  private grew = false;

  constructor(doc: Y.Doc) {
    this.doc = doc;
    this.maps = sheetMaps(doc);
  }

  get grid() {
    this.cached ??= readGrid(this.doc);
    return this.cached;
  }

  /** The layout changed: rows, columns or tabs were added, removed or moved. */
  relayout() {
    this.cached = null;
  }

  /** The tab an edit names (by name, any case), the first tab by default; one is made if none. */
  tab(name?: string) {
    const { tabs } = this.grid;
    if (name === undefined) return tabs[0] ?? this.addTab("Sheet 1");
    const lower = name.toLowerCase();
    return (
      tabs.find((t) => t.name.toLowerCase() === lower) ?? fail(`there is no tab named ${name}`)
    );
  }

  addTab(name: string) {
    const { tabs } = this.grid;
    if (tabs.some((t) => t.name.toLowerCase() === name.toLowerCase()))
      fail(`a tab named ${name} exists`);
    if (tabs.length >= SHEET_LIMITS.tabs) fail(`a sheet has at most ${SHEET_LIMITS.tabs} tabs`);
    const id = newId("t", this.maps.tabs);
    const map = new Y.Map<unknown>();
    map.set("name", name);
    map.set("p", positionBetween(tabs.at(-1)?.p ?? null, null));
    this.maps.tabs.set(id, map);
    this.relayout();
    return this.grid.byId.get(id)!;
  }

  area(text: string) {
    return parseArea(text) ?? fail(`${text} is not a cell or a range`);
  }

  /** Makes sure the tab has `rows` rows and `cols` columns, adding empty ones at the end. */
  ensure(tab: GridTab, rows: number, cols: number) {
    if (rows > SHEET_LIMITS.rows) fail(`a tab has at most ${SHEET_LIMITS.rows} rows`);
    if (cols > SHEET_LIMITS.columns) fail(`a tab has at most ${SHEET_LIMITS.columns} columns`);
    const addRows = rows - tab.rows.length;
    const addCols = cols - tab.columns.length;
    if (addRows > 0) this.insertRows(tab, tab.rows.length, addRows);
    if (addCols > 0) this.insertCols(tab, tab.columns.length, addCols);
    return this.grid.byId.get(tab.id)!;
  }

  private rekeyTies(list: { id: string; p: string }[], index: number, map: Y.Map<Y.Map<unknown>>) {
    const tied = list[index - 1]!.p;
    let start = index - 1;
    while (start > 0 && list[start - 1]!.p === tied) start--;
    let end = index;
    while (end < list.length && list[end]!.p === tied) end++;
    const run = list.slice(start, end);
    const keys = positionsBetween(list[start - 1]?.p ?? null, list[end]?.p ?? null, run.length);
    run.forEach((item, i) => {
      map.get(item.id)?.set("p", keys[i]);
      item.p = keys[i]!;
    });
  }

  private keysAt(
    list: { id: string; p: string }[],
    index: number,
    count: number,
    map: Y.Map<Y.Map<unknown>>,
  ) {
    const tiedBefore = list[index - 1]?.p;
    const tiedAfter = list[index]?.p;
    if (tiedBefore !== undefined && tiedAfter !== undefined && tiedBefore >= tiedAfter) {
      this.rekeyTies(list, index, map);
    }
    const before = list[index - 1]?.p ?? null;
    const after = list[index]?.p ?? null;
    return count === 1 ? [positionBetween(before, after)] : positionsBetween(before, after, count);
  }

  insertRows(tab: GridTab, index: number, count: number) {
    if (tab.rows.length + count > SHEET_LIMITS.rows)
      fail(`a tab has at most ${SHEET_LIMITS.rows} rows`);
    const keys = this.keysAt(tab.rows, index, count, this.maps.rows);
    const ids: string[] = [];
    for (const p of keys) {
      const id = newId("r", this.maps.rows);
      const map = new Y.Map<unknown>();
      map.set("tab", tab.id);
      map.set("p", p);
      this.maps.rows.set(id, map);
      ids.push(id);
    }
    this.grew = true;
    this.relayout();
    return ids;
  }

  insertCols(tab: GridTab, index: number, count: number) {
    if (tab.columns.length + count > SHEET_LIMITS.columns)
      fail(`a tab has at most ${SHEET_LIMITS.columns} columns`);
    const keys = this.keysAt(tab.columns, index, count, this.maps.cols);
    for (const p of keys) {
      const map = new Y.Map<unknown>();
      map.set("tab", tab.id);
      map.set("p", p);
      this.maps.cols.set(newId("c", this.maps.cols), map);
    }
    this.grew = true;
    this.relayout();
  }

  /** Sets one cell; null or empty clears it. */
  setCell(tab: GridTab, row: number, col: number, cell: LiveCell | null) {
    if (++this.cells > SHEET_LIMITS.cellsPerCall)
      fail(`an edit changes at most ${SHEET_LIMITS.cellsPerCall} cells`);
    const rowId = tab.rows[row]!.id;
    const colId = tab.columns[col]!.id;
    const map = this.maps.rows.get(rowId)!;
    const cached = tab.rows[row]!.cells;
    if (cell === null || cell === "") {
      map.delete(colId);
      cached.delete(colId);
    } else {
      map.set(colId, cell);
      cached.set(colId, cell);
    }
  }

  /**
   * Binds references past a tab's last row or column to the rows and columns now there, once
   * the tab grew, so later edits move them with their cells.
   */
  bindPositional() {
    if (!this.grew) return;
    this.grew = false;
    const layout = gridLayout(this.grid);
    for (const tab of this.grid.tabs) {
      for (const row of tab.rows) {
        for (const [colId, cell] of row.cells) {
          if (!isFormula(cell) || !POSITIONAL.test(cell.f)) continue;
          const f = toLive(toA1(cell.f, layout, tab.id), layout, tab.id);
          if (f === cell.f) continue;
          this.maps.rows.get(row.id)!.set(colId, { f });
          row.cells.set(colId, { f });
        }
      }
    }
  }

  /** Records a changed range by the ids of its tab, rows and columns, which later edits keep. */
  record(tab: GridTab, row0: number, col0: number, row1 = row0, col1 = col0) {
    const ids = (list: { id: string }[], from: number, to: number) =>
      list.slice(from, to + 1).map((item) => item.id);
    this.written.push({
      tab: tab.id,
      rows: ids(tab.rows, row0, row1),
      cols: ids(tab.columns, col0, col1),
    });
  }

  /**
   * The changed ranges, as `Tab!A1:B2`, where they sit once every edit has applied: after rows
   * or columns moved, tabs were renamed, or what was written was deleted again.
   */
  changed() {
    const grid = readGrid(this.doc);
    const span = (ids: string[], at: Map<string, number>) => {
      const found = ids.flatMap((id) => at.get(id) ?? []);
      return found.length ? [Math.min(...found), Math.max(...found)] : null;
    };
    return this.written.flatMap((range) => {
      const tab = grid.byId.get(range.tab);
      const rows = tab && span(range.rows, tab.rowAt);
      const cols = tab && span(range.cols, tab.colAt);
      if (!tab || !rows || !cols) return [];
      const a = `${columnLetters(cols[0]!)}${rows[0]! + 1}`;
      const b = `${columnLetters(cols[1]!)}${rows[1]! + 1}`;
      return [`${tab.name}!${a === b ? a : `${a}:${b}`}`];
    });
  }

  /** Gives rows in `order` the keys the same rows hold now, sorted, so the rows take that order. */
  reorder(tab: GridTab, rows: { id: string; p: string }[]) {
    const keys = rows.map((r) => r.p).toSorted();
    const distinct = new Set(keys).size === keys.length;
    const first = tab.rowAt.get(rows.toSorted(byPosition)[0]!.id)!;
    const fresh = distinct
      ? keys
      : positionsBetween(
          tab.rows[first - 1]?.p ?? null,
          tab.rows[first + rows.length]?.p ?? null,
          rows.length,
        );
    rows.forEach((row, i) => this.maps.rows.get(row.id)?.set("p", fresh[i]));
    this.relayout();
  }
}
