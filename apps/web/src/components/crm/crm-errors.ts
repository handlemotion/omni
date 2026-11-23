import { CRM_ERROR_TEXT, errorText } from "@omni/client";
import { appToast } from "@/components/ui/toast";

/** Why `error` refused the action, or `fallback`. */
export const crmErrorText = (error: unknown, fallback: string) =>
  errorText(CRM_ERROR_TEXT, error, fallback);

export function crmErrorToast(error: unknown, fallback: string) {
  appToast.error(crmErrorText(error, fallback));
}
