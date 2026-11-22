/**
 * An Omni sheet's type. Its body is JSON Lines (`format.ts`), so search, agents, history and sync
 * read it as text, but it is a sheet of its own: named without an extension, opened as a grid.
 */
export const SHEET_TYPE = "text/vnd.omni.sheet";

const baseType = (mimeType: string | null | undefined) =>
  mimeType?.split(";")[0]?.trim().toLowerCase() ?? "";

/** Whether a file is an Omni sheet. */
export const isOmniSheet = (mimeType: string | null | undefined) =>
  baseType(mimeType) === SHEET_TYPE;
