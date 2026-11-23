import type { ErrorCode } from "@omni/contracts/errors";
import { errorCode } from "./call.ts";

/** What each refusal says, by its code. */
export type ErrorTextTable = Partial<Record<ErrorCode, string>>;

const COMMON: ErrorTextTable = {
  billing_inactive: "This workspace is read-only",
  invalid_name: "That name can't be used",
  invalid_email: "That isn't an email address",
  forbidden: "You can't change this",
  not_found: "That's no longer here",
  locked: "That file is locked",
  rate_limited: "Too many at once. Try again in a minute",
};

export const CRM_ERROR_TEXT: ErrorTextTable = {
  ...COMMON,
  address_taken: "That address belongs to someone else",
  domain_taken: "That domain belongs to another company",
  webmail_domain: "A webmail domain can't belong to a company",
  stage_in_use: "A stage holding deals can't be removed",
  stage_kind_required: "Each kind needs at least one stage",
  invalid_currency: "That isn't a currency code",
  contract_signed: "A signed contract can't change that way",
  sharing_policy: "Drive's sharing settings don't allow that",
};

export const STORAGE_ERROR_TEXT: ErrorTextTable = {
  ...COMMON,
  storage_full: "Storage is full",
  file_too_large: "That file is too large",
  name_taken: "That name is taken",
  too_deep: "Folders can't nest that deep",
  cycle: "A folder can't move into itself",
  parent_trashed: "Its folder is in Trash",
  sharing_policy: "Your workspace's sharing policy doesn't allow that",
  wrong_password: "That password isn't right",
  not_empty: "Move its files out or to Trash first",
  last_owner: "A space needs an owner",
  not_in_workspace: "Only members of the workspace can be added",
};

/** Why `error` refused the action, in `table`'s words, or `fallback` ("It was not renamed"). */
export function errorText(table: ErrorTextTable, error: unknown, fallback: string) {
  const code = errorCode(error);
  return (code && table[code as ErrorCode]) || fallback;
}

const FINAL_UPLOAD_CODES: ReadonlySet<string> = new Set<ErrorCode | "identity_changed">([
  "storage_full",
  "billing_inactive",
  "file_too_large",
  "locked",
  "identity_changed",
]);

/**
 * Whether trying an upload again may work: anything but a refusal that would repeat. A lost
 * connection or a server error carries no code, and resumes from the parts already stored.
 */
export function canRetryUpload(error: unknown) {
  const code = errorCode(error);
  return !code || !FINAL_UPLOAD_CODES.has(code);
}
