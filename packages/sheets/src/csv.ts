/** Reads CSV (RFC 4180): quoted fields, doubled quotes, CRLF or LF, an optional BOM. */
export function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const body = text.startsWith("﻿") ? text.slice(1) : text;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quoted) {
      if (c === '"' && body[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && body[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const quote = (field: string) =>
  /[",\r\n]/.test(field) || /^\s|\s$/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;

/** Writes rows as CSV, CRLF between rows, quoting what needs it. */
export const toCsv = (rows: string[][]) => rows.map((row) => row.map(quote).join(",")).join("\r\n");
