import { STORAGE_ERROR_TEXT, errorText } from "@omni/client";
import { appToast } from "@/components/ui/toast";

/** Why `error` refused the action, or `fallback` ("The folder was not created"). */
export const storageErrorText = (error: unknown, fallback: string) =>
  errorText(STORAGE_ERROR_TEXT, error, fallback);

export function storageErrorToast(error: unknown, fallback: string) {
  appToast.error(storageErrorText(error, fallback));
}
