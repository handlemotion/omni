import type { SheetFunction } from "./functions.ts";
import { compare, errors, isError, Range, single, toBool, toNumber, type Value } from "./values.ts";

const sameValue = (a: Value, b: Value) =>
  typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b;

function find(list: Value[], target: Value, exact: boolean, descending = false) {
  if (exact) return list.findIndex((v) => sameValue(v, target));
  const past = descending ? -1 : 1;
  let found = -1;
  for (const [i, v] of list.entries()) {
    if (v === null) continue;
    if (Math.sign(compare(v, target)) === past) break;
    found = i;
  }
  return found;
}

export const lookupFunctions: Record<string, SheetFunction> = {
  VLOOKUP: ([target = null, table, column = null, approx = true]) => {
    if (!(table instanceof Range)) return errors.value;
    const col = toNumber(column);
    const loose = toBool(approx);
    if (isError(col) || isError(loose)) return errors.value;
    const width = table.rows[0]?.length ?? 0;
    if (col < 1 || col > width) return errors.ref;
    const at = find(
      table.rows.map((row) => row[0] ?? null),
      single(target),
      !loose,
    );
    return at < 0 ? errors.na : (table.rows[at]![col - 1] ?? null);
  },
  HLOOKUP: ([target = null, table, row = null, approx = true]) => {
    if (!(table instanceof Range)) return errors.value;
    const r = toNumber(row);
    const loose = toBool(approx);
    if (isError(r) || isError(loose)) return errors.value;
    if (r < 1 || r > table.rows.length) return errors.ref;
    const at = find(table.rows[0] ?? [], single(target), !loose);
    return at < 0 ? errors.na : (table.rows[r - 1]![at] ?? null);
  },
  XLOOKUP: ([target = null, look, back, missing]) => {
    if (!(look instanceof Range) || !(back instanceof Range)) return errors.value;
    const list = look.flat;
    const results = back.flat;
    if (list.length !== results.length) return errors.value;
    const at = find(list, single(target), true);
    if (at >= 0) return results[at] ?? null;
    return missing === undefined ? errors.na : single(missing);
  },
  MATCH: ([target = null, look, kind = 1]) => {
    if (!(look instanceof Range)) return errors.na;
    const k = toNumber(kind);
    if (isError(k)) return k;
    const at = find(look.flat, single(target), k === 0, k < 0);
    return at < 0 ? errors.na : at + 1;
  },
  INDEX: ([table, row = null, column = null]) => {
    if (!(table instanceof Range)) return single(table ?? null);
    const r = toNumber(row);
    const c = toNumber(column);
    if (isError(r) || isError(c)) return errors.value;
    const oneRow = table.rows.length === 1;
    const [ri, ci] = oneRow && column === null ? [1, r] : [r, c || 1];
    const value = table.rows[ri - 1]?.[ci - 1];
    return value === undefined ? errors.ref : value;
  },
};
