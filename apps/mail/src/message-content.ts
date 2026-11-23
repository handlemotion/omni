import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { type ParsedMessage, parseMessage, parseMessageStream } from "@omni/mail-core";
import { sanitizeHtml } from "@omni/mail-core/clean";
import type { ObjectStore } from "./objects.ts";
import { discard, isSpooled, spool, type SpooledFile } from "./spool.ts";

/** Where apps fetch what sanitized HTML points at. Both are Worker routes. */
export interface ContentLinks {
  /** Remote images become `<imageProxyUrl>?url=<encoded original>`. */
  imageProxyUrl: string;
  /** Inline `cid:` images become `<attachmentUrl>/<sha256 of the attachment>`. */
  attachmentUrl: string;
}

/** A parsed message with its attachments' bytes, in memory or spooled (`spool.ts`). */
export interface Parsed {
  message: ParsedMessage;
  attachments: (Uint8Array | SpooledFile)[];
}

/** Parses raw bytes in memory, or a spooled message from disk with its attachments spooled too. */
export const parse: (raw: Uint8Array | SpooledFile) => Promise<Parsed> = async (raw) => {
  if (!isSpooled(raw)) {
    const { message, attachmentContents } = await parseMessage(raw);
    return { message, attachments: attachmentContents };
  }
  const attachments: SpooledFile[] = [];
  try {
    const { message } = await parseMessageStream(
      () => createReadStream(raw.path),
      async (index, content) => {
        attachments[index] = await spool(content);
      },
    );
    const kept = attachments.slice(0, message.attachments.length);
    await Promise.all(attachments.slice(kept.length).map((file) => discard(file.path)));
    return { message, attachments: kept };
  } catch (error) {
    await Promise.all(attachments.map((file) => file && discard(file.path)));
    throw error;
  }
};

/** Removes the temp files `parse` spooled attachments to. */
export async function discardParsed(parsed: Parsed) {
  await Promise.all(parsed.attachments.filter(isSpooled).map((file) => discard(file.path)));
}

/**
 * Writes a message's objects under `prefix`, each named by the SHA-256 of its bytes so a second
 * copy overwrites the first: the raw message, every attachment, and its HTML sanitized with
 * remote images behind the proxy and `cid:` images pointing at their attachment.
 */
export async function writeMessageContent(
  objects: ObjectStore,
  links: ContentLinks,
  prefix: string,
  raw: Uint8Array | SpooledFile,
  parsed: Parsed,
) {
  const { message } = parsed;
  const rawHash = isSpooled(raw) ? raw.sha256 : sha256(raw);
  const r2Key = `${prefix}/raw/${rawHash}.eml`;
  await put(objects, r2Key, raw, "message/rfc822");

  const files = await Promise.all(
    message.attachments.map(async (meta, i) => {
      const content = parsed.attachments[i] ?? new Uint8Array();
      const hash = isSpooled(content) ? content.sha256 : sha256(content);
      const key = `${prefix}/att/${hash}`;
      await put(objects, key, content, meta.mimeType);
      return { meta, hash, key };
    }),
  );

  let htmlR2Key: string | null = null;
  let remoteImageCount = 0;
  if (message.html !== null) {
    const byCid = new Map(
      files.filter((f) => f.meta.contentId).map((f) => [f.meta.contentId as string, f.hash]),
    );
    const sanitized = sanitizeHtml(message.html, {
      proxyUrl: (src) => `${links.imageProxyUrl}?url=${encodeURIComponent(src)}`,
      cidUrl: (cid) => {
        const hash = byCid.get(cid);
        return hash ? `${links.attachmentUrl}/${hash}` : null;
      },
    });
    remoteImageCount = sanitized.remoteImageCount;
    htmlR2Key = `${prefix}/html/${rawHash}.html`;
    await objects.put(htmlR2Key, sanitized.html, "text/html; charset=utf-8");
  }

  return {
    r2Key,
    htmlR2Key,
    remoteImageCount,
    attachments: files.map((f) => ({
      filename: f.meta.filename ?? "attachment",
      mimeType: f.meta.mimeType,
      size: f.meta.size,
      r2Key: f.key,
      inline: f.meta.inline,
      contentId: f.meta.contentId,
    })),
  };
}

function put(
  objects: ObjectStore,
  key: string,
  body: Uint8Array | SpooledFile,
  contentType: string,
) {
  return isSpooled(body)
    ? objects.putFile(key, body, contentType)
    : objects.put(key, body, contentType);
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}
