import { Buffer } from "node:buffer";
import { type Readable, Transform } from "node:stream";
import type { AttachmentStream, HeaderLines, MessageText, ParsedMail } from "mailparser";
import { MailParser } from "mailparser";
import { PARSER_OPTIONS, RETURNED_PARTS } from "./options.ts";

const KEEP_IN_MEMORY_MAX = 1024 * 1024;

export function streamParser(
  input: Readable,
  save: (index: number, content: Readable) => Promise<void>,
) {
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

/** The first 4 MB of `input`, for reading the top-level headers of a message too big to parse. */
export const headBytes: (input: Readable) => Promise<Buffer> = async (input) => {
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
