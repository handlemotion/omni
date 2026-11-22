import { compare, isError, parseNumber, Range, type Arg, type Value } from "./values.ts";

type Test = (value: Value) => boolean;

const OPERATOR = /^(<=|>=|<>|<|>|=)?(.*)$/s;

type Glob = { c: string; wild: "" | "*" | "?" }[];

function glob(pattern: string) {
  const out: Glob = [];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "~" && (pattern[i + 1] === "*" || pattern[i + 1] === "?")) {
      out.push({ c: pattern[++i]!, wild: "" });
    } else {
      out.push({ c: c.toLowerCase(), wild: c === "*" || c === "?" ? c : "" });
    }
  }
  return out;
}

function globMatch(parts: Glob, text: string) {
  const t = text.toLowerCase();
  let p = 0;
  let i = 0;
  let star = -1;
  let resume = 0;
  while (i < t.length) {
    const part = parts[p];
    if (part && (part.wild === "?" || (part.wild === "" && part.c === t[i]))) {
      p++;
      i++;
    } else if (part?.wild === "*") {
      star = p++;
      resume = i;
    } else if (star >= 0) {
      p = star + 1;
      i = ++resume;
    } else {
      return false;
    }
  }
  while (parts[p]?.wild === "*") p++;
  return p === parts.length;
}

/** A test for `SUMIF`-style criteria: `5`, `">5"`, `"<>x"`, `"a*"`. */
export function criterion(arg: Arg) {
  const raw = arg instanceof Range ? (arg.rows[0]?.[0] ?? null) : arg;
  if (isError(raw)) return raw;
  if (typeof raw === "number" || typeof raw === "boolean") return ((v) => v === raw) satisfies Test;
  if (raw === null) return ((v) => v === raw) satisfies Test;
  const [, op = "", rest = ""] = OPERATOR.exec(raw)!;
  const number = parseNumber(rest);
  const target: Value =
    number ??
    (rest.toUpperCase() === "TRUE" ? true : rest.toUpperCase() === "FALSE" ? false : rest);
  if (op === "" || op === "=" || op === "<>") {
    const equal: Test =
      typeof target === "string"
        ? target === ""
          ? (v: Value) => v === null || v === ""
          : (
              (parts) => (v: Value) =>
                typeof v === "string" && globMatch(parts, v)
            )(glob(target))
        : (v: Value) => v === target;
    return op === "<>" ? (((v) => !equal(v)) satisfies Test) : equal;
  }
  return ((v) => {
    if (v === null || isError(v) || typeof v !== typeof target) return false;
    const c = compare(v, target);
    return op === "<" ? c < 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : c >= 0;
  }) satisfies Test;
}
