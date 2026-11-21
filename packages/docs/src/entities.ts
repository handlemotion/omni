const NAMED: Record<string, string> = {
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  euro: "€",
  times: "×",
  iexcl: "¡",
  iquest: "¿",
  shy: "­",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
};

const CODE_OR_ENTITY = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`+[^`\n]*`+)|&([a-zA-Z]{2,8});/g;

/**
 * Markdown with its named HTML entities (`&nbsp;`, `&mdash;`) turned into the characters they
 * name, outside code, so a doc shows them as text and saves them as characters. Tiptap's reader
 * decodes only `&amp;`, `&lt;`, `&gt;`, `&quot;` and numeric ones, and escapes the rest into
 * `&amp;nbsp;`; those it decodes are left for it, since `&lt;` must not become a tag.
 */
export function readableMarkdown(markdown: string) {
  return markdown.replace(CODE_OR_ENTITY, (whole, code: string | undefined, name: string) =>
    code ? whole : (NAMED[name] ?? whole),
  );
}
