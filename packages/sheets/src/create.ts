import { parseCsv } from "./csv.ts";
import type { InputValue } from "./edit-session.ts";
import type { Column, ColumnType, FileCell, NumberFormat, SheetFile } from "./format.ts";
import { parseNumber } from "./formula/values.ts";
import { newId } from "./ids.ts";

/** A tab as an agent creates it (`drive_create_sheet`). */
export interface TabInput {
  name: string;
  rows: InputValue[][];
  frozen_rows?: number;
  columns?: ({ type?: ColumnType; format?: NumberFormat; options?: string[] } | null)[];
}

const fileCell = (value: InputValue) => {
  if (value === null || value === "") return undefined;
  if (typeof value !== "string") return value;
  if (value.startsWith("'")) return value.slice(1);
  if (value.startsWith("=")) return { f: value };
  return value;
};

/** A new sheet's file from tabs of rows; formulas stay in A1, as files hold them. */
export function createSheetFile(tabs: TabInput[]) {
  const taken = new Set<string>();
  const id = (prefix: "t" | "r" | "c") => {
    const made = newId(prefix, taken);
    taken.add(made);
    return made;
  };
  const input = tabs.length ? tabs : [{ name: "Sheet 1", rows: [] }];
  return {
    tabs: input.map((tab) => {
      const width = Math.max(tab.columns?.length ?? 0, ...tab.rows.map((r) => r.length), 0);
      const columns: Column[] = Array.from({ length: width }, (_, c) => {
        const spec = tab.columns?.[c];
        return { id: id("c"), ...spec };
      });
      return {
        id: id("t"),
        name: tab.name,
        ...(tab.frozen_rows ? { frozen: { rows: tab.frozen_rows, cols: 0 } } : {}),
        columns,
        rows: tab.rows.map((values) => {
          const cells: Record<string, FileCell> = {};
          values.forEach((value, c) => {
            const cell = fileCell(value);
            if (cell !== undefined) cells[columns[c]!.id] = cell;
          });
          return { id: id("r"), cells };
        }),
      };
    }),
  } satisfies SheetFile;
}

/** CSV as one tab: numbers read as numbers; a first row of text over numbers is frozen. */
export function csvTab(name: string, text: string) {
  const rows: InputValue[][] = parseCsv(text).map((row) =>
    row.map((field) => {
      const n = parseNumber(field);
      return n !== null && field.trim() !== "" && !field.includes("%") ? n : field;
    }),
  );
  const header =
    rows.length > 1 &&
    rows[0]!.every((v) => typeof v === "string") &&
    rows.slice(1).some((row) => row.some((v) => typeof v === "number"));
  return { name, rows, ...(header ? { frozen_rows: 1 } : {}) };
}
