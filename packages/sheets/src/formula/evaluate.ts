import type { Grid, GridTab, LiveCell } from "../doc.ts";
import { isFormula, SHEET_LIMITS } from "../format.ts";
import { FUNCTIONS, type CallContext } from "./functions.ts";
import { parseFormula, type Node } from "./parse.ts";
import type { Axis, Corner, Ref } from "./refs.ts";
import {
  compare,
  errors,
  isError,
  isoSerial,
  Range,
  SheetError,
  single,
  toNumber,
  toText,
  type Arg,
  type Value,
} from "./values.ts";

const key = (rowId: string, colId: string) => `${rowId}|${colId}`;

/** A cell's own value as formulas read it: a date column's ISO dates are serial numbers. */
export function scalarValue(tab: GridTab, cell: LiveCell | undefined, colIndex: number) {
  if (cell === undefined || cell === "" || isFormula(cell)) return null;
  if (typeof cell === "string" && tab.columns[colIndex]?.type === "date")
    return isoSerial(cell) ?? cell;
  return cell;
}

interface Bounds {
  tab: GridTab;
  r0: number;
  r1: number;
  c0: number;
  c1: number;
}

const ARITH: Record<string, (a: number, b: number) => number | SheetError> = {
  "+": (a, b) => a + b,
  "-": (a, b) => a - b,
  "*": (a, b) => a * b,
  "/": (a, b) => (b === 0 ? errors.div0 : a / b),
  "^": (a, b) => a ** b,
};

const COMPARE: Record<string, (c: number) => boolean> = {
  "=": (c) => c === 0,
  "<>": (c) => c !== 0,
  "<": (c) => c < 0,
  ">": (c) => c > 0,
  "<=": (c) => c <= 0,
  ">=": (c) => c >= 0,
};

/** Evaluates every formula in a grid, each once, in dependency order; a cycle is `#REF!`. */
export class Evaluator {
  readonly values = new Map<string, Value>();
  private readonly grid: Grid;
  private readonly ctx: CallContext;
  private readonly formulas = new Map<
    string,
    { tab: GridTab; row: number; col: number; node: Node | null }
  >();
  private readonly formulaRows = new Map<string, number[]>();

  constructor(grid: Grid, now: number) {
    this.grid = grid;
    this.ctx = { now };
  }

  run() {
    this.collect();
    const order = this.order();
    for (const k of order) this.values.set(k, this.compute(k));
    for (const k of this.formulas.keys()) if (!this.values.has(k)) this.values.set(k, errors.ref);
    return this.values;
  }

  private collect() {
    for (const tab of this.grid.tabs) {
      tab.rows.forEach((row, r) => {
        for (const [colId, cell] of row.cells) {
          if (!isFormula(cell)) continue;
          const c = tab.colAt.get(colId)!;
          let node: Node | null = null;
          try {
            node = parseFormula(cell.f.slice(1), "live");
          } catch {
            node = null;
          }
          this.formulas.set(key(row.id, colId), { tab, row: r, col: c, node });
          const list = this.formulaRows.get(`${tab.id}|${c}`) ?? [];
          list.push(r);
          this.formulaRows.set(`${tab.id}|${c}`, list);
        }
      });
    }
  }

  private order() {
    const dependents = new Map<string, string[]>();
    const waiting = new Map<string, number>();
    for (const [k, f] of this.formulas) {
      const deps = new Set<string>();
      if (f.node) this.dependencies(f.node, f.tab, deps);
      deps.delete(k);
      waiting.set(k, deps.size);
      for (const d of deps) {
        const list = dependents.get(d);
        if (list) list.push(k);
        else dependents.set(d, [k]);
      }
      if (f.node && this.selfReference(f.node, f.tab, f.row, f.col)) waiting.set(k, Infinity);
    }
    const ready = [...waiting].filter(([, n]) => n === 0).map(([k]) => k);
    const order: string[] = [];
    while (ready.length) {
      const k = ready.pop()!;
      order.push(k);
      for (const d of dependents.get(k) ?? []) {
        const n = waiting.get(d)! - 1;
        waiting.set(d, n);
        if (n === 0) ready.push(d);
      }
    }
    return order;
  }

  private selfReference(node: Node, tab: GridTab, row: number, col: number) {
    let found = false;
    this.walkRefs(node, (ref) => {
      const b = this.bounds(ref, tab);
      if (b && b.tab === tab && b.r0 <= row && row <= b.r1 && b.c0 <= col && col <= b.c1)
        found = true;
    });
    return found;
  }

  private walkRefs(node: Node, visit: (ref: Ref) => void) {
    if (node.k === "ref") visit(node.v);
    else if (node.k === "call") for (const arg of node.args) this.walkRefs(arg, visit);
    else if (node.k === "bin") {
      this.walkRefs(node.a, visit);
      this.walkRefs(node.b, visit);
    } else if (node.k === "neg" || node.k === "pct") this.walkRefs(node.a, visit);
  }

