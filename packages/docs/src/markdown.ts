import { getSchema, resolveExtensions, type JSONContent } from "@tiptap/core";
import { MarkdownManager } from "@tiptap/markdown";
import { Node as PmNode, type Schema } from "@tiptap/pm/model";
import { readableMarkdown } from "./entities.ts";
import { docExtensions } from "./schema.ts";

let made: { schema: Schema; markdown: MarkdownManager } | undefined;

const tools = () => {
  made ??= {
    schema: getSchema(docExtensions({ history: false })),
    markdown: new MarkdownManager({
      extensions: resolveExtensions(docExtensions({ history: false })),
    }),
  };
  return made;
};

/** The schema every doc is made of. */
export const docSchema = () => tools().schema;

/** A doc from its Markdown, as the editor reads it. */
export function markdownToDoc(markdown: string) {
  const { schema, markdown: manager } = tools();
  const json: JSONContent = manager.parse(readableMarkdown(markdown));
  return PmNode.fromJSON(schema, json);
}

/** A doc's Markdown, as the editor writes it. */
export function docToMarkdown(doc: PmNode) {
  return tools().markdown.serialize(doc.toJSON() as JSONContent);
}
