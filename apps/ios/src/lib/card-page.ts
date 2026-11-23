import { CARD_ROWS, grid } from "@omni/client";

function parseDelimited(text: string, delimiter: string, maxRows: number) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const normalized = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < normalized.length && rows.length < maxRows; i += 1) {
    const ch = normalized[i] ?? "";
    if (quoted) {
      if (ch === '"' && normalized[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell.length === 0) {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      if (row.some((value) => value.trim().length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (rows.length < maxRows && (cell.length > 0 || row.length > 0)) {
    row.push(cell);
    if (row.some((value) => value.trim().length > 0)) rows.push(row);
  }
  return rows;
}

/** A CSV or TSV's top-left corner as rows of cells, for a card's grid. */
export function csvGrid(text: string, name: string) {
  const delimiter = /\.tsv$/i.test(name) ? "\t" : ",";
  return grid(parseDelimited(text, delimiter, CARD_ROWS));
}