  private dependencies(node: Node, tab: GridTab, out: Set<string>) {
    this.walkRefs(node, (ref) => {
      const b = this.bounds(ref, tab);
      if (!b) return;
      for (let c = b.c0; c <= b.c1; c++) {
        const rows = this.formulaRows.get(`${b.tab.id}|${c}`);
        if (!rows) continue;
        const colId = b.tab.columns[c]!.id;
        for (const r of rows) if (r >= b.r0 && r <= b.r1) out.add(key(b.tab.rows[r]!.id, colId));
      }
    });
  }

  private axis(axis: Axis | null, at: Map<string, number>, whole: number) {
    if (!axis) return whole;
    if (axis.id === undefined) return axis.index ?? 0;
    return at.get(axis.id) ?? false;
  }

  private bounds(ref: Ref, home: GridTab) {
    const tab = ref.tab === undefined ? home : this.grid.byId.get(ref.tab);
    if (!tab) return null;
    const corner = (c: Corner, end: boolean) => {
      const row = this.axis(c.row, tab.rowAt, end ? tab.rows.length - 1 : 0);
      const col = this.axis(c.col, tab.colAt, end ? tab.columns.length - 1 : 0);
      return row === false || col === false ? null : { row: row!, col: col! };
    };
    const a = corner(ref.a, false);
    const b = ref.b ? corner(ref.b, true) : ref.a.row && ref.a.col ? a : corner(ref.a, true);
    if (!a || !b) return null;
    return {
      tab,
      r0: Math.min(a.row, b.row),
      r1: Math.max(a.row, b.row),
      c0: Math.min(a.col, b.col),
      c1: Math.max(a.col, b.col),
    } satisfies Bounds;
  }

  private cell(tab: GridTab, r: number, c: number) {
    const row = tab.rows[r];
    const column = tab.columns[c];
    if (!row || !column) return null;
    const cell = row.cells.get(column.id);
    if (isFormula(cell)) return this.values.get(key(row.id, column.id)) ?? errors.ref;
    return scalarValue(tab, cell, c);
  }

  private reference(ref: Ref, home: GridTab) {
    const b = this.bounds(ref, home);
    if (!b) return errors.ref;
    const corners = ref.b ? [ref.a, ref.b] : [ref.a];
    const whole = (side: "row" | "col") => corners.some((c) => c[side] === null);
    const stored = (end: number, length: number, limit: number) =>
      Math.min(end, Math.max(length - 1, limit));
    const r1 = whole("row")
      ? stored(b.r1, b.tab.rows.length, b.r0)
      : Math.min(b.r1, SHEET_LIMITS.rows - 1);
    const c1 = whole("col")
      ? stored(b.c1, b.tab.columns.length, b.c0)
      : Math.min(b.c1, SHEET_LIMITS.columns - 1);
    const rows: Value[][] = [];
    for (let r = b.r0; r <= r1; r++) {
      const line: Value[] = [];
      for (let c = b.c0; c <= c1; c++) line.push(this.cell(b.tab, r, c));
      rows.push(line);
    }
    return new Range(rows);
  }

  private compute(k: string) {
    const f = this.formulas.get(k)!;
    if (!f.node) return errors.name;
    const result = single(this.node(f.node, f.tab));
    return result === null ? 0 : result;
  }

  private binary(op: string, left: Arg, right: Arg) {
    if (op === "&") {
      const a = toText(left);
      const b = toText(right);
      if (isError(a)) return a;
      if (isError(b)) return b;
      return a.length + b.length > SHEET_LIMITS.cellChars ? errors.value : a + b;
    }
    if (COMPARE[op]) {
      const a = single(left);
      const b = single(right);
      if (isError(a)) return a;
      if (isError(b)) return b;
      return COMPARE[op](compare(a, b));
    }
    const a = toNumber(left);
    const b = toNumber(right);
    if (isError(a)) return a;
    if (isError(b)) return b;
    return ARITH[op]!(a, b);
  }

  private readonly node: (node: Node, tab: GridTab) => Arg = (node, tab) => {
    const value: Arg = this.evaluateNode(node, tab);
    return typeof value === "number" && !Number.isFinite(value) ? errors.num : value;
  };

  private evaluateNode(node: Node, tab: GridTab) {
    switch (node.k) {
      case "num":
      case "str":
      case "bool":
        return node.v;
      case "err":
        return new SheetError(node.v);
      case "blank":
        return null;
      case "ref":
        return this.reference(node.v, tab);
      case "neg": {
        const inner: Arg = this.node(node.a, tab);
        const n = toNumber(inner);
        return isError(n) ? n : -n;
      }
      case "pct": {
        const inner: Arg = this.node(node.a, tab);
        const n = toNumber(inner);
        return isError(n) ? n : n / 100;
      }
      case "bin": {
        const a: Arg = this.node(node.a, tab);
        const b: Arg = this.node(node.b, tab);
        return this.binary(node.op, a, b);
      }
      case "call": {
        const fn = FUNCTIONS[node.name];
        if (!fn) return errors.name;
        const args: Arg[] = node.args.map((arg) => this.node(arg, tab));
        try {
          return fn(args, this.ctx);
        } catch {
          return errors.value;
        }
      }
    }
  }
}

/** Every formula's value in `grid`, by `rowId|colId`. */
export const evaluateGrid = (grid: Grid, now: number) => new Evaluator(grid, now).run();

export { key as cellKey };
