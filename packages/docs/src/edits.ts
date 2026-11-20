/** One change to a doc's Markdown: `find` occurs exactly once and becomes `replace`. */
export interface TextEdit {
  find: string;
  replace: string;
}

export type EditResult = { ok: true; markdown: string } | { ok: false; error: string };

const count = (text: string, words: string) => {
  let n = 0;
  for (let i = text.indexOf(words); i !== -1; i = text.indexOf(words, i + 1)) n++;
  return n;
};

/** Applies the edits in order, each to the text the one before it left; all of them or none. */
export function applyEdits(markdown: string, edits: TextEdit[]) {
  let text = markdown;
  for (const [index, edit] of edits.entries()) {
    const n = edit.find ? count(text, edit.find) : 0;
    if (n !== 1) {
      const why = n === 0 ? "is not in the doc" : `is in the doc ${n} times`;
      const result: EditResult = {
        ok: false,
        error: `Edit ${index + 1}: its \`find\` text ${why}. Quote a passage that occurs exactly once.`,
      };
      return result;
    }
    text = text.replace(edit.find, () => edit.replace);
  }
  const result: EditResult = { ok: true, markdown: text };
  return result;
}
