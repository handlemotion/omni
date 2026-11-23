import type { Mailbox, Message } from "./api.ts";

/**
 * Whether a message opens as the sender's HTML rather than its text: it has no text of its own,
 * or it is outside mail whose images carry it.
 */
export function opensFull(message: Message) {
  if (!message.hasHtml) return false;
  if (!message.cleanText.trim()) return true;
  return !message.fromTeam && (message.remoteImageCount > 0 || /\[image: /.test(message.cleanText));
}

/** The newest messages whose HTML is fetched before a thread opens. */
export const WARM_NEWEST = 3;

/**
 * What a mailbox is called: its label ("Work"), else you for your personal one and its local
 * part for a shared one.
 */
export function mailboxName(
  mailbox: Pick<Mailbox, "kind" | "address"> & { label?: string | null },
  you: string,
) {
  if (mailbox.label) return mailbox.label;
  if (mailbox.kind === "personal") return you;
  const local = mailbox.address.split("@")[0] ?? mailbox.address;
  return local.charAt(0).toUpperCase() + local.slice(1);
}
