import { Buffer } from "node:buffer";
import type { AddressObject, EmailAddress, HeaderLines, ParsedMail } from "mailparser";
import { simpleParser } from "mailparser";

export interface Address {
  name: string;
  /** Lowercased. */
  address: string;
}

export interface AttachmentMeta {
  filename: string | null;
  mimeType: string;
  size: number;
  /** Content-ID without angle brackets, for mapping `cid:` references in the HTML. */
  contentId: string | null;
  /** Shown in the body (cid image), not as a chip. */
  inline: boolean;
}

/** Headers triage reads as signals. */
export interface TriageSignals {
  listId: string | null;
  /** URIs from List-Unsubscribe, angle brackets removed. */
  listUnsubscribe: string[];
  /** RFC 8058 one-click unsubscribe is offered. */
  listUnsubscribeOneClick: boolean;
  precedence: string | null;
  autoSubmitted: string | null;
  /** The From display name claims another sender or hides characters. A hint, not proof. */
  displayNameSpoof: DisplayNameSpoof | null;
}

export interface DisplayNameSpoof {
  /**
   * `address`: the name shows an email address other than the sender's.
   * `domain`: the name shows a domain unrelated to the sender's.
   * `invisible`: the name holds invisible or bidi-control characters.
   */
  kind: "address" | "domain" | "invisible";
  /** The address or domain the name shows, or the hidden code points as `U+XXXX`. */
  claimed: string;
}

export interface ParsedMessage {
  /** In `<id@host>` form. Synthesized from a header hash when the message has none. */
  messageId: string;
  messageIdSynthesized: boolean;
  inReplyTo: string | null;
  /** Oldest first, as in the header. */
  references: string[];
  from: Address | null;
  to: Address[];
  cc: Address[];
  replyTo: Address[];
  subject: string;
  sentAt: Date | null;
  text: string | null;
  html: string | null;
  attachments: AttachmentMeta[];
  signals: TriageSignals;
  /**
   * Set when the MIME structure broke the parser's limits (over 1 MB of headers in one part,
   * or over 1,000 parts). Only the top-level headers were read; there is no body or attachment.
   */
  bodySkipped?: true;
}

export interface ParseResult {
  message: ParsedMessage;
  /** `attachmentContents[i]` is the content of `message.attachments[i]`. */
  attachmentContents: Uint8Array[];
}

const PARSER_OPTIONS = {
  // Keep `cid:` links so the sanitizer can map them to attachment ids, and leave `text`
  // empty for HTML-only mail so reply stripping knows to work on the HTML.
  keepCidLinks: true,
  skipHtmlToText: true,
  skipTextToHtml: true,
  skipImageLinks: true,
} as const;

/**
 * Parses raw RFC 5322 bytes into plain data. Message bodies are decoded to UTF-8, and NUL
 * characters are removed from every string (Postgres text cannot store them).
 */
export async function parseMessage(raw: Uint8Array | string): Promise<ParseResult> {
  const source =
    typeof raw === "string" ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.length);
  let mail: ParsedMail;
  let bodySkipped = false;
  try {
    mail = await simpleParser(source, PARSER_OPTIONS);
  } catch (error) {
    // mailparser's guards against header and MIME-tree bombs. Keep the message listable
    // from its main headers rather than failing it on every sync.
    if ((error as { code?: unknown }).code !== "EMAXLEN") throw error;
    mail = await simpleParser(topHeaders(source), PARSER_OPTIONS);
    bodySkipped = true;
  }

  const headerId = firstMessageId(mail.messageId);
  const from = addresses(mail.from)[0] ?? null;
  const message: ParsedMessage = {
    messageId: headerId ?? (await synthesizeMessageId(mail.headerLines, mail.text, mail.html)),
    messageIdSynthesized: headerId === null,
    inReplyTo: firstMessageId(mail.inReplyTo),
    references: capReferences(messageIds(mail.references)),
    from,
    to: addresses(mail.to),
    cc: addresses(mail.cc),
    replyTo: addresses(mail.replyTo),
    subject: mail.subject ?? "",
    sentAt: mail.date && !Number.isNaN(mail.date.getTime()) ? mail.date : null,
    text: mail.text || null,
    html: mail.html || null,
    attachments: mail.attachments.map((a) => ({
      filename: a.filename ?? null,
      mimeType: a.contentType,
      size: a.size,
      contentId: a.cid ?? null,
      inline: a.contentDisposition === "inline" || (a.related === true && a.cid !== undefined),
    })),
    signals: { ...signals(mail.headerLines), displayNameSpoof: displayNameSpoof(from) },
  };
  if (bodySkipped) message.bodySkipped = true;

  return {
    message: withoutNul(message),
    attachmentContents: mail.attachments.map((a) => new Uint8Array(a.content)),
  };
}

