import { baseMimeType, STORAGE_DOC_TYPE } from "@omni/contracts/storage-types";

/**
 * An Omni doc's type. Its body is Markdown, so search, agents, history and sync read it as text,
 * but it is a doc of its own: named without an extension, shown and opened as a page.
 */
export {
  opensAsDoc as isDocFile,
  STORAGE_DOC_TYPE as DOC_TYPE,
} from "@omni/contracts/storage-types";

/** Whether a file is an Omni doc made in Omni (not a Markdown file someone uploaded). */
export const isOmniDoc = (mimeType: string | null | undefined) =>
  baseMimeType(mimeType) === STORAGE_DOC_TYPE;
