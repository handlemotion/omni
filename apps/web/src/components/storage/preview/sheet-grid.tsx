// One XLSX sheet as a spreadsheet grid (ADR 0043 decision 7): column letters across the top and
// row numbers down the side, both frozen, columns sized to their text and resizable, and only
// the cells on screen rendered (react-data-grid). Read-only: no editors, cells are React text.
import "react-data-grid/lib/styles.css";
import { memo, useMemo, type CSSProperties, type ReactNode } from "react";
import { DataGrid, type Column } from "react-data-grid";

type Row = { n: number; cells: string[] };

/** 0 → "A", 25 → "Z", 26 → "AA". */
function columnLetter(index: number) {
  let name = "";
  for (let i = index + 1; i > 0; i = Math.floor((i - 1) / 26)) {
    name = String.fromCharCode(65 + ((i - 1) % 26)) + name;
  }
  return name;
}

/** Rows read to size a column: enough to see its widest values without walking the sheet. */
const SAMPLE = 100;
/** Approximate width of a character at the grid's 13px, plus the cell's padding. */
const CHAR = 8.4;
const PAD = 24;

function widthFor(rows: string[][], c: number) {
  let longest = 0;
  for (const row of rows.slice(0, SAMPLE)) longest = Math.max(longest, row[c]?.length ?? 0);
  return Math.round(Math.min(320, Math.max(72, longest * CHAR + PAD)));
}

// react-data-grid's own styles sit in a CSS layer declared after the app's, so its variables are
// set inline (inline beats every layer), from the app's tokens.
const THEME = {
  "--rdg-font-size": "13px",
  "--rdg-color": "var(--foreground)",
  "--rdg-background-color": "var(--background)",
  "--rdg-header-background-color": "var(--surface)",
  "--rdg-border-color": "var(--border)",
  "--rdg-row-hover-background-color": "var(--hover)",
  "--rdg-selection-color": "var(--primary)",
  "--rdg-frozen-column-shadow-color": "transparent",
  blockSize: "100%",
  border: "none",
  flex: "1 1 0",
  minHeight: 0,
} as CSSProperties;

/** Letters and numbers: centred, muted, at the cell's own weight. Classes go on content, since
 * the grid's layer outranks utilities on its cells. */
function Muted(props: { children: ReactNode }) {
  return (
    <span className="block text-center text-xs font-normal text-muted-foreground">
      {props.children}
    </span>
  );
}

export const SheetGrid = memo(function SheetGrid(props: { rows: string[][] }) {
  const { rows } = props;
  const grid = useMemo(() => {
    const count = Math.max(0, ...rows.map((row) => row.length));
    const gutter = Math.max(44, String(rows.length).length * CHAR + PAD);
    const columns: Column<Row>[] = [
      {
        key: "n",
        name: "",
        frozen: true,
        width: gutter,
        minWidth: gutter,
        renderCell: ({ row }) => <Muted>{row.n}</Muted>,
      },
      ...Array.from({ length: count }, (_, c) => ({
        key: String(c),
        name: columnLetter(c),
        width: widthFor(rows, c),
        resizable: true,
        renderHeaderCell: () => <Muted>{columnLetter(c)}</Muted>,
        renderCell: ({ row }: { row: Row }) => row.cells[c] ?? "",
      })),
    ];
    return { columns, rows: rows.map((cells, i) => ({ n: i + 1, cells })) };
  }, [rows]);
  return (
    <DataGrid
      aria-label="Sheet"
      columns={grid.columns}
      rows={grid.rows}
      rowHeight={32}
      headerRowHeight={32}
      style={THEME}
    />
  );
});
