import { criterion } from "./criteria.ts";
import { lookupFunctions } from "./lookup.ts";
import { textFunctions } from "./text.ts";
import {
  errors,
  isError,
  Range,
  single,
  toBool,
  toNumber,
  type Arg,
  type Value,
} from "./values.ts";

export interface CallContext {
  /** Now, as a serial number. */
  now: number;
}

export type SheetFunction = (args: Arg[], ctx: CallContext) => Value;

function numbers(args: Arg[]) {
  const out: number[] = [];
  for (const arg of args) {
    if (arg instanceof Range) {
      for (const v of arg.flat) {
        if (isError(v)) return v;
        if (typeof v === "number") out.push(v);
      }
      continue;
    }
    if (arg === null) continue;
    const n = toNumber(arg);
    if (isError(n)) return n;
    out.push(n);
  }
  return out;
}

const over = (fold: (ns: number[]) => Value) =>
  ((args) => {
    const ns = numbers(args);
    return isError(ns) ? ns : fold(ns);
  }) satisfies SheetFunction;

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

const num = (fn: (...ns: number[]) => Value, arity: number) =>
  ((args) => {
    if (args.length < arity) return errors.value;
    const ns: number[] = [];
    for (const arg of args) {
      const n = toNumber(arg);
      if (isError(n)) return n;
      ns.push(n);
    }
    return fn(...ns);
  }) satisfies SheetFunction;

const roundTo = (n: number, digits: number, mode: "round" | "up" | "down") => {
  const f = 10 ** Math.trunc(digits);
  const x = Math.abs(n) * f;
  const r =
    mode === "round"
      ? Math.round(Number(x.toPrecision(15)))
      : mode === "up"
        ? Math.ceil(x - 1e-9)
        : Math.floor(x + 1e-9);
  return (Math.sign(n) * r) / f;
};

function flatAll(args: Arg[]) {
  return args.flatMap((arg) => (arg instanceof Range ? arg.flat : [arg]));
}

const logical = (fold: (bs: boolean[]) => boolean) =>
  ((args) => {
    const bs: boolean[] = [];
    for (const v of flatAll(args)) {
      if (v === null || typeof v === "string") continue;
      const b = toBool(v);
      if (isError(b)) return b;
      bs.push(b);
    }
    return bs.length ? fold(bs) : errors.value;
  }) satisfies SheetFunction;

function matching(pairs: Arg[]) {
  const first = pairs[0];
  if (!(first instanceof Range) || pairs.length % 2) return errors.value;
  const size = first.flat.length;
  const ok = Array.from({ length: size }, () => true);
  for (let i = 0; i < pairs.length; i += 2) {
    const range = pairs[i];
    if (!(range instanceof Range) || range.flat.length !== size) return errors.value;
    const test = criterion(pairs[i + 1] ?? null);
    if (isError(test)) return test;
    range.flat.forEach((v, j) => {
      if (!test(v)) ok[j] = false;
    });
  }
  return ok;
}

function conditional(
  kind: "sum" | "count" | "average",
  values: Arg | undefined,
  pairs: Arg[],
  sameSize = false,
) {
  const ok = matching(pairs);
  if (isError(ok)) return ok;
  if (sameSize && (!(values instanceof Range) || values.flat.length !== ok.length)) {
    return errors.value;
  }
  const source = values instanceof Range ? values.flat : null;
  let total = 0;
  let count = 0;
  for (const [i, yes] of ok.entries()) {
    if (!yes) continue;
    if (kind === "count") {
      count++;
      continue;
    }
    const v = source?.[i];
    if (isError(v)) return v;
    if (typeof v === "number") {
      total += v;
      count++;
    }
  }
  if (kind === "count") return count;
  if (kind === "sum") return total;
  return count ? total / count : errors.div0;
}

