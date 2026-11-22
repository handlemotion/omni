/** A value a cell holds. */
export type Scalar = string | number | boolean;

/** A formula as the file holds it: A1 text, and its value or error when the file was saved. */
export interface FileFormula {
  f: string;
  v?: Scalar | null;
  e?: string;
}

export type FileCell = Scalar | FileFormula;

export type ColumnType = "text" | "number" | "date" | "checkbox" | "select";

export interface NumberFormat {
  kind: "plain" | "percent" | "currency";
  decimals?: number;
  currency?: string;
}

export interface Column {
  id: string;
  width?: number;
  type?: ColumnType;
  format?: NumberFormat;
  options?: string[];
  time?: boolean;
}

export type FilterOp =
  | "contains"
  | "is"
  | "is_not"
  | "empty"
  | "not_empty"
  | "eq"
  | "ne"
  | "lt"
  | "le"
  | "gt"
  | "ge"
  | "before"
  | "after"
  | "on"
  | "any_of";

export interface Filter {
  col: string;
  op: FilterOp;
  value?: Scalar | Scalar[];
}

export interface Sort {
  col: string;
  dir: "asc" | "desc";
}

export interface View {
  id: string;
  name: string;
  filter?: Filter[];
  sort?: Sort[];
  hidden?: string[];
}

export interface Frozen {
  rows: number;
  cols: number;
}

export interface FileRow {
  id: string;
  cells: Record<string, FileCell>;
}

export interface FileTab {
  id: string;
  name: string;
  frozen?: Frozen;
  columns: Column[];
  views?: View[];
  rows: FileRow[];
}

/** A sheet as its file holds it: tabs in order, each with its columns and rows in order. */
export interface SheetFile {
  tabs: FileTab[];
}

/** The limits of `docs/spec/sheets.md` "Limits". */
export const SHEET_LIMITS = {
  cells: 100_000,
  rows: 20_000,
  columns: 200,
  tabs: 20,
  formulas: 20_000,
  cellChars: 32_767,
  bytes: 5_000_000,
  editsPerCall: 100,
  cellsPerCall: 10_000,
} as const;

const ID = /^[A-Za-z0-9_-]{2,24}$/;
const RESERVED = new Set(["tab", "p", "name", "frozen", "width", "type", "format", "options"]);

/** Whether `id` can name a tab, row, column or view (and never collides with a field name). */
export const isId = (id: unknown): id is string =>
  typeof id === "string" && ID.test(id) && !RESERVED.has(id);

export const isFormula = (cell: unknown): cell is { f: string } =>
  typeof cell === "object" && cell !== null && typeof (cell as { f?: unknown }).f === "string";

const isScalar = (value: unknown): value is Scalar =>
  typeof value === "string" ||
  typeof value === "boolean" ||
  (typeof value === "number" && Number.isFinite(value));

export class SheetFormatError extends Error {}

const fail = (message: string): never => {
  throw new SheetFormatError(message);
};

function cleanCell(cell: unknown) {
  if (isScalar(cell)) return cell;
  if (!isFormula(cell)) return undefined;
  const out: FileFormula = { f: cell.f };
  const { v, e } = cell as FileFormula;
  if (isScalar(v) || v === null) out.v = v;
  if (typeof e === "string") out.e = e;
  return out;
}

function cleanColumn(raw: unknown) {
  const column = raw as Column;
  if (!isId(column?.id)) fail("a column has no valid id");
  const out: Column = { id: column.id };
  if (typeof column.width === "number" && column.width > 0) out.width = Math.round(column.width);
  if (["text", "number", "date", "checkbox", "select"].includes(column.type as string)) {
    out.type = column.type;
  }
  if (column.format && typeof column.format === "object") out.format = { ...column.format };
  if (Array.isArray(column.options))
    out.options = column.options.filter((o) => typeof o === "string");
  if (column.time === true) out.time = true;
  return out;
}

