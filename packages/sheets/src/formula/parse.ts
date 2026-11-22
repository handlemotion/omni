import type { Ref } from "./refs.ts";
import { FormulaSyntaxError, tokenize, type Token } from "./tokens.ts";

export type Node =
  | { k: "num"; v: number }
  | { k: "str"; v: string }
  | { k: "bool"; v: boolean }
  | { k: "err"; v: string }
  | { k: "blank" }
  | { k: "ref"; v: Ref }
  | { k: "call"; name: string; args: Node[] }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "neg"; a: Node }
  | { k: "pct"; a: Node };

/** How deep a formula may nest: deeper ones would run the evaluator out of stack. */
export const FORMULA_MAX_DEPTH = 256;

const LEVELS = [["=", "<>", "<", ">", "<=", ">="], ["&"], ["+", "-"], ["*", "/"], ["^"]];

function depthOf(root: Node) {
  let deepest = 0;
  const stack: [Node, number][] = [[root, 1]];
  for (let next = stack.pop(); next; next = stack.pop()) {
    const [node, depth] = next;
    deepest = Math.max(deepest, depth);
    const children = node.k === "call" ? node.args : node.k === "bin" ? [node.a, node.b] : [];
    if (node.k === "neg" || node.k === "pct") children.push(node.a);
    for (const child of children) stack.push([child, depth + 1]);
  }
  return deepest;
}

class Parser {
  private at = 0;
  private nesting = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens.filter((token) => token.k !== "ws");
  }

  parse() {
    const node: Node = this.level(0);
    if (this.at < this.tokens.length)
      throw new FormulaSyntaxError("unexpected text after the formula");
    if (depthOf(node) > FORMULA_MAX_DEPTH)
      throw new FormulaSyntaxError("the formula nests too deep");
    return node;
  }

  private enter() {
    if (++this.nesting > FORMULA_MAX_DEPTH)
      throw new FormulaSyntaxError("the formula nests too deep");
  }

  private peek() {
    return this.tokens[this.at];
  }

  private readonly level: (n: number) => Node = (n) => {
    if (n >= LEVELS.length) {
      const leaf: Node = this.unary();
      return leaf;
    }
    if (n === 0) this.enter();
    let node: Node = this.level(n + 1);
    for (;;) {
      const token = this.peek();
      if (token?.k !== "op" || !LEVELS[n]!.includes(token.v)) {
        if (n === 0) this.nesting--;
        return node;
      }
      this.at++;
      node = { k: "bin", op: token.v, a: node, b: this.level(n + 1) };
    }
  };

  private readonly unary: () => Node = () => {
    const token = this.peek();
    if (token?.k === "op" && (token.v === "-" || token.v === "+")) {
      this.at++;
      this.enter();
      const a: Node = this.unary();
      this.nesting--;
      const signed: Node = token.v === "-" ? { k: "neg", a } : a;
      return signed;
    }
    const operand: Node = this.postfix();
    return operand;
  };

  private readonly postfix: () => Node = () => {
    let node: Node = this.primary();
    while (this.peek()?.k === "op" && this.peek()!.v === "%") {
      this.at++;
      node = { k: "pct", a: node };
    }
    return node;
  };

  private readonly primary: () => Node = () => {
    const token = this.tokens[this.at++];
    if (!token) throw new FormulaSyntaxError("the formula ends too soon");
    switch (token.k) {
      case "num":
        return { k: "num", v: token.v };
      case "str":
      case "bool":
      case "err":
      case "ref":
        return { k: token.k, v: token.v } as Node;
      case "func": {
        const called: Node = this.call(token.v);
        return called;
      }
      case "(": {
        const node: Node = this.level(0);
        if (this.tokens[this.at++]?.k !== ")") throw new FormulaSyntaxError("a ( is not closed");
        return node;
      }
      default:
        throw new FormulaSyntaxError(`unexpected ${token.v}`);
    }
  };

  private readonly call: (name: string) => Node = (name) => {
    this.at++;
    const args: Node[] = [];
    if (this.peek()?.k === ")") {
      this.at++;
      return { k: "call", name, args };
    }
    for (;;) {
      const next = this.peek();
      args.push(next?.k === "," || next?.k === ")" ? { k: "blank" } : this.level(0));
      const sep = this.tokens[this.at++];
      if (sep?.k === ")") return { k: "call", name, args };
      if (sep?.k !== ",") throw new FormulaSyntaxError(`${name}( is not closed`);
    }
  };
}

/** The tree of a formula's text (without its `=`), references read in `form`. */
export const parseFormula = (body: string, form: "a1" | "live") =>
  new Parser(tokenize(body, form)).parse();
