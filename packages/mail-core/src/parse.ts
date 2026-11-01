import { Buffer } from "node:buffer";
import type { AddressObject, EmailAddress, HeaderLines } from "mailparser";
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
}

export interface ParseResult {
  message: ParsedMessage;
  /** `attachmentContents[i]` is the content of `message.attachments[i]`. */
  attachmentContents: Uint8Array[];
}

/** Parses raw RFC 5322 bytes into plain data. Message bodies are decoded to UTF-8. */
export async function parseMessage(raw: Uint8Array | string): Promise<ParseResult> {
  const source =
    typeof raw === "string" ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.length);
  const mail = await simpleParser(source, {
    // Keep `cid:` links so the sanitizer can map them to attachment ids, and leave `text`
    // empty for HTML-only mail so reply stripping knows to work on the HTML.
    keepCidLinks: true,
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipImageLinks: true,
  });

  const headerId = firstMessageId(mail.messageId);
  const message: ParsedMessage = {
    messageId: headerId ?? (await synthesizeMessageId(mail.headerLines, mail.text, mail.html)),
    messageIdSynthesized: headerId === null,
    inReplyTo: firstMessageId(mail.inReplyTo),
    references: messageIds(mail.references),
    from: addresses(mail.from)[0] ?? null,
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
    signals: signals(mail.headerLines),
  };

  return {
    message,
    attachmentContents: mail.attachments.map((a) => new Uint8Array(a.content)),
  };
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

function signals(lines: HeaderLines): TriageSignals {
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