function cleanTab(raw: unknown) {
  const tab = raw as FileTab;
  if (!isId(tab?.id)) fail("a tab has no valid id");
  if (typeof tab.name !== "string" || !tab.name.trim()) fail("a tab has no name");
  const out: FileTab = {
    id: tab.id,
    name: tab.name,
    columns: (Array.isArray(tab.columns) ? tab.columns : []).map(cleanColumn),
    rows: [],
  };
  const rows = Math.max(0, Math.floor(Number(tab.frozen?.rows) || 0));
  const cols = Math.max(0, Math.floor(Number(tab.frozen?.cols) || 0));
  if (rows || cols) out.frozen = { rows, cols };
  if (Array.isArray(tab.views)) {
    out.views = tab.views.filter((view) => isId(view?.id) && typeof view.name === "string");
  }
  return out;
}

/** Reads a sheet's file. Throws `SheetFormatError` when it is not one. */
export function parseSheet(text: string) {
  const lines = text.split("\n").filter((line) => line.trim());
  const head = JSON.parse(lines[0] ?? "null") as { omni?: string; v?: number; tabs?: unknown[] };
  if (head?.omni !== "sheet" || head.v !== 1) fail("not an Omni sheet");
  const tabs = (head.tabs ?? []).map(cleanTab);
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  if (byId.size !== tabs.length) fail("two tabs share an id");
  const seen = new Set<string>();
  for (const line of lines.slice(1)) {
    const row = JSON.parse(line) as { t?: string; r?: string; c?: Record<string, unknown> };
    const tab = byId.get(row.t ?? "");
    if (!tab || !isId(row.r) || seen.has(row.r)) fail("a row has no tab or a repeated id");
    seen.add(row.r!);
    const cells: Record<string, FileCell> = {};
    for (const [col, cell] of Object.entries(row.c ?? {})) {
      const clean = cleanCell(cell);
      if (clean !== undefined && isId(col)) cells[col] = clean;
    }
    tab!.rows.push({ id: row.r!, cells });
  }
  return { tabs };
}

/** Writes a sheet's file: one header line, then one line per row, in order. */
export function serializeSheet(sheet: SheetFile) {
  const header = {
    omni: "sheet",
    v: 1,
    tabs: sheet.tabs.map(({ rows: _rows, ...tab }) => tab),
  };
  const lines = [JSON.stringify(header)];
  for (const tab of sheet.tabs) {
    for (const row of tab.rows) {
      const line: { t: string; r: string; c?: Record<string, FileCell> } = { t: tab.id, r: row.id };
      if (Object.keys(row.cells).length) line.c = row.cells;
      lines.push(JSON.stringify(line));
    }
  }
  return `${lines.join("\n")}\n`;
}

const utf8Length = (text: string) => {
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
};

/** Why `sheet` is past the limits or cannot be addressed, or null when it fits. */
export function limitProblem(sheet: SheetFile) {
  const L = SHEET_LIMITS;
  if (sheet.tabs.length > L.tabs) return `more than ${L.tabs} tabs`;
  const names = new Set<string>();
  for (const tab of sheet.tabs) {
    const name = tab.name.toLowerCase();
    if (names.has(name)) return `two tabs named ${tab.name}`;
    names.add(name);
  }
  let cells = 0;
  let formulas = 0;
  for (const tab of sheet.tabs) {
    if (tab.rows.length > L.rows) return `more than ${L.rows} rows in ${tab.name}`;
    if (tab.columns.length > L.columns) return `more than ${L.columns} columns in ${tab.name}`;
    for (const row of tab.rows) {
      for (const cell of Object.values(row.cells)) {
        cells++;
        if (isFormula(cell)) formulas++;
        const text = isFormula(cell) ? cell.f : cell;
        if (typeof text === "string" && text.length > L.cellChars) {
          return `a cell longer than ${L.cellChars} characters`;
        }
      }
    }
  }
  if (cells > L.cells) return `more than ${L.cells} cells with a value`;
  if (formulas > L.formulas) return `more than ${L.formulas} formulas`;
  if (utf8Length(serializeSheet(sheet)) > L.bytes) return "a file larger than 5 MB";
  return null;
}
