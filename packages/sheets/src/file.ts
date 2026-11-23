import { baseMimeType, STORAGE_SHEET_TYPE } from "@omni/contracts/storage-types";

/**
 * An Omni sheet's type. Its body is JSON Lines (`format.ts`), so search, agents, history and sync
 * read it as text, but it is a sheet of its own: named without an extension, opened as a grid.
 */
export { STORAGE_SHEET_TYPE as SHEET_TYPE } from "@omni/contracts/storage-types";

export const isOmniSheet = (mimeType: string | null | undefined) =>
  baseMimeType(mimeType) === STORAGE_SHEET_TYPE;
