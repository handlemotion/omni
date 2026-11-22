import { columnIndex } from "./a1.ts";
import type { GridTab } from "./doc.ts";
import { fail, type EditSession } from "./edit-session.ts";
import type { SheetEdit } from "./edits.ts";

function rowsOf(session: EditSession, tab: GridTab, text: string) {
  const area = session.area(text);
  if (area.row0 === null || area.col0 !== null) fail(`${text} is not rows (like 5 or 5:7)`);
  return { from: area.row0!, to: Math.min(area.row1!, tab.rows.length - 1) };
}

function colsOf(session: EditSession, tab: GridTab, text: string) {
  const area = session.area(text);
  if (area.col0 === null || area.row0 !== null) fail(`${text} is not columns (like C or C:D)`);
  return { from: area.col0!, to: Math.min(area.col1!, tab.columns.length - 1) };
}

function insertRows(
  session: EditSession,
  tab: GridTab,
  at: { before?: number; after?: number; count?: number },
) {
  const count = at.count ?? 1;
  if (count < 1) fail("count must be at least 1");
  const row =
    at.before ??
    (at.after === undefined ? fail("insert_rows needs before or after") : at.after + 1);
  if (row < 1) fail("rows start at 1");
  const ready = session.ensure(tab, row - 1, 0);
  session.insertRows(ready, row - 1, count);
}

function insertCols(
  session: EditSession,
  tab: GridTab,
  at: { before?: string; after?: string; count?: number },
) {
  const count = at.count ?? 1;
  if (count < 1) fail("count must be at least 1");
  const letters = at.before ?? at.after ?? fail("insert_columns needs before or after");
  const index = (columnIndex(letters) ?? fail(`${letters} is not a column`)) + (at.before ? 0 : 1);
  const ready = session.ensure(tab, 0, index);
  session.insertCols(ready, index, count);
}

function deleteTab(session: EditSession, name: string) {
  const tab = session.tab(name);
  if (session.grid.tabs.length === 1) fail("a sheet keeps at least one tab");
  for (const map of [session.maps.rows, session.maps.cols, session.maps.views]) {
    for (const [id, entry] of map.entries()) if (entry.get("tab") === tab.id) map.delete(id);
  }
  session.maps.tabs.delete(tab.id);
  session.relayout();
}

/** Applies an edit that changes rows, columns or tabs; false when `edit` is not one. */
export function structureEdit(session: EditSession, edit: SheetEdit) {
  const name = "tab" in edit ? edit.tab : undefined;
  if ("insert_rows" in edit) insertRows(session, session.tab(name), edit.insert_rows);
  else if ("insert_columns" in edit) insertCols(session, session.tab(name), edit.insert_columns);
  else if ("delete_rows" in edit) {
    const tab = session.tab(name);
    const { from, to } = rowsOf(session, tab, edit.delete_rows);
    for (let r = from; r <= to; r++) session.maps.rows.delete(tab.rows[r]!.id);
    session.relayout();
  } else if ("delete_columns" in edit) {
    const tab = session.tab(name);
    const { from, to } = colsOf(session, tab, edit.delete_columns);
    for (let c = from; c <= to; c++) {
      const id = tab.columns[c]!.id;
      session.maps.cols.delete(id);
      for (const row of tab.rows) if (row.cells.has(id)) session.maps.rows.get(row.id)?.delete(id);
    }
    session.relayout();
  } else if ("add_tab" in edit) session.addTab(edit.add_tab);
  else if ("rename_tab" in edit) {
    const tab = session.tab(name);
    const taken = session.grid.tabs.some(
      (t) => t !== tab && t.name.toLowerCase() === edit.rename_tab.toLowerCase(),
    );
    if (taken || !edit.rename_tab.trim()) fail(`${edit.rename_tab} cannot name this tab`);
    session.maps.tabs.get(tab.id)?.set("name", edit.rename_tab);
    session.relayout();
  } else if ("delete_tab" in edit) deleteTab(session, edit.delete_tab);
  else if ("freeze" in edit) {
    const tab = session.tab(name);
    const map = session.maps.tabs.get(tab.id)!;
    if (edit.freeze.rows !== undefined)
      map.set("frozenRows", Math.max(0, Math.floor(edit.freeze.rows)));
    if (edit.freeze.cols !== undefined)
      map.set("frozenCols", Math.max(0, Math.floor(edit.freeze.cols)));
    session.relayout();
  } else return false;
  return true;
}
