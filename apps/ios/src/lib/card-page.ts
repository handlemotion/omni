export interface DocLine {
  kind: "heading" | "bullet" | "text";
  text: string;
}

const LINES = 14;
const ROWS = 12;
const COLUMNS = 5;

const inline = (line: string) =>
  line
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|_|~~|`)/g, "")
    .trim();

/**
 * A doc's page: its first heading as the title (else `name`), then its next lines as they read,
 * Markdown marks dropped and blank lines and rules skipped (mirrors web's `card-page.ts`).
 */
export function docPage(text: string, name: string) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let title = "";
  const body: DocLine[] = [];
  let fenced = false;
  for (const raw of lines) {
    if (body.length >= LINES) break;
    if (raw.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(raw);
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(raw);
    const plain = inline(raw.replace(/^\s*>\s?/, ""));
    if (fenced) body.push({ kind: "text", text: raw });
    else if (heading && !title && body.length === 0) title = inline(heading[1] ?? "");
    else if (heading) body.push({ kind: "heading", text: inline(heading[1] ?? "") });
    else if (bullet) body.push({ kind: "bullet", text: inline(bullet[1] ?? "") });
    else if (plain && !/^([-*_])\1{2,}$/.test(plain) && !plain.startsWith("|")) {
      body.push({ kind: "text", text: plain });
    }
  }
  return { title: title || name, body };
}

/** A text or code file's first lines, tabs as two spaces. */
export function textLines(text: string, count = LINES + 4) {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n", count)
    .map((line) => line.replace(/\t/g, "  "));
}

function parseDelimited(text: string, delimiter: string, maxRows: number) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const normalized = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < normalized.length && rows.length < maxRows; i += 1) {
    const ch = normalized[i] ?? "";
    if (quoted) {
      if (ch === '"' && normalized[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell.length === 0) {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      if (row.some((value) => value.trim().length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (rows.length < maxRows && (cell.length > 0 || row.length > 0)) {
    row.push(cell);
    if (row.some((value) => value.trim().length > 0)) rows.push(row);
  }
  return rows;
}

/** A CSV or TSV's top-left corner as rows of cells, for a card's grid. */
export function csvGrid(text: string, name: string) {
  const delimiter = /\.tsv$/i.test(name) ? "\t" : ",";
  return grid(parseDelimited(text, delimiter, ROWS));
}

/**
 * Rows as the card's grid: always `ROWS` by `COLUMNS`, more than the card shows, so a short
 * sheet still fills it with empty cells and a wide one runs off its edges.
 */
export function grid(rows: string[][]) {
  return Array.from({ length: ROWS }, (_row, r) =>
    Array.from({ length: COLUMNS }, (_col, c) => (rows[r]?.[c] ?? "").trim()),
  );
}

export type CodeTone = "keyword" | "string" | "comment" | "plain";

const KEYWORDS = new Set(
  `const let var function return export import from default if else for while do switch case
  break continue class interface type enum extends implements new this async await yield try
  catch finally throw def elif in is not and or lambda pass fn pub use mod impl struct func go
  package public private protected static void int string bool true false null undefined None
  True False nil self`.split(/\s+/),
);

const TOKEN =
  /(\/\/.*$|#.*$|\/\*.*?\*\/|"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`[^`]*`?|[A-Za-z_$][\w$]*)/g;

/**
 * A code line in tones a card colours: comments, strings and keywords. A guess good enough for a
 * thumbnail, not a grammar: `#` starts a comment only in languages that use it.
 */
export function codeTones(line: string, hashComments: boolean) {
  const out: { tone: CodeTone; text: string }[] = [];
  let at = 0;
  for (const match of line.matchAll(TOKEN)) {
    const text = match[0];
    const start = match.index;
    if (text.startsWith("#") && !hashComments) continue;
    if (start > at) out.push({ tone: "plain", text: line.slice(at, start) });
    const tone: CodeTone =
      text.startsWith("//") || text.startsWith("/*") || text.startsWith("#")
        ? "comment"
        : /^["'`]/.test(text)
          ? "string"
          : KEYWORDS.has(text)
            ? "keyword"
            : "plain";
    out.push({ tone, text });
    at = start + text.length;
  }
  if (at < line.length) out.push({ tone: "plain", text: line.slice(at) });
  return out;
}

const BARS = 28;

/** Deterministic waveform bar heights (0..100%) for an audio card, matching web's `AudioArt`. */
export function audioBars(seed: string) {
  let h = 2166136261;
  for (const char of seed) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  return Array.from({ length: BARS }, (_, i) => {
    h = Math.imul(h ^ (h >>> 15), 2246822507) ^ i;
    const noise = ((h >>> 0) % 1000) / 1000;
    const swell = Math.sin((i / (BARS - 1)) * Math.PI);
    return 18 + Math.round((0.35 + 0.65 * swell) * noise * 64);
  });
}