/** Postgres text rejects U+0000, and mail carries it in subjects, bodies and filenames. */
function withoutNul<T>(value: T): T {
  if (typeof value === "string") {
    return (value.includes("\0") ? value.replaceAll("\0", "") : value) as T;
  }
  if (Array.isArray(value)) return value.map(withoutNul) as T;
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, withoutNul(entry)]),
    ) as T;
  }
  return value;
}

// Header fields the rest of the pipeline reads; the fallback parse keeps only these.
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
  "auto-submitted",
]);
const MAX_TOP_HEADER = 16 * 1024;

/** The top-level header block cut down to `TOP_HEADERS`, each field capped, with no body. */
function topHeaders(source: string | Buffer): Buffer {
  const bytes = typeof source === "string" ? Buffer.from(source) : source;
  const ends = [bytes.indexOf("\r\n\r\n"), bytes.indexOf("\n\n")].filter((i) => i !== -1);
  // latin1 maps bytes to code units one to one, so 8-bit header bytes survive the round trip.
  const head = bytes.subarray(0, Math.min(bytes.length, ...ends)).toString("latin1");
  const fields = head
    .split(/\r?\n(?![ \t])/)
    .filter((field) => TOP_HEADERS.has(field.slice(0, field.indexOf(":")).trim().toLowerCase()))
    .map((field) => field.slice(0, MAX_TOP_HEADER));
  return Buffer.from(`${fields.join("\r\n")}\r\n\r\n`, "latin1");
}

// RFC 5322 3.6.4 lets senders trim References to the first and the most recent ids;
// threading only needs those, and a hostile header can carry tens of thousands.
const MAX_REFERENCES = 100;

function capReferences(ids: string[]): string[] {
  if (ids.length <= MAX_REFERENCES) return ids;
  return [...ids.slice(0, 1), ...ids.slice(-(MAX_REFERENCES - 1))];
}

// Zero-width, bidi-control and filler characters that render as nothing.
const INVISIBLE =
  /[\u{AD}\u{61C}\u{115F}\u{1160}\u{17B4}\u{17B5}\u{180E}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{206F}\u{3164}\u{FEFF}\u{FFA0}]|\u{34F}/gu;
