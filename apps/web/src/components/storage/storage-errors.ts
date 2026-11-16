// Every sentence a refused Storage request shows, in one place, keyed by the Worker's `code`
// (never by HTTP status or the message's text). Anything without a code that this list knows
// falls back to what the action was ("It was not renamed").
import { appToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api.ts";

const BY_CODE: Record<string, string> = {
  STORAGE_FULL: "Storage is full",
  BILLING_INACTIVE: "This workspace is read-only",
  FILE_TOO_LARGE: "That file is too large",
  INVALID_NAME: "That name can't be used",
  NAME_TAKEN: "That name is taken",
  FORBIDDEN: "You can't change this",
  NOT_FOUND: "That's no longer here",
  TOO_DEEP: "Folders can't nest that deep",
  CYCLE: "A folder can't move into itself",
  PARENT_TRASHED: "Its folder is in Trash",
  INVALID_EMAIL: "That isn't an email address",
};

/** Refusals that would only repeat: an upload that met one offers no Retry. */
const FINAL = new Set(["STORAGE_FULL", "BILLING_INACTIVE", "FILE_TOO_LARGE"]);

const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : undefined);

/** Why `error` refused the action, or `fallback` ("The folder was not created"). */
export function storageErrorText(error: unknown, fallback: string) {
  const code = codeOf(error);
  return (code && BY_CODE[code]) || fallback;
}

export function storageErrorToast(error: unknown, fallback: string) {
  appToast.error(storageErrorText(error, fallback));
}

/**
 * Whether trying an upload again may work: anything but a refusal that would repeat. A lost
 * connection or a server error carries no code, and resumes from the parts already stored.
 */
export function canRetryUpload(error: unknown) {
  const code = codeOf(error);
  return !code || !FINAL.has(code);
}
