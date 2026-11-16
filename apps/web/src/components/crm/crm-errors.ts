// Every sentence a refused CRM request shows, keyed by the Worker's `code` (never the message's
// text). Anything else falls back to what the action was ("The deal was not moved").
import type { ErrorCode } from "@omni/client";
import { appToast } from "@/components/ui/toast";
import { ApiError } from "@/lib/api.ts";

const BY_CODE: Partial<Record<ErrorCode, string>> = {
  address_taken: "That address belongs to someone else",
  domain_taken: "That domain belongs to another company",
  webmail_domain: "A webmail domain can't belong to a company",
  stage_in_use: "A stage holding deals can't be removed",
  stage_kind_required: "Each kind needs at least one stage",
  invalid_currency: "That isn't a currency code",
  contract_signed: "A signed contract can't change that way",
  invalid_name: "That name can't be used",
  billing_inactive: "This workspace is read-only",
  forbidden: "You can't change this",
  not_found: "That's no longer here",
  locked: "That file is locked",
  rate_limited: "Too many at once. Try again in a minute",
};

/** Why `error` refused the action, or `fallback`. */
export function crmErrorText(error: unknown, fallback: string) {
  const code = error instanceof ApiError ? error.code : undefined;
  return (code && BY_CODE[code as ErrorCode]) || fallback;
}

export function crmErrorToast(error: unknown, fallback: string) {
  appToast.error(crmErrorText(error, fallback));
}