const mathFunctions: Record<string, SheetFunction> = {
  SUM: over(sum),
  AVERAGE: over((ns) => (ns.length ? sum(ns) / ns.length : errors.div0)),
  MIN: over((ns) => (ns.length ? Math.min(...ns) : 0)),
  MAX: over((ns) => (ns.length ? Math.max(...ns) : 0)),
  PRODUCT: over((ns) => ns.reduce((a, b) => a * b, 1)),
  COUNT: (args) => flatAll(args).filter((v) => typeof v === "number").length,
  COUNTA: (args) => flatAll(args).filter((v) => v !== null).length,
  COUNTBLANK: (args) => flatAll(args).filter((v) => v === null || v === "").length,
  ROUND: num((n, d = 0) => roundTo(n, d, "round"), 1),
  ROUNDUP: num((n, d = 0) => roundTo(n, d, "up"), 1),
  ROUNDDOWN: num((n, d = 0) => roundTo(n, d, "down"), 1),
  INT: num((n) => Math.floor(n), 1),
  ABS: num((n) => Math.abs(n), 1),
  SIGN: num((n) => Math.sign(n), 1),
  SQRT: num((n) => (n < 0 ? errors.num : Math.sqrt(n)), 1),
  POWER: num((a, b) => a ** b, 2),
  EXP: num((n) => Math.exp(n), 1),
  LN: num((n) => (n <= 0 ? errors.num : Math.log(n)), 1),
  LOG10: num((n) => (n <= 0 ? errors.num : Math.log10(n)), 1),
  MOD: num((a, b) => (b === 0 ? errors.div0 : a - b * Math.floor(a / b)), 2),
  CEILING: num((n, s = 1) => (s === 0 ? 0 : Math.ceil(n / s) * s), 1),
  FLOOR: num((n, s = 1) => (s === 0 ? errors.div0 : Math.floor(n / s) * s), 1),
  PI: () => Math.PI,
  SUMIF: (args) => conditional("sum", args[2] ?? args[0], [args[0] ?? null, args[1] ?? null]),
  SUMIFS: (args) => conditional("sum", args[0], args.slice(1), true),
  COUNTIF: (args) => conditional("count", undefined, [args[0] ?? null, args[1] ?? null]),
  COUNTIFS: (args) => conditional("count", undefined, args),
  AVERAGEIF: (args) =>
    conditional("average", args[2] ?? args[0], [args[0] ?? null, args[1] ?? null]),
  AVERAGEIFS: (args) => conditional("average", args[0], args.slice(1), true),
};

const logicalFunctions: Record<string, SheetFunction> = {
  IF: (args) => {
    const test = toBool(args[0] ?? null);
    if (isError(test)) return test;
    const pick = test ? args[1] : args[2];
    return pick === undefined ? test : single(pick);
  },
  IFS: (args) => {
    for (let i = 0; i + 1 < args.length; i += 2) {
      const test = toBool(args[i]!);
      if (isError(test)) return test;
      if (test) return single(args[i + 1]!);
    }
    return errors.na;
  },
  AND: logical((bs) => bs.every(Boolean)),
  OR: logical((bs) => bs.some(Boolean)),
  XOR: logical((bs) => bs.filter(Boolean).length % 2 === 1),
  NOT: (args) => {
    const b = toBool(args[0] ?? null);
    return isError(b) ? b : !b;
  },
  TRUE: () => true,
  FALSE: () => false,
  IFERROR: (args) => {
    const v = single(args[0] ?? null);
    return isError(v) ? single(args[1] ?? null) : v;
  },
  IFNA: (args) => {
    const v = single(args[0] ?? null);
    return v === errors.na || (isError(v) && v.code === "#N/A") ? single(args[1] ?? null) : v;
  },
  ISBLANK: (args) => single(args[0] ?? null) === null,
  ISNUMBER: (args) => typeof single(args[0] ?? null) === "number",
  ISTEXT: (args) => typeof single(args[0] ?? null) === "string",
  ISERROR: (args) => isError(single(args[0] ?? null)),
  ISNA: (args) => {
    const v = single(args[0] ?? null);
    return isError(v) && v.code === "#N/A";
  },
  NA: () => errors.na,
};

/** The functions formulas can call, by name. */
export const FUNCTIONS: Record<string, SheetFunction> = {
  ...mathFunctions,
  ...logicalFunctions,
  ...textFunctions,
  ...lookupFunctions,
};
