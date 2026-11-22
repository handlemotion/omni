import { columnLetters, parseArea } from "./a1.ts";
import { gridLayout, type GridTab } from "./doc.ts";
import { isFormula, type SheetFile } from "./format.ts";
import { cellKey } from "./formula/evaluate.ts";
import { shiftA1, toA1, type Layout } from "./formula/translate.ts";
import { isError, numberText, type Value } from "./formula/values.ts";
import type { Evaluated } from "./save.ts";

const flat = (text: string) => text.replaceAll(/[\t\r\n]+/g, " ");

/** A value as a line of text shows it. */
export function shown(value: Value | string | undefined) {
  if (value === undefined || value === null) return "";
  if (typeof value === "number") return numberText(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (isError(value)) return value.code;
  return flat(value);
}

function rowValues(tab: GridTab, values: Evaluated["values"], r: number) {
  const row = tab.rows[r]!;
  return tab.columns.map((column) => {
    const cell = row.cells.get(column.id);
    return shown(isFormula(cell) ? values.get(cellKey(row.id, column.id)) : cell);
  });
}

/** What search indexes: each tab as `--- Sheet: name ---`, then its rows' values, tab-separated. */
export function indexText({ grid, values }: Evaluated) {
  const out: string[] = [];
  for (const tab of grid.tabs) {
    out.push(`--- Sheet: ${tab.name} ---`);
    tab.rows.forEach((_, r) => {
      const line = rowValues(tab, values, r).join("\t").trimEnd();
      if (line) out.push(line);
    });
    out.push("");
  }
  return out.join("\n");
}

function formulaRuns(tab: GridTab, layout: Layout) {
  const runs: string[] = [];
  tab.columns.forEach((column, c) => {
    let start = -1;
    let first = "";
    const close = (end: number) => {
      if (start < 0) return;
      const letters = columnLetters(c);
      const where =
        end === start ? `${letters}${start + 1}` : `${letters}${start + 1}:${letters}${end + 1}`;
      runs.push(`${where} ${first}`);
      start = -1;
    };
    tab.rows.forEach((row, r) => {
      const cell = row.cells.get(column.id);
      if (!isFormula(cell)) return close(r - 1);
      const a1 = toA1(cell.f, layout, tab.id);
      if (start >= 0 && shiftA1(first, r - start, 0) === a1) return;
      close(r - 1);
      start = r;
      first = a1;
    });
    close(tab.rows.length - 1);
  });
  return runs;
}

function columnNotes(tab: GridTab) {
  return tab.columns.flatMap((column, c) => {
    if (!column.type || column.type === "text") return [];
    const extra =
      column.type === "select"
        ? ` (${(column.options ?? []).join(", ")})`
        : column.format && column.format.kind !== "plain"
          ? ` (${column.format.kind}${column.format.currency ? ` ${column.format.currency}` : ""})`
          : "";
    return [`${columnLetters(c)} ${column.type}${extra}`];
  });
}

function viewNotes(tab: GridTab) {
  const letter = (id: string) => columnLetters(tab.colAt.get(id) ?? 0);
  return tab.views.map((view) => {
    const parts = [
      ...(view.filter ?? []).map(
        (f) =>
          `${letter(f.col)} ${f.op}${f.value === undefined ? "" : ` ${JSON.stringify(f.value)}`}`,
      ),
      ...(view.sort ?? []).map((s) => `sort ${letter(s.col)} ${s.dir}`),
      ...(view.hidden?.length ? [`hides ${view.hidden.map(letter).join(", ")}`] : []),
    ];
    return `${view.name}${parts.length ? ` (${parts.join("; ")})` : ""}`;
  });
}

/**
 * A sheet as an agent reads it: each tab's rows led by their number under a line of column
 * letters, then its formulas (one line per run), column types and views.
 */
export function agentText({ grid, values }: Evaluated) {
  const layout = gridLayout(grid);
  const out: string[] = [];
  for (const tab of grid.tabs) {
    const size =
      tab.rows.length && tab.columns.length
        ? `A1:${columnLetters(tab.columns.length - 1)}${tab.rows.length}`
        : "empty";
    const frozen = tab.frozen.rows
      ? `, frozen ${tab.frozen.rows} row${tab.frozen.rows === 1 ? "" : "s"}`
      : "";
    out.push(`--- Sheet: ${tab.name} (${size}${frozen}) ---`);
    if (tab.columns.length) out.push(`\t${tab.columns.map((_, c) => columnLetters(c)).join("\t")}`);
    tab.rows.forEach((_, r) =>
      out.push(`${r + 1}\t${rowValues(tab, values, r).join("\t")}`.trimEnd()),
    );
    const runs = formulaRuns(tab, layout);
    if (runs.length) out.push("Formulas:", ...runs);
    const columns = columnNotes(tab);
    if (columns.length) out.push(`Columns: ${columns.join("; ")}`);
    const views = viewNotes(tab);
    if (views.length) out.push(`Views: ${views.join("; ")}`);
    out.push("");
  }
  return out.join("\n");
}

/** What search indexes, read from a sheet's file: formulas by the values the file saved. */
export function fileIndexText(file: SheetFile) {
  const out: string[] = [];
  for (const tab of file.tabs) {
    out.push(`--- Sheet: ${tab.name} ---`);
    for (const row of tab.rows) {
      const line = tab.columns
        .map(({ id }) => {
          const cell = row.cells[id];
          if (!isFormula(cell)) return shown(cell);
          return cell.e ?? shown(cell.v ?? null);
        })
        .join("\t")
        .trimEnd();
      if (line) out.push(line);
    }
    out.push("");
  }
  return out.join("\n");
}

/** The values in `ranges` (`Tab!A1:C3`, as edits answer them), one `Tab!C2 = 1392` per cell. */
export function rangeValues({ grid, values }: Evaluated, ranges: string[], max = 200) {
  const lines: string[] = [];
  for (const range of ranges) {
    const bang = range.lastIndexOf("!");
    const tab = grid.tabs.find((t) => t.name === range.slice(0, bang));
    const area = parseArea(range.slice(bang + 1));
    if (!tab || !area || area.row0 === null || area.col0 === null) continue;
    for (let r = area.row0; r <= Math.min(area.row1!, tab.rows.length - 1); r++) {
      for (let c = area.col0; c <= Math.min(area.col1!, tab.columns.length - 1); c++) {
        if (lines.length >= max) return [...lines, `… and more in ${range}`].join("\n");
        const row = tab.rows[r]!;
        const cell = row.cells.get(tab.columns[c]!.id);
        const value = isFormula(cell) ? values.get(cellKey(row.id, tab.columns[c]!.id)) : cell;
        lines.push(`${tab.name}!${columnLetters(c)}${r + 1} = ${shown(value) || "(empty)"}`);
      }
    }
  }
  return lines.join("\n");
}
