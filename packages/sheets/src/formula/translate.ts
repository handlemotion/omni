import { printTokens, tokenize, type Token } from "./tokens.ts";
import type { Axis, Corner, Ref } from "./refs.ts";

/** What references are written against: each tab's name and its rows and columns in order. */
export interface Layout {
  tabs: { id: string; name: string; rowIds: string[]; colIds: string[] }[];
}

interface Indexed {
  id: string;
  name: string;
  rowAt: Map<string, number>;
  colAt: Map<string, number>;
  rowIds: string[];
  colIds: string[];
}

const cache = new WeakMap<Layout, Map<string, Indexed>>();

function indexed(layout: Layout) {
  let found = cache.get(layout);
  if (!found) {
    found = new Map();
    for (const tab of layout.tabs) {
      found.set(tab.id, {
        ...tab,
        rowAt: new Map(tab.rowIds.map((id, i) => [id, i])),
        colAt: new Map(tab.colIds.map((id, i) => [id, i])),
      });
    }
    cache.set(layout, found);
  }
  return found;
}

const REF_ERROR: Token = { k: "err", v: "#REF!" };

function toLiveAxis(axis: Axis | null, ids: string[]) {
  if (!axis) return null;
  const id = ids[axis.index ?? 0];
  return id ? { abs: axis.abs, id } : { abs: axis.abs, index: axis.index ?? 0 };
}

function toA1Axis(axis: Axis | null, at: Map<string, number>) {
  if (!axis) return null;
  if (axis.id === undefined) return { abs: axis.abs, index: axis.index ?? 0 };
  const index = at.get(axis.id);
  return index === undefined ? false : { abs: axis.abs, index };
}

function mapCorners(ref: Ref, fn: (corner: Corner) => Corner | false) {
  const a = fn(ref.a);
  const b = ref.b ? fn(ref.b) : undefined;
  if (a === false || b === false) return false;
  const out: Ref = { a };
  if (b) out.b = b;
  return out;
}

function liveRef(ref: Ref, layout: Layout, tabId: string) {
  const tabs = indexed(layout);
  let target = tabs.get(tabId);
  let tab: string | undefined;
  if (ref.tab !== undefined) {
    const lower = ref.tab.toLowerCase();
    target = [...tabs.values()].find((t) => t.name.toLowerCase() === lower);
    if (!target) return REF_ERROR;
    tab = target.id;
  }
  if (!target) return REF_ERROR;
  const t = target;
  const out = mapCorners(ref, (c) => ({
    row: toLiveAxis(c.row, t.rowIds),
    col: toLiveAxis(c.col, t.colIds),
  }));
  if (!out) return REF_ERROR;
  if (tab !== undefined) out.tab = tab;
  return { k: "ref", v: out } satisfies Token;
}

function a1Ref(ref: Ref, layout: Layout, tabId: string) {
  const tabs = indexed(layout);
  const target = tabs.get(ref.tab ?? tabId);
  if (!target) return REF_ERROR;
  const out = mapCorners(ref, (c) => {
    const row = toA1Axis(c.row, target.rowAt);
    const col = toA1Axis(c.col, target.colAt);
    return row === false || col === false ? false : { row, col };
  });
  if (!out) return REF_ERROR;
  if (ref.tab !== undefined) out.tab = target.name;
  return { k: "ref", v: out } satisfies Token;
}

function translate(
  formula: string,
  from: "a1" | "live",
  to: "a1" | "live",
  map: (ref: Ref) => Token,
) {
  if (!formula.startsWith("=")) return formula;
  let tokens: Token[];
  try {
    tokens = tokenize(formula.slice(1), from);
  } catch {
    return formula;
  }
  return `=${printTokens(
    tokens.map((t) => (t.k === "ref" ? map(t.v) : t)),
    to,
  )}`;
}

/** A formula in A1, written in tab `tabId`, with its references by id. */
export const toLive = (formula: string, layout: Layout, tabId: string) =>
  translate(formula, "a1", "live", (ref) => liveRef(ref, layout, tabId));

/** A formula with references by id, written back in A1 for tab `tabId`. */
export const toA1 = (formula: string, layout: Layout, tabId: string) =>
  translate(formula, "live", "a1", (ref) => a1Ref(ref, layout, tabId));

/** A formula in A1 moved by `rows` and `cols`: relative references shift, absolute ones stay. */
export function shiftA1(formula: string, rows: number, cols: number) {
  const shift = (axis: Axis | null, by: number) =>
    axis && !axis.abs ? { abs: false, index: Math.max(0, (axis.index ?? 0) + by) } : axis;
  return translate(formula, "a1", "a1", (ref) => {
    const out = mapCorners(ref, (c) => ({ row: shift(c.row, rows), col: shift(c.col, cols) }))!;
    if (ref.tab !== undefined) (out as Ref).tab = ref.tab;
    return { k: "ref", v: out as Ref } satisfies Token;
  });
}
