// The Message-ID of a send, derived from its outbox idempotency key. The mail service stamps it
// on the message it sends; the Worker returns it to the app, which matches its pending message
// against the synced copy by it. Both must compute the exact same string.

import { toHex, utf8 } from "./encoding.ts";

/** `<sha256("omni-send:" + key)[0..32]@domain>`: the same key always yields the same Message-ID. */
export async function deterministicMessageId(
  idempotencyKey: string,
  address: string,
): Promise<string> {
  const at = address.lastIndexOf("@");
  const domain = address.slice(at + 1);
  if (at < 0 || !domain) throw new TypeError(`mailbox address has no domain: ${address}`);
  const digest = await crypto.subtle.digest("SHA-256", utf8(`omni-send:${idempotencyKey}`));
  return `<${toHex(new Uint8Array(digest)).slice(0, 32)}@${domain}>`;
}
