import { Buffer } from "node:buffer";
import type { AddressObject, EmailAddress, HeaderLines } from "mailparser";
import { AUTOMATED_HEADERS } from "../automated.ts";
import type { Address, TriageSignals } from "../parse.ts";

const TOP_HEADERS = new Set([
  "from",
  "to",
  "cc",
  "reply-to",
  "subject",
  "date",
  "message-id",
  "in-reply-to",
  "references",
  "list-id",
  "list-unsubscribe",
  "list-unsubscribe-post",
  "precedence",
  ...AUTOMATED_HEADERS,
]);
const MAX_TOP_HEADER = 16 * 1024;

/** Only the top-level headers Omni reads, for a message whose MIME structure broke the parser. */
export const topHeaders: (source: string | Buffer) => Buffer = (source) => {
  const bytes = typeof source === "string" ? Buffer.from(source) : source;
  const ends = [bytes.indexOf("\r\n\r\n"), bytes.indexOf("\n\n")].filter((i) => i !== -1);
  const head = bytes.subarray(0, Math.min(bytes.length, ...ends)).toString("latin1");
  const fields = head
    .split(/\r?\n(?![ \t])/)
    .filter((field) => TOP_HEADERS.has(field.slice(0, field.indexOf(":")).trim().toLowerCase()))
    .map((field) => field.slice(0, MAX_TOP_HEADER));
  return Buffer.from(`${fields.join("\r\n")}\r\n\r\n`, "latin1");
};

export const addresses: (value: AddressObject | AddressObject[] | undefined) => Address[] = (
  value,
) => {
  if (!value) return [];
  const flat: (list: EmailAddress[]) => EmailAddress[] = (list) =>
    list.flatMap((entry) => (entry.group ? flat(entry.group) : [entry]));
  return (Array.isArray(value) ? value : [value])
    .flatMap((object) => flat(object.value))
    .filter((entry): entry is EmailAddress & { address: string } => Boolean(entry.address))
    .map((entry) => ({ name: entry.name, address: entry.address.toLowerCase() }));
};

/** One header's unfolded value, or null when it is absent. */
export function header(lines: HeaderLines, key: string) {
  const line = lines.find((entry) => entry.key === key)?.line;
  if (line === undefined) return null;
  return line
    .slice(line.indexOf(":") + 1)
    .replace(/\r?\n[ \t]+/g, " ")
    .trim();
}

export function signals(lines: HeaderLines) {
  const unsubscribe = header(lines, "list-unsubscribe");
  return {
    listId: header(lines, "list-id"),
    listUnsubscribe: [...(unsubscribe ?? "").matchAll(/<([^<>]+)>/g)].map((m) => m[1] ?? ""),
    listUnsubscribeOneClick: /List-Unsubscribe=One-Click/i.test(
      header(lines, "list-unsubscribe-post") ?? "",
    ),
    precedence: header(lines, "precedence")?.toLowerCase() ?? null,
    autoSubmitted: header(lines, "auto-submitted")?.toLowerCase() ?? null,
  } satisfies Omit<TriageSignals, "displayNameSpoof">;
}
