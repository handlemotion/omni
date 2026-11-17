import { forwardCopySource, forwardTarget, type Db } from "@omni/db";
import { parseMessage } from "@omni/mail-core";
import { forwardBody, forwardSubject } from "@omni/mail-core/compose";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { ObjectStore } from "./objects.ts";

export interface Forwarding {
  /** Where the mailbox's sends are BCC'd, or null when forwarding is off. */
  target(mailboxId: string): Promise<string | null>;
  /** The received message to copy and where to, or null: it is gone, or forwarding is off. */
  copy(mailboxId: string, messageId: string): Promise<{ raw: Uint8Array; to: string } | null>;
}

export class PgForwarding implements Forwarding {
  private readonly options: { db: Db; objects: ObjectStore };

  constructor(options: { db: Db; objects: ObjectStore }) {
    this.options = options;
  }

  target(mailboxId: string) {
    return forwardTarget(this.options.db, mailboxId) satisfies Promise<string | null>;
  }

  async copy(mailboxId: string, messageId: string) {
    const source = await forwardCopySource(this.options.db, mailboxId, messageId);
    if (!source?.forwardAddress || !source.r2Key) return null;
    const raw = await this.options.objects.get(source.r2Key);
    return raw ? { raw, to: source.forwardAddress } : null;
  }
}

/**
 * `Fwd: <subject>` from `from` to `to`: the original's headers and text under the standard
 * "Forwarded message" divider, with its attachments.
 */
export async function composeForwardCopy(
  original: Uint8Array,
  envelope: { from: string; to: string; messageId: string },
) {
  const { message, attachmentContents } = await parseMessage(original);
  const body = forwardBody(
    { text: "" },
    {
      fromName: message.from?.name || null,
      fromAddress: message.from?.address ?? "",
      to: message.to.map(toAddress),
      cc: message.cc.map(toAddress),
      sentAt: message.sentAt ?? new Date(),
      subject: message.subject,
      text: message.text ?? "",
    },
  );
  return new MailComposer({
    from: envelope.from,
    to: envelope.to,
    subject: forwardSubject(message.subject),
    text: body.text.trimStart(),
    messageId: envelope.messageId,
    references: [...message.references, message.messageId],
    attachments: message.attachments.flatMap((meta, i) =>
      meta.inline
        ? []
        : [
            {
              filename: meta.filename ?? "attachment",
              contentType: meta.mimeType,
              content: Buffer.from(attachmentContents[i] ?? new Uint8Array()),
            },
          ],
    ),
    date: new Date(),
  })
    .compile()
    .build() satisfies Promise<Buffer>;
}

function toAddress(address: { name: string; address: string }) {
  return { name: address.name || null, address: address.address };
}
