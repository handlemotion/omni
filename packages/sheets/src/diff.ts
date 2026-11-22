import { columnLetters } from "./a1.ts";
import { isFormula, type FileCell, type SheetFile } from "./format.ts";
import { toLive, type Layout } from "./formula/translate.ts";
import { shown } from "./render.ts";

const MAX_LINES = 400;

const layoutOf = (file: SheetFile) =>
  ({
    tabs: file.tabs.map((tab) => ({
      id: tab.id,
      name: tab.name,
      rowIds: tab.rows.map((r) => r.id),
      colIds: tab.columns.map((c) => c.id),
    })),
  }) satisfies Layout;

const cellText = (cell: FileCell | undefined) => {
  if (cell === undefined) return "(empty)";
  if (isFormula(cell)) return cell.f;
  return shown(cell) || "(empty)";
};

/**
 * What changed between two versions of a sheet, by tab, row and column id: cells as
 * `Leads!B4: 1200 → 1400`, rows and columns added or removed, tabs added, removed or renamed.
 */
export function diffSheets(before: SheetFile, after: SheetFile) {
  const lines: string[] = [];
  const old = new Map(before.tabs.map((t) => [t.id, t]));
  const thenLayout = layoutOf(before);
  const nowLayout = layoutOf(after);
  for (const tab of after.tabs) {
    const was = old.get(tab.id);
    if (!was) {
      lines.push(`Tab ${tab.name} added (${tab.rows.length} rows)`);
      continue;
    }
    if (was.name !== tab.name) lines.push(`Tab ${was.name} renamed ${tab.name}`);
    const oldRows = new Map(was.rows.map((r) => [r.id, r]));
    const newRows = new Set(tab.rows.map((r) => r.id));
    const oldCols = new Set(was.columns.map((c) => c.id));
    tab.columns.forEach((c, i) => {
      if (!oldCols.has(c.id)) lines.push(`${tab.name}: column ${columnLetters(i)} added`);
    });
    const newCols = new Set(tab.columns.map((c) => c.id));
    was.columns.forEach((c, i) => {
      if (!newCols.has(c.id)) lines.push(`${tab.name}: column ${columnLetters(i)} removed`);
    });
    was.rows.forEach((row, i) => {
      if (!newRows.has(row.id)) {
        const values = Object.values(row.cells).slice(0, 4).map(cellText).join(", ");
        lines.push(`${tab.name}: row ${i + 1} removed${values ? ` (${values})` : ""}`);
      }
    });
    tab.rows.forEach((row, r) => {
      const prior = oldRows.get(row.id);
      if (!prior) {
        if (Object.keys(row.cells).length) lines.push(`${tab.name}: row ${r + 1} added`);
        return;
      }
      tab.columns.forEach((column, c) => {
        const a = prior.cells[column.id];
        const b = row.cells[column.id];
        const x = isFormula(a) ? toLive(a.f, thenLayout, tab.id) : a;
        const y = isFormula(b) ? toLive(b.f, nowLayout, tab.id) : b;
        if (x !== y && oldCols.has(column.id)) {
          lines.push(`${tab.name}!${columnLetters(c)}${r + 1}: ${cellText(a)} → ${cellText(b)}`);
        }
      });
    });
  }
  const kept = new Set(after.tabs.map((t) => t.id));
  for (const tab of before.tabs) if (!kept.has(tab.id)) lines.push(`Tab ${tab.name} removed`);
  if (lines.length > MAX_LINES) {
    return [...lines.slice(0, MAX_LINES), `… and ${lines.length - MAX_LINES} more changes`].join(
      "\n",
    );
  }
  return lines.join("\n");
}
