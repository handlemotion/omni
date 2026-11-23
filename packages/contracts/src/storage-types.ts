/** A MIME type without its parameters, lowercased; empty when there is none. */
export const baseMimeType = (mimeType: string | null | undefined) =>
  mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";

/** Omni's own page types: named without an extension, opened in their own editor. */
export const STORAGE_DOC_TYPE = "text/vnd.omni.doc";
export const STORAGE_CANVAS_TYPE = "text/vnd.omni.canvas";
export const STORAGE_SHEET_TYPE = "text/vnd.omni.sheet";
/** A Markdown file's name, which opens as a doc too: a regex both JS and Postgres (`~*`) read. */
export const STORAGE_MARKDOWN_NAME = "\\.(md|markdown)$";
const markdownName = new RegExp(STORAGE_MARKDOWN_NAME, "i");

/** Whether a file opens as a doc: an Omni doc, or a Markdown file. */
export const opensAsDoc = (name: string, mimeType: string | null | undefined) =>
  baseMimeType(mimeType) === STORAGE_DOC_TYPE || markdownName.test(name);

/** How many records an editor lets pass after the latest `seed` or `snap` before it writes one. */
export const STORAGE_LIVE_SNAP_EVERY = 200;

/** The longest `doc.presence` update, base64: one person's cursor and name, with room to spare. */
export const STORAGE_DOC_PRESENCE_MAX = 4096;
