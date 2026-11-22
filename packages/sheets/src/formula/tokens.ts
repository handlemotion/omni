import { printA1, printLive, readRef, type Ref } from "./refs.ts";

export type Token =
  | { k: "num"; v: number; raw: string }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "err"; v: string }
  | { k: "ref"; v: Ref }
  | { k: "func"; v: string }
  | { k: "op"; v: string }
  | { k: "("; v: "(" }
  | { k: ")"; v: ")" }
  | { k: ","; v: "," }
  | { k: "ws"; v: string };

const ERRORS = ["#NULL!", "#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#N/A"];
const OPS = ["<>", "<=", ">=", "+", "-", "*", "/", "^", "&", "=", "<", ">", "%"];

export class FormulaSyntaxError extends Error {}

function readOther(text: string) {
  const ws = /^\s+/.exec(text);
  if (ws) return { k: "ws", v: ws[0], length: ws[0].length };
  const num = /^(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?/.exec(text);
  if (num) return { k: "num", v: Number(num[0]), raw: num[0], length: num[0].length };
  if (text.startsWith('"')) {
    const m = /^"((?:[^"]|"")*)"/.exec(text);
    if (!m) throw new FormulaSyntaxError("a text has no closing quote");
    return { k: "str", v: m[1]!.replaceAll('""', '"'), length: m[0].length };
  }
  const error = ERRORS.find((code) => text.toUpperCase().startsWith(code));
  if (error) return { k: "err", v: error, length: error.length };
  const name = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(text);
  if (name) {
    const after = text.slice(name[0].length).trimStart();
    if (after.startsWith("("))
      return { k: "func", v: name[0].toUpperCase(), length: name[0].length };
    const upper = name[0].toUpperCase();
    if (upper === "TRUE" || upper === "FALSE") {
      return { k: "bool", v: upper === "TRUE", length: name[0].length };
    }
    throw new FormulaSyntaxError(`unknown name ${name[0]}`);
  }
  const op = OPS.find((o) => text.startsWith(o));
  if (op) return { k: "op", v: op, length: op.length };
  const c = text[0];
  if (c === "(" || c === ")" || c === ",")
    return { k: c, v: c, length: 1 } as Token & { length: number };
  throw new FormulaSyntaxError(`unexpected ${c}`);
}

/** The tokens of a formula's text (without its leading `=`), its references read in `form`. */
export function tokenize(body: string, form: "a1" | "live") {
  const tokens: Token[] = [];
  for (let at = 0; at < body.length;) {
    const rest = body.slice(at);
    const ref = readRef(rest, form);
    if (ref) {
      tokens.push({ k: "ref", v: ref.ref });
      at += ref.length;
      continue;
    }
    const { length, ...token } = readOther(rest);
    tokens.push(token as Token);
    at += length;
  }
  return tokens;
}

const printString = (text: string) => `"${text.replaceAll('"', '""')}"`;

/** Writes tokens back as formula text, references in `form`. */
export function printTokens(tokens: Token[], form: "a1" | "live") {
  return tokens
    .map((token) => {
      switch (token.k) {
        case "ref":
          return form === "a1" ? printA1(token.v) : printLive(token.v);
        case "str":
          return printString(token.v);
        case "bool":
          return token.v ? "TRUE" : "FALSE";
        case "num":
          return token.raw;
        default:
          return token.v;
      }
    })
    .join("");
}
