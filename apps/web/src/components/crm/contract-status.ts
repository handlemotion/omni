import { contractStatus, type CrmContract } from "@omni/client";

type Intent = "secondary" | "info" | "success" | "warning" | "outline";

const INTENT: Record<string, Intent> = {
  Draft: "secondary",
  Sent: "info",
  "Out for signature": "info",
  Signed: "success",
  Ended: "outline",
};

/** The badge a contract shows: its status word, coloured; "Ends …" is a warning. */
export function contractBadge(contract: CrmContract) {
  const label = contractStatus(contract);
  return { label, intent: INTENT[label] ?? "warning" };
}
