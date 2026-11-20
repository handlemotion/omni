import type { ErrorCode } from "@omni/client";
import { appToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api.ts";

const BY_CODE: Partial<Record<ErrorCode, string>> = {
  storage_full: "Storage is full",
  billing_inactive: "This workspace is read-only",
  file_too_large: "That file is too large",
  invalid_name: "That name can't be used",
  name_taken: "That name is taken",
  forbidden: "You can't change this",
  not_found: "That's no longer here",
  too_deep: "Folders can't nest that deep",
  cycle: "A folder can't move into itself",
  parent_trashed: "Its folder is in Trash",
  invalid_email: "That isn't an email address",
  locked: "That file is locked",
  rate_limited: "Too many at once. Try again in a minute",
  sharing_policy: "Your workspace's sharing policy doesn't allow that",
  wrong_password: "That password isn't right",
};

const FINAL = new Set<string>([
  "storage_full",
  "billing_inactive",
  "file_too_large",
  "locked",
  "identity_changed",
]);

const codeOf = (error: unknown) => {
  if (error instanceof ApiError) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
};

/** Why `error` refused the action, or `fallback` ("The folder was not created"). */
export function storageErrorText(error: unknown, fallback: string) {
  const code = codeOf(error);
  return (code && BY_CODE[code as ErrorCode]) || fallback;
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
