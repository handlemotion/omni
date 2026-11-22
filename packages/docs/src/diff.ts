import { diffArrays, diffWords } from "diff";
import { docSchema, docToMarkdown, markdownToDoc } from "./markdown.ts";

/** One top-level block of a doc, compared between two versions of it. */
export type BlockChange =
  | { kind: "same"; text: string }
  | { kind: "added"; text: string }
  | { kind: "removed"; text: string }
  | { kind: "moved"; text: string }
  | {
      kind: "changed";
      before: string;
      after: string;
      words: { value: string; added?: boolean; removed?: boolean }[];
    };

/** A doc's top-level blocks, each as the Markdown it is saved as. */
export function blocksOf(markdown: string) {
  const doc = markdownToDoc(markdown);
  const schema = docSchema();
  const blocks: string[] = [];
  doc.forEach((block) => {
    blocks.push(docToMarkdown(schema.topNodeType.create(null, [block])).trim());
  });
  return blocks;
}

const wordsOf = (text: string) => new Set(text.toLowerCase().split(/\W+/).filter(Boolean));

function likeness(a: string, b: string) {
  const [x, y] = [wordsOf(a), wordsOf(b)];
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const word of x) if (y.has(word)) shared++;
  return shared / Math.max(x.size, y.size);
}

const wordDiff = (before: string, after: string) =>
  diffWords(before, after).map(({ value, added, removed }) => ({
    value,
    ...(added ? { added: true } : {}),
    ...(removed ? { removed: true } : {}),
  }));

function unmatched(before: string[], after: string[]) {
  const same = new Map<number, number>();
  let [i, j] = [0, 0];
  for (const part of diffArrays(before, after)) {
    if (part.removed) i += part.count;
    else if (part.added) j += part.count;
    else for (let k = 0; k < part.count; k++) same.set(j++, i++);
  }
  return same;
}

/**
 * How `after` differs from `before`, block by block, in `after`'s order: blocks matched in
 * order are `same`; a block found unchanged elsewhere is `moved`; a block removed where a block
 * mostly like it was added is `changed`, with its words diffed; the rest are `added` or
 * `removed`, a removed block listed where it stood among the blocks kept.
 */
export function diffBlocks(before: string, after: string) {
  const [old, now] = [blocksOf(before), blocksOf(after)];
  const same = unmatched(old, now);
  const kept = new Set(same.values());
  const gone = old.map((text, i) => ({ text, i })).filter(({ i }) => !kept.has(i));
  const pairs = new Map<number, number>();
  const taken = new Set<number>();
  for (let j = 0; j < now.length; j++) {
    if (same.has(j)) continue;
    const exact = gone.find(({ text, i }) => text === now[j] && !taken.has(i));
    if (exact) {
      pairs.set(j, exact.i);
      taken.add(exact.i);
    }
  }
  for (let j = 0; j < now.length; j++) {
    if (same.has(j) || pairs.has(j)) continue;
    let best: { i: number; score: number } | null = null;
    for (const { text, i } of gone) {
      const score = taken.has(i) ? 0 : likeness(text, now[j]!);
      if (score >= 0.5 && score > (best?.score ?? 0)) best = { i, score };
    }
    if (best) {
      pairs.set(j, best.i);
      taken.add(best.i);
    }
  }
  const changes: BlockChange[] = [];
  let next = 0;
  const removedUpTo = (end: number) => {
    for (; next < end; next++) {
      if (!kept.has(next) && !taken.has(next)) changes.push({ kind: "removed", text: old[next]! });
    }
  };
  for (let j = 0; j < now.length; j++) {
    const text = now[j]!;
    const at = same.get(j);
    if (at !== undefined) {
      removedUpTo(at);
      next = at + 1;
      changes.push({ kind: "same", text });
      continue;
    }
    const from = pairs.get(j);
    if (from === undefined) changes.push({ kind: "added", text });
    else if (old[from] === text) changes.push({ kind: "moved", text });
    else
      changes.push({
        kind: "changed",
        before: old[from]!,
        after: text,
        words: wordDiff(old[from]!, text),
      });
  }
  removedUpTo(old.length);
  return changes;
}

/** How many blocks a diff added, removed and changed (a move counts as changed). */
export function blockCounts(changes: BlockChange[]) {
  const counts = { added: 0, removed: 0, changed: 0 };
  for (const change of changes) {
    if (change.kind === "added") counts.added++;
    else if (change.kind === "removed") counts.removed++;
    else if (change.kind === "changed" || change.kind === "moved") counts.changed++;
  }
  return counts;
}
