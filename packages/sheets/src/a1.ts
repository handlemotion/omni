/** `0` → `A`, `25` → `Z`, `26` → `AA`. */
export function columnLetters(index: number) {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const rest = (n - 1) % 26;
    out = String.fromCharCode(65 + rest) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** `A` → `0`; null when it is not a column. */
export function columnIndex(letters: string) {
  if (!/^[A-Za-z]{1,3}$/.test(letters)) return null;
  let n = 0;
  for (const letter of letters.toUpperCase()) n = n * 26 + letter.charCodeAt(0) - 64;
  return n - 1;
}

/** A rectangle of cells, 0-based and inclusive; an open side covers the whole row or column. */
export interface Area {
  tab?: string;
  row0: number | null;
  col0: number | null;
  row1: number | null;
  col1: number | null;
}

const CELL = /^([A-Za-z]{1,3})(\d{1,7})$/;

function splitTab(text: string) {
  const bang = text.lastIndexOf("!");
  if (bang < 0) return { tab: undefined, ref: text };
  let tab = text.slice(0, bang);
  if (tab.startsWith("'") && tab.endsWith("'")) tab = tab.slice(1, -1).replaceAll("''", "'");
  return { tab, ref: text.slice(bang + 1) };
}

function corner(text: string) {
  const plain = text.replaceAll("$", "");
  const cell = CELL.exec(plain);
  if (cell) {
    const row = Number(cell[2]) - 1;
    return row < 0 ? null : { row, col: columnIndex(cell[1]!) };
  }
  if (/^\d{1,7}$/.test(plain))
    return Number(plain) > 0 ? { row: Number(plain) - 1, col: null } : null;
  const col = columnIndex(plain);
  return col === null ? null : { row: null, col };
}

/** Reads `B2`, `A1:C3`, `B:D`, `2:5` or `'My tab'!A1:B2`; null when it is none of them. */
export function parseArea(text: string) {
  const { tab, ref } = splitTab(text.trim());
  const [from, to = from, extra] = ref.split(":");
  if (extra !== undefined || !from || !to) return null;
  const a = corner(from);
  const b = corner(to);
  if (!a || !b || (a.row === null) !== (b.row === null) || (a.col === null) !== (b.col === null)) {
    return null;
  }
  const area: Area = {
    row0: a.row === null ? null : Math.min(a.row, b.row!),
    row1: a.row === null ? null : Math.max(a.row, b.row!),
    col0: a.col === null ? null : Math.min(a.col, b.col!),
    col1: a.col === null ? null : Math.max(a.col, b.col!),
  };
  if (tab !== undefined) area.tab = tab;
  return area;
}

/** `B2`, or `B2:C4` for a rectangle. */
export function areaText(row0: number, col0: number, row1 = row0, col1 = col0) {
  const a = `${columnLetters(col0)}${row0 + 1}`;
  return row0 === row1 && col0 === col1 ? a : `${a}:${columnLetters(col1)}${row1 + 1}`;
}

/** A tab's name as a formula or address quotes it. */
export const quoteTab = (name: string) =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replaceAll("'", "''")}'`;
