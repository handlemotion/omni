import { Buffer } from "node:buffer";
import type { Readable } from "node:stream";
import type { ParsedMail } from "mailparser";
import { simpleParser } from "mailparser";
import { type Automated, automatedKind, bouncedMessageId } from "./automated.ts";
import { addresses, header, signals, topHeaders } from "./parse/headers.ts";
import {
  boundedId,
  boundedIds,
  capReferences,
  firstMessageId,
  idAliases,
  messageIds,
  synthesizeMessageId,
} from "./parse/message-id.ts";
import { PARSER_OPTIONS, RETURNED_PARTS } from "./parse/options.ts";
import { displayNameSpoof } from "./parse/spoof.ts";
import { headBytes, streamParser } from "./parse/stream.ts";

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
  /**
   * Other keys an earlier version may have stored this message under: the raw id when
   * `messageId` is its hash (a repetitive id compressed enough to index), or the hash when an
   * id of 999 to 2,600 bytes kept its raw form. Look a message up by `messageId`, then these.
   */
  messageIdAliases: string[];
  /**
   * The In-Reply-To header. A bounce without one gets the Message-ID of the message it
   * returns, as Gmail's own bounces carry: it is stored, so threading converges whichever
   * of the two syncs first.
   */
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
  /** Set when a machine sent it (bounce, auto-reply, system notice): see `automatedKind`. */
  automated: Automated | null;
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

async function parseOrTopHeadersOnEmaxlen(
  parse: () => Promise<ParsedMail>,
  headers: () => Promise<string | Buffer> | string | Buffer,
) {
  try {
    return { mail: await parse(), bodySkipped: false };
  } catch (error) {
    if ((error as { code?: unknown }).code !== "EMAXLEN") throw error;
    const mail = await simpleParser(topHeaders(await headers()), PARSER_OPTIONS);
    return { mail, bodySkipped: true };
  }
}

/**
 * Parses raw RFC 5322 bytes into plain data. Message bodies are decoded to UTF-8, and NUL
 * characters are removed from every string (Postgres text cannot store them).
 */
export const parseMessage: (raw: Uint8Array | string) => Promise<ParseResult> = async (raw) => {
  const source =
    typeof raw === "string" ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.length);
  const { mail, bodySkipped } = await parseOrTopHeadersOnEmaxlen(
    () => simpleParser(source, PARSER_OPTIONS),
    () => source,
  );
  const message = await describe(mail, bodySkipped);
  return {
    message,
    attachmentContents: mail.attachments.map((a) => new Uint8Array(a.content)),
  };
};

/**
 * `parseMessage` for a message too big to hold in memory: reads `open()` once (twice if its MIME
 * structure breaks the parser's limits) and hands each attachment's decoded content to
 * `saveAttachment` as a stream, in `message.attachments` order, without buffering it. The stream
 * must be read to its end before the promise settles.
 */
export async function parseMessageStream(
  open: () => Readable,
  saveAttachment: (index: number, content: Readable) => Promise<void>,
) {
  const { mail, bodySkipped } = await parseOrTopHeadersOnEmaxlen(
    () => streamParser(open(), saveAttachment),
    () => headBytes(open()),
  );
  return { message: await describe(mail, bodySkipped) } satisfies { message: ParsedMessage };
}

async function describe(mail: ParsedMail, bodySkipped: boolean) {
  const headerId = firstMessageId(mail.messageId);
  const from = addresses(mail.from)[0] ?? null;
  const message: ParsedMessage = {
    messageId: headerId ?? (await synthesizeMessageId(mail.headerLines, mail.text, mail.html)),
    messageIdSynthesized: headerId === null,
    messageIdAliases: [],
    inReplyTo: firstMessageId(mail.inReplyTo),
    references: capReferences(await boundedIds(messageIds(mail.references))),
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
    automated: automated(mail, from),
  };
  if (message.automated?.kind === "bounce") {
    message.inReplyTo ??= message.automated.bouncedMessageId;
  }
  message.messageIdAliases = await idAliases(message.messageId);
  message.messageId = await boundedId(message.messageId);
  if (message.inReplyTo !== null) message.inReplyTo = await boundedId(message.inReplyTo);
  if (bodySkipped) message.bodySkipped = true;

  return withoutNul(message) satisfies ParsedMessage;
}

const withoutNul: <T>(value: T) => T = (value) => {
  if (typeof value === "string") {
    return (value.includes("\0") ? value.replaceAll("\0", "") : value) as typeof value;
  }
  if (Array.isArray(value)) return value.map(withoutNul) as typeof value;
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, withoutNul(entry)]),
    ) as typeof value;
  }
  return value;
};

const automated: (mail: ParsedMail, from: Address | null) => Automated | null = (mail, from) => {
  const kind = automatedKind((key) => header(mail.headerLines, key), from?.address ?? null);
  if (kind === null) return null;
  if (kind !== "bounce") return { kind };
  const returned = mail.attachments
    .filter((a) => RETURNED_PARTS.has(a.contentType.toLowerCase()))
    .map((a) => a.content.toString("latin1"));
  return { kind, bouncedMessageId: bouncedMessageId([...returned, mail.text ?? ""]) };
};
