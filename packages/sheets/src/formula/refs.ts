import { columnIndex, columnLetters, quoteTab } from "../a1.ts";

/** One side of a reference: by id (live), by index (A1, or past the last row), absolute or not. */
export interface Axis {
  abs: boolean;
  id?: string;
  index?: number;
}

/** A corner of a reference; a null side covers the whole row or column. */
export interface Corner {
  row: Axis | null;
  col: Axis | null;
}

/** A cell or range reference: its tab (a name in A1 form, an id in live form) and corners. */
export interface Ref {
  tab?: string;
  a: Corner;
  b?: Corner;
}

const TAB = String.raw`(?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!`;
const A1_CELL = String.raw`\$?[A-Za-z]{1,3}\$?\d{1,7}`;
const A1 = new RegExp(
  String.raw`^(${TAB})?(${A1_CELL}(?::${A1_CELL})?|\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?\d{1,7}:\$?\d{1,7})`,
);
const LIVE_END = String.raw`\[(?:[A-Za-z0-9_-]+!)?\$?#?[A-Za-z0-9_-]*\|\$?#?[A-Za-z0-9_-]*\]`;
const LIVE = new RegExp(String.raw`^${LIVE_END}(?::${LIVE_END})?`);

const unquote = (tab: string) =>
  tab.startsWith("'") ? tab.slice(1, -1).replaceAll("''", "'") : tab;

function a1Corner(text: string) {
  const m = /^(\$?)([A-Za-z]{0,3})(\$?)(\d*)$/.exec(text)!;
  const col = m[2] ? { abs: m[1] === "$", index: columnIndex(m[2])! } : null;
  const rowAbs = m[2] ? m[3] === "$" : m[1] === "$";
  const row = m[4] ? { abs: rowAbs, index: Number(m[4]) - 1 } : null;
  return { row, col };
}

function liveAxis(text: string) {
  const abs = text.startsWith("$");
  const rest = abs ? text.slice(1) : text;
  if (!rest) return null;
  return rest.startsWith("#") ? { abs, index: Number(rest.slice(1)) } : { abs, id: rest };
}

function liveCorner(text: string) {
  const inner = text.slice(1, -1);
  const bang = inner.indexOf("!");
  const tab = bang >= 0 ? inner.slice(0, bang) : undefined;
  const [row = "", col = ""] = inner.slice(bang + 1).split("|");
  const corner = { row: liveAxis(row), col: liveAxis(col) };
  return tab === undefined ? { corner } : { tab, corner };
}

/** The reference at the start of `text`, in `form`, and its length; null when there is none. */
export function readRef(text: string, form: "a1" | "live") {
  if (form === "live") {
    const m = LIVE.exec(text);
    if (!m) return null;
    const [first, second] = m[0].split(/(?<=\]):(?=\[)/);
    const a = liveCorner(first!);
    const ref: Ref = { a: a.corner };
    if (a.tab !== undefined) ref.tab = a.tab;
    if (second) ref.b = liveCorner(second).corner;
    return { ref, length: m[0].length };
  }
  const m = A1.exec(text);
  if (!m) return null;
  const after = text.slice(m[0].length);
  if (/^[A-Za-z0-9_(.]/.test(after)) return null;
  const [first, second] = m[2]!.split(":");
  const ref: Ref = { a: a1Corner(first!) };
  if (m[1]) ref.tab = unquote(m[1].slice(0, -1));
  if (second) ref.b = a1Corner(second);
  return { ref, length: m[0].length };
}

const a1Axis = (axis: Axis | null, letters: boolean) => {
  if (!axis) return "";
  const n = axis.index ?? 0;
  return (axis.abs ? "$" : "") + (letters ? columnLetters(n) : String(n + 1));
};

/** A reference written in A1 (its tab, when given, is a name). */
export function printA1(ref: Ref) {
  const corner = (c: Corner) => a1Axis(c.col, true) + a1Axis(c.row, false);
  const tab = ref.tab === undefined ? "" : `${quoteTab(ref.tab)}!`;
  return tab + corner(ref.a) + (ref.b ? `:${corner(ref.b)}` : "");
}

const liveAxisText = (axis: Axis | null) =>
  axis ? (axis.abs ? "$" : "") + (axis.id ?? `#${axis.index ?? 0}`) : "";

/** A reference written by id (its tab, when given, is an id). */
export function printLive(ref: Ref) {
  const corner = (c: Corner, tab?: string) =>
    `[${tab === undefined ? "" : `${tab}!`}${liveAxisText(c.row)}|${liveAxisText(c.col)}]`;
  return corner(ref.a, ref.tab) + (ref.b ? `:${corner(ref.b)}` : "");
}
