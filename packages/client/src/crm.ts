import type { CrmContract, CrmStageKind, CrmTask } from "./api.ts";

export type CrmRecordKind = "companies" | "people" | "deals";

/** The stage kinds a project's deal sits in: projects are deals in an open or won stage. */
export const PROJECT_KINDS: readonly CrmStageKind[] = ["open", "won"];

/** "€12,500": minor units in their currency, whole units when there are no cents. */
export function formatMoney(minor: number | null, currency: string | null) {
  if (minor === null) return null;
  const amount = minor / 100;
  if (!currency) return new Intl.NumberFormat(undefined).format(amount);
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

/** "12500.50" or "12,500" typed by a person, as minor units; null when it is not a number. */
export function parseMoney(text: string) {
  const cleaned = text.replace(/[^\d.,-]/g, "").replace(/,(?=\d{3}(\D|$))/g, "");
  if (!cleaned) return null;
  const value = Number(cleaned.replace(",", "."));
  return Number.isFinite(value) ? Math.round(value * 100) : null;
}

/** The tasks-list filter for a record's own tasks. */
export const recordFilter = (kind: CrmRecordKind, id: string) =>
  kind === "companies" ? { company: id } : kind === "people" ? { person: id } : { deal: id };

/** The record fields of a new task on `kind`/`id`. */
export const onRecord = (kind: CrmRecordKind, id: string) =>
  kind === "companies" ? { companyId: id } : kind === "people" ? { personId: id } : { dealId: id };

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` in this device's time zone, for a date input. */
export function dayOf(iso: string | null) {
  if (!iso) return "";
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A picked day as the moment the API stores: the end of that day here. */
export function dueAtOf(day: string) {
  if (!day) return null;
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year!, month! - 1, date!, 23, 59, 59, 999).toISOString();
}

export type DueGroup = "overdue" | "today" | "upcoming" | "none";

export const DUE_GROUPS: { id: DueGroup; label: string }[] = [
  { id: "overdue", label: "Overdue" },
  { id: "today", label: "Today" },
  { id: "upcoming", label: "Upcoming" },
  { id: "none", label: "No due date" },
];

/** Where an open task falls by its due time, in this device's day. */
export function dueGroup(task: Pick<CrmTask, "dueAt">, now = new Date()) {
  let group: DueGroup = "upcoming";
  if (!task.dueAt) group = "none";
  else if (new Date(task.dueAt) < now) group = "overdue";
  else if (dayOf(task.dueAt) === dayOf(now.toISOString())) group = "today";
  return group;
}

/**
 * The due time a task takes when dropped on `group`: the end of today, of tomorrow, or none.
 * Undefined when the drop changes nothing: an open task can't be moved into Overdue, and a task
 * already in the group keeps its own day.
 */
export function dueOnDrop(task: Pick<CrmTask, "dueAt">, group: DueGroup, now = new Date()) {
  if (group === "overdue" || dueGroup(task, now) === group) return undefined;
  if (group === "none") return null;
  const day = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + (group === "today" ? 0 : 1),
    12,
  );
  return dueAtOf(dayOf(day.toISOString()));
}

const SHORT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const LONG = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** "Today", "Tomorrow", "Yesterday", "Mar 4", or with the year when it isn't this year. */
export function dueLabel(iso: string | null, now = new Date()) {
  if (!iso) return null;
  const day = dayOf(iso);
  const shifted = (days: number) =>
    dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 12).toISOString());
  if (day === shifted(0)) return "Today";
  if (day === shifted(1)) return "Tomorrow";
  if (day === shifted(-1)) return "Yesterday";
  const date = new Date(iso);
  return (date.getFullYear() === now.getFullYear() ? SHORT : LONG).format(date);
}

/** Days before its end date that a signed contract shows it is ending. */
export const ENDING_SOON_DAYS = 30;

const contractDay = (date: string) => LONG.format(new Date(`${date}T00:00:00`));

/** Whole days from today (local) until `date`, `YYYY-MM-DD`. */
export function daysUntil(date: string, now = new Date()) {
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((Date.parse(`${date}T00:00:00Z`) - today) / 86_400_000);
}

const CONTRACT_STATUS = {
  draft: "Draft",
  sent: "Sent",
  signed: "Signed",
  ended: "Ended",
} as const satisfies Record<CrmContract["status"], string>;

/** A contract's status word: its status, how far signing got, or that it ends soon. */
export function contractStatus(contract: CrmContract) {
  const signing = contract.signing;
  if (contract.status === "sent" && signing?.status === "completed") return "Signed";
  if (contract.status === "sent" && signing) return "Out for signature";
  if (contract.status === "signed" && contract.expiresOn) {
    const left = daysUntil(contract.expiresOn);
    if (left <= 0) return "Ends today";
    if (left === 1) return "Ends tomorrow";
    if (left <= ENDING_SOON_DAYS) return `Ends in ${left} days` as const;
  }
  return CONTRACT_STATUS[contract.status];
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

/** "From Nov 1, 2026 until Oct 31, 2027", or the one end it has; null when it has neither. */
export function contractDates(contract: CrmContract) {
  const dates = [
    contract.effectiveOn && `From ${contractDay(contract.effectiveOn)}`,
    contract.expiresOn &&
      `${contract.effectiveOn ? "until" : "Until"} ${contractDay(contract.expiresOn)}`,
  ].filter(Boolean);
  return dates.length ? dates.join(" ") : null;
}

/** Signed outside Omni and still without its signed copy, or about to be. */
export const takesSignedCopy = (contract: CrmContract) =>
  !contract.signedNodeId && !(contract.status === "sent" && contract.signing);
