/**
 * An Omni doc's type. Its body is Markdown, so search, agents, history and sync read it as text,
 * but it is a doc of its own: named without an extension, shown and opened as a page.
 */
export const DOC_TYPE = "text/vnd.omni.doc";

const baseType = (mimeType: string | null | undefined) =>
  mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";

/** Whether a file is an Omni doc made in Omni (not a Markdown file someone uploaded). */
export const isOmniDoc = (mimeType: string | null | undefined) => baseType(mimeType) === DOC_TYPE;

/** Whether a file opens as a doc: an Omni doc, or a Markdown file, which opens as one too. */
export const isDocFile = (name: string, mimeType: string | null | undefined) =>
  isOmniDoc(mimeType) || /\.(md|markdown)$/i.test(name);
