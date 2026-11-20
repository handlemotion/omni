import type { CrmContract } from "@/lib/crm.ts";
import { DAY } from "./record-list.tsx";

type Intent = "secondary" | "info" | "success" | "warning" | "outline";

/** Days before its end date that a signed contract shows it is ending. */
export const ENDING_SOON_DAYS = 30;

const MS_PER_DAY = 86_400_000;

const day = (date: string) => DAY.format(new Date(`${date}T00:00:00`));

/** Whole days from today (local) until `date`, `YYYY-MM-DD`. */
export function daysUntil(date: string, now = new Date()) {
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((Date.parse(`${date}T00:00:00Z`) - today) / MS_PER_DAY);
}

/** The badge a contract shows: its status, how far signing got, or that it ends soon. */
export function contractBadge(contract: CrmContract) {
  const signing = contract.signing;
  if (contract.status === "sent" && signing?.status === "completed") {
    return { label: "Signed", intent: "success" } satisfies { label: string; intent: Intent };
  }
  if (contract.status === "sent" && signing) {
    return { label: "Out for signature", intent: "info" } satisfies {
      label: string;
      intent: Intent;
    };
  }
  if (contract.status === "signed" && contract.expiresOn) {
    const left = daysUntil(contract.expiresOn);
    if (left <= ENDING_SOON_DAYS) {
      const label =
        left <= 0 ? "Ends today" : left === 1 ? "Ends tomorrow" : `Ends in ${left} days`;
      return { label, intent: "warning" } satisfies { label: string; intent: Intent };
    }
  }
  const STATUS = {
    draft: { label: "Draft", intent: "secondary" },
    sent: { label: "Sent", intent: "info" },
    signed: { label: "Signed", intent: "success" },
    ended: { label: "Ended", intent: "outline" },
  } satisfies Record<CrmContract["status"], { label: string; intent: Intent }>;
  return STATUS[contract.status];
}

/** "1 of 2 signed" while out for signature, else its dates; null when it has neither. */
export function contractLine(contract: CrmContract) {
  const signing = contract.signing;
  if (contract.status === "sent" && signing?.status === "sent") {
    const signed = signing.signers.filter((signer) => signer.signedAt).length;
    return `${signed} of ${signing.signers.length} signed`;
  }
  return contractDates(contract);
}

export function contractDates(contract: CrmContract) {
  const dates = [
    contract.effectiveOn && `From ${day(contract.effectiveOn)}`,
    contract.expiresOn && `${contract.effectiveOn ? "until" : "Until"} ${day(contract.expiresOn)}`,
  ].filter(Boolean);
  return dates.length ? dates.join(" ") : null;
}
