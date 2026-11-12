// Pure helpers for writing mail: reply and forward subjects, and the forwarded-message block.
// Runs on Node and workerd (no DOM), so the Worker builds sends with it.

/** `Re: <subject>`, without stacking prefixes a mail client already added (`Re:`, `RE:`, `Aw:`). */
export function replySubject(subject: string) {
  const trimmed = subject.trim();
  return /^(re|aw|sv|antw)\s*:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

/** `Fwd: <subject>`, without stacking a second forward prefix (`Fwd:`, `FW:`, `WG:`). */
export function forwardSubject(subject: string) {
  const trimmed = subject.trim();
  return /^(fwd?|wg|tr)\s*:/i.test(trimmed) ? trimmed : `Fwd: ${trimmed}`;
}

export interface ForwardedMessage {
  fromName: string | null;
  fromAddress: string;
  to: { name: string | null; address: string }[];
  cc: { name: string | null; address: string }[];
  sentAt: Date;
  subject: string;
  /** The message's text as Omni shows it. */
  text: string;
}

function formatAddress(a: { name: string | null; address: string }) {
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The header lines of a forwarded message, in the order Gmail and Apple Mail use. */
function forwardHeaders(original: ForwardedMessage) {
  return [
    ["From", formatAddress({ name: original.fromName, address: original.fromAddress })],
    ["Date", original.sentAt.toUTCString()],
    ["Subject", original.subject],
    ["To", original.to.map(formatAddress).join(", ")],
    ...(original.cc.length ? [["Cc", original.cc.map(formatAddress).join(", ")]] : []),
  ] as const;
}

/**
 * The body of a forward: what the sender wrote, then the original under a
 * `---------- Forwarded message ---------` divider. With `html`, the HTML part gets the same
 * block, every value from the original escaped (a sender's display name is untrusted text).
 */
export function forwardBody(
  written: { text: string; html?: string },
  original: ForwardedMessage,
): { text: string; html?: string } {
  const headers = forwardHeaders(original);
  const text = [
    written.text.trimEnd(),
    "",
    "---------- Forwarded message ---------",
    ...headers.map(([name, value]) => `${name}: ${value}`),
    "",
    original.text,
  ].join("\n");
  if (written.html === undefined) return { text };
  const html = [
    written.html,
    '<br><div class="omni-forward">---------- Forwarded message ---------<br>',
    ...headers.map(([name, value]) => `${name}: ${escapeHtml(value)}<br>`),
    "<br>",
    `<div style="white-space:pre-wrap">${escapeHtml(original.text)}</div></div>`,
  ].join("");
  return { text, html };
}