const ADDRESS_IN_NAME = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[^\s@<>"'(),;:]+/;
const DOMAIN_TOKEN = /^(?:[\p{L}\p{N}-]+\.)+\p{L}[\p{L}\p{N}-]{1,62}$/u;
const MAX_CHECKED_NAME = 256;

/** Spoofing hint for a From address: see `DisplayNameSpoof`. */
export function displayNameSpoof(from: Address | null): DisplayNameSpoof | null {
  if (from === null || from.name === "" || from.name.length > MAX_CHECKED_NAME) return null;
  const hidden = from.name.match(INVISIBLE);
  if (hidden) {
    const codes = [...new Set(hidden)].map(
      (char) => `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`,
    );
    return { kind: "invisible", claimed: codes.join(" ") };
  }
  const claimedAddress = ADDRESS_IN_NAME.exec(from.name)?.[0].toLowerCase();
  if (claimedAddress !== undefined) {
    return claimedAddress === from.address ? null : { kind: "address", claimed: claimedAddress };
  }
  const senderDomain = domainOf(from.address);
  for (const token of from.name.split(/\s+/)) {
    const domain = token.replace(/^[("'[]+|[)"'\],.:;!?]+$/g, "");
    if (!DOMAIN_TOKEN.test(domain)) continue;
    const claimed = domainOf(`x@${domain}`);
    if (claimed === null || senderDomain === null) continue;
    const related =
      claimed === senderDomain ||
      senderDomain.endsWith(`.${claimed}`) ||
      claimed.endsWith(`.${senderDomain}`);
    if (!related) return { kind: "domain", claimed };
  }
  return null;
}

/** Lowercased, punycoded domain of an address, or null when it is not a valid host. */
function domainOf(address: string): string | null {
  const domain = address.slice(address.lastIndexOf("@") + 1);
  try {
    return new URL(`http://${domain}`).hostname;
  } catch {
    return null;
  }
}

const MESSAGE_ID = /<[^<>\s]+>/g;

function messageIds(value: string | string[] | undefined): string[] {
  const joined = Array.isArray(value) ? value.join(" ") : (value ?? "");
  const bracketed = joined.match(MESSAGE_ID);
  if (bracketed) return [...new Set(bracketed)];
  // Some senders omit the angle brackets.
  return [...new Set(joined.split(/\s+/).filter((id) => id.includes("@")))].map((id) => `<${id}>`);
}

function firstMessageId(value: string | undefined): string | null {
  return messageIds(value)[0] ?? null;
}

function addresses(value: AddressObject | AddressObject[] | undefined): Address[] {
  if (!value) return [];
  const flat = (list: EmailAddress[]): EmailAddress[] =>
    list.flatMap((entry) => (entry.group ? flat(entry.group) : [entry]));
  return (Array.isArray(value) ? value : [value])
    .flatMap((object) => flat(object.value))
    .filter((entry): entry is EmailAddress & { address: string } => Boolean(entry.address))
    .map((entry) => ({ name: entry.name, address: entry.address.toLowerCase() }));
}

function header(lines: HeaderLines, key: string): string | null {
  const line = lines.find((entry) => entry.key === key)?.line;
  if (line === undefined) return null;
  return line
    .slice(line.indexOf(":") + 1)
    .replace(/\r?\n[ \t]+/g, " ")
    .trim();
}

function signals(lines: HeaderLines): Omit<TriageSignals, "displayNameSpoof"> {
  const unsubscribe = header(lines, "list-unsubscribe");
  return {
    listId: header(lines, "list-id"),
    listUnsubscribe: [...(unsubscribe ?? "").matchAll(/<([^<>]+)>/g)].map((m) => m[1] ?? ""),
    listUnsubscribeOneClick: /List-Unsubscribe=One-Click/i.test(
      header(lines, "list-unsubscribe-post") ?? "",
    ),
    precedence: header(lines, "precedence")?.toLowerCase() ?? null,
    autoSubmitted: header(lines, "auto-submitted")?.toLowerCase() ?? null,
  };
}

// The spec keys messages on (mailbox, Message-ID), so a missing one is replaced by a hash
// that is stable across re-syncs of the same raw bytes. The body is included so two
// header-identical automated messages do not collapse into one.
async function synthesizeMessageId(
  lines: HeaderLines,
  text: string | undefined,
  html: string | false | undefined,
): Promise<string> {
  const keyHeaders = ["from", "to", "cc", "date", "subject"]
    .map((key) => `${key}:${header(lines, key) ?? ""}`)
    .join("\n");
  const input = `${keyHeaders}\n\n${text ?? ""}\n\n${html || ""}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `<${hex.slice(0, 40)}@omni.invalid>`;
}
