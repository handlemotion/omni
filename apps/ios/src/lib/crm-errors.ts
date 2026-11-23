import { CRM_ERROR_TEXT, errorText } from "@omni/client";
import { Alert } from "react-native";

/** Why `error` refused the action, or `fallback`. */
export const crmErrorText = (error: unknown, fallback: string) =>
  errorText(CRM_ERROR_TEXT, error, fallback);

export function crmErrorAlert(error: unknown, fallback: string) {
  Alert.alert(crmErrorText(error, fallback));
}
