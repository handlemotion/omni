import { Buffer } from "node:buffer";
import { type Readable, Transform } from "node:stream";
import type {
  AddressObject,
  AttachmentStream,
  EmailAddress,
  HeaderLines,
  MessageText,
  ParsedMail,
} from "mailparser";
import { MailParser, simpleParser } from "mailparser";
import { AUTOMATED_HEADERS, type Automated, automatedKind, bouncedMessageId } from "./automated.ts";

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
   * The header's own Message-ID when it was over 998 bytes and `messageId` is its hash. A row
   * stored before ids were bounded still carries this form, so look it up by both.
   */
  longMessageId?: string;
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

const PARSER_OPTIONS = {
  keepCidLinks: true,
  skipHtmlToText: true,
  skipTextToHtml: true,
  skipImageLinks: true,
} as const;

/**
 * Parses raw RFC 5322 bytes into plain data. Message bodies are decoded to UTF-8, and NUL
 * characters are removed from every string (Postgres text cannot store them).
 */
export const parseMessage: (raw: Uint8Array | string) => Promise<ParseResult> = async (raw) => {
  const source =
    typeof raw === "string" ? raw : Buffer.from(raw.buffer, raw.byteOffset, raw.length);
  let mail: ParsedMail;
  let bodySkipped = false;
  try {
    mail = await simpleParser(source, PARSER_OPTIONS);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "EMAXLEN") throw error;
    mail = await simpleParser(topHeaders(source), PARSER_OPTIONS);
    bodySkipped = true;
  }
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
  let mail: ParsedMail;
  let bodySkipped = false;
  try {
    mail = await streamParser(open(), saveAttachment);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "EMAXLEN") throw error;
    mail = await simpleParser(topHeaders(await headBytes(open())), PARSER_OPTIONS);
    bodySkipped = true;
  }
  return { message: await describe(mail, bodySkipped) } satisfies { message: ParsedMessage };
}

async function describe(mail: ParsedMail, bodySkipped: boolean) {
  const headerId = firstMessageId(mail.messageId);
  const from = addresses(mail.from)[0] ?? null;
  const message: ParsedMessage = {
    messageId: headerId ?? (await synthesizeMessageId(mail.headerLines, mail.text, mail.html)),
    messageIdSynthesized: headerId === null,
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
  message.inReplyTo ??= message.automated?.bouncedMessageId ?? null;
  const bounded = await boundedId(message.messageId);
  if (bounded !== message.messageId) message.longMessageId = message.messageId;
  message.messageId = bounded;
  if (message.inReplyTo !== null) message.inReplyTo = await boundedId(message.inReplyTo);
  if (bodySkipped) message.bodySkipped = true;

  return withoutNul(message) satisfies ParsedMessage;
}

const KEEP_IN_MEMORY_MAX = 1024 * 1024;

function streamParser(input: Readable, save: (index: number, content: Readable) => Promise<void>) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      input.destroy();
      parser.destroy();
      reject(error);
    };
    const mail = { attachments: [] } as unknown as ParsedMail & Record<string, unknown>;
    const parser = new MailParser(PARSER_OPTIONS);
    parser.on("error", fail);
    parser.on("headers", (headers) => {
      mail.headers = headers;
      mail.headerLines = (parser as unknown as { headerLines: HeaderLines }).headerLines;
    });
    let reading = false;
    const read = () => {
      reading = true;
      const data = parser.read() as MessageText | AttachmentStream | null;
      if (data === null) {
        reading = false;
        return;
      }
      if (data.type === "text") {
        if (data.text !== undefined) mail.text = data.text;
        if (data.html !== undefined) mail.html = data.html;
        read();
        return;
      }
      const attachment = data;
      const index = mail.attachments.length;
      const keep = RETURNED_PARTS.has(attachment.contentType.toLowerCase());
      const kept: Buffer[] = [];
      let size = 0;
      const counted = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          size += chunk.length;
          if (keep && size <= KEEP_IN_MEMORY_MAX) kept.push(chunk);
          done(null, chunk);
        },
      });
      attachment.content.on("error", fail);
      const saved = save(index, attachment.content.pipe(counted));
      mail.attachments.push(attachment as unknown as ParsedMail["attachments"][number]);
      saved.then(() => {
        const entry = mail.attachments[index] as unknown as { content: Buffer; size: number };
        entry.content = Buffer.concat(kept);
        entry.size = size;
        attachment.release?.();
        read();
      }, fail);
    };
    parser.on("readable", () => {
      if (!reading) read();
    });
    parser.on("end", () => {
      for (const key of [
        "subject",
        "references",
        "date",
        "to",
        "from",
        "cc",
        "bcc",
        "message-id",
        "in-reply-to",
        "reply-to",
      ]) {
        if (mail.headers?.has(key)) {
          mail[key.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] =
            mail.headers.get(key);
        }
      }
      if (settled) return;
      settled = true;
      resolve(mail);
    });
    input.once("error", fail).pipe(parser);
  }) satisfies Promise<ParsedMail>;
}

