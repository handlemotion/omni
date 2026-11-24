import { baseMimeType, STORAGE_CANVAS_TYPE } from "@omni/contracts/storage-types";

/**
 * A Wok canvas's type. Its body is a JSON scene, so search, agents, history and sync read it as
 * text, but it is a board of its own: named without an extension, opened in its own editor.
 */
export { STORAGE_CANVAS_TYPE as CANVAS_TYPE } from "@omni/contracts/storage-types";

export const isOmniCanvas = (mimeType: string | null | undefined) =>
  baseMimeType(mimeType) === STORAGE_CANVAS_TYPE;