const headBytes: (input: Readable) => Promise<Buffer> = async (input) => {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of input) {
    chunks.push(chunk as Buffer);
    length += (chunk as Buffer).length;
    if (length >= 4 * 1024 * 1024) break;
  }
  input.destroy();
  return Buffer.concat(chunks);
};

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

const topHeaders: (source: string | Buffer) => Buffer = (source) => {
  const bytes = typeof source === "string" ? Buffer.from(source) : source;
  const ends = [bytes.indexOf("\r\n\r\n"), bytes.indexOf("\n\n")].filter((i) => i !== -1);
  const head = bytes.subarray(0, Math.min(bytes.length, ...ends)).toString("latin1");
  const fields = head
    .split(/\r?\n(?![ \t])/)
    .filter((field) => TOP_HEADERS.has(field.slice(0, field.indexOf(":")).trim().toLowerCase()))
    .map((field) => field.slice(0, MAX_TOP_HEADER));
  return Buffer.from(`${fields.join("\r\n")}\r\n\r\n`, "latin1");
};

const MAX_REFERENCES = 100;

const capReferences: (ids: string[]) => string[] = (ids) => {
  if (ids.length <= MAX_REFERENCES) return ids;
  return [...ids.slice(0, 1), ...ids.slice(-(MAX_REFERENCES - 1))];
};

const INVISIBLE =
  /[\u{AD}\u{61C}\u{115F}\u{1160}\u{180E}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{206F}\u{3164}\u{FEFF}\u{FFA0}]|[\u{34F}\u{17B4}\u{17B5}]/gu;
const ADDRESS_IN_NAME = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[^\s@<>"'(),;:]+/;
const DOMAIN_TOKEN = /^(?:[\p{L}\p{N}-]+\.)+\p{L}[\p{L}\p{N}-]{1,62}$/u;
const MAX_CHECKED_NAME = 256;

/** Spoofing hint for a From address: see `DisplayNameSpoof`. */
export const displayNameSpoof: (from: Address | null) => DisplayNameSpoof | null = (from) => {
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
};

function domainOf(address: string) {
  const domain = address.slice(address.lastIndexOf("@") + 1);
  try {
    return new URL(`http://${domain}`).hostname;
  } catch {
    return null;
  }
}

const MESSAGE_ID = /<[^<>\s]+>/g;

const messageIds: (value: string | string[] | undefined) => string[] = (value) => {
  const joined = Array.isArray(value) ? value.join(" ") : (value ?? "");
  const bracketed = joined.match(MESSAGE_ID);
  if (bracketed) return [...new Set(bracketed)];
  return [...new Set(joined.split(/\s+/).filter((id) => id.includes("@")))].map((id) => `<${id}>`);
};

function firstMessageId(value: string | undefined) {
  return messageIds(value)[0] ?? null;
}

const addresses: (value: AddressObject | AddressObject[] | undefined) => Address[] = (value) => {
  if (!value) return [];
  const flat: (list: EmailAddress[]) => EmailAddress[] = (list) =>
    list.flatMap((entry) => (entry.group ? flat(entry.group) : [entry]));
  return (Array.isArray(value) ? value : [value])
    .flatMap((object) => flat(object.value))
    .filter((entry): entry is EmailAddress & { address: string } => Boolean(entry.address))
    .map((entry) => ({ name: entry.name, address: entry.address.toLowerCase() }));
};

function header(lines: HeaderLines, key: string) {
  const line = lines.find((entry) => entry.key === key)?.line;
  if (line === undefined) return null;
  return line
    .slice(line.indexOf(":") + 1)
    .replace(/\r?\n[ \t]+/g, " ")
    .trim();
}

function signals(lines: HeaderLines) {
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

const RETURNED_PARTS = new Set(["text/rfc822-headers", "message/rfc822"]);

const automated: (mail: ParsedMail, from: Address | null) => Automated | null = (mail, from) => {
  const kind = automatedKind((key) => header(mail.headerLines, key), from?.address ?? null);
  if (kind === null) return null;
  if (kind !== "bounce") return { kind, bouncedMessageId: null };
  const returned = mail.attachments
    .filter((a) => RETURNED_PARTS.has(a.contentType.toLowerCase()))
    .map((a) => a.content.toString("latin1"));
  return { kind, bouncedMessageId: bouncedMessageId([...returned, mail.text ?? ""]) };
};

async function synthesizeMessageId(
  lines: HeaderLines,
  text: string | undefined,
  html: string | false | undefined,
) {
  const keyHeaders = ["from", "to", "cc", "date", "subject"]
    .map((key) => `${key}:${header(lines, key) ?? ""}`)
    .join("\n");
  return hashedMessageId(`${keyHeaders}\n\n${text ?? ""}\n\n${html || ""}`);
}

async function hashedMessageId(input: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `<${hex.slice(0, 40)}@omni.invalid>`;
}

const RFC_5322_MAX_LINE_BYTES = 998;

async function boundedId(id: string) {
  if (Buffer.byteLength(id) <= RFC_5322_MAX_LINE_BYTES) return id;
  return hashedMessageId(id);
}

async function boundedIds(ids: string[]) {
  return [...new Set(await Promise.all(ids.map(boundedId)))];
}
