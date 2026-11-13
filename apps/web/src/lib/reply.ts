/**
 * A chat reply to part of the conversation: a passage of a message or a note. Copied from
 * handlemotion/dorks (`lib/reply.ts`). It travels inside the note itself, as a quote above what
 * was written, so nothing changes on the server and any client reads it:
 *
 *     > Replying to Carla:
 *     > I was charged twice for order 4411.
 *
 *     Checking the payment logs now.
 *
 * The timeline parses the quote back out and shows it above the bubble.
 */
export type Reply = { from: string; text: string };

const HEADER = /^> Replying to (.+):$/;
/** A quote longer than this is cut: the point is to name the passage, not to resend it. */
const MAX_QUOTE = 600;

/** Selected or copied text as one tidy quote: no runs of blank lines, no trailing space. */
export function quoteText(text: string): string {
  const tidy = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return tidy.length > MAX_QUOTE ? `${tidy.slice(0, MAX_QUOTE).trimEnd()}…` : tidy;
}

/** The note as saved: the reply's quote, a blank line, then what was written. */
export function withReply(reply: Reply | undefined, message: string): string {
  if (!reply) return message;
  // A name with a colon or line break would end the header early.
  const from = reply.from.replace(/[:\n]/g, " ").trim() || "message";
  const quote = [
    `> Replying to ${from}:`,
    ...reply.text.split("\n").map((l) => (l ? `> ${l}` : ">")),
  ];
  return [quote.join("\n"), message.trim()].filter(Boolean).join("\n\n");
}

/** Splits a note into its reply (if it starts with one) and the rest. */
export function parseReply(text: string): { reply?: Reply; body: string } {
  const lines = text.split("\n");
  const from = HEADER.exec(lines[0] ?? "")?.[1];
  if (!from) return { body: text };
  let end = 1;
  while (end < lines.length && lines[end]?.startsWith(">")) end++;
  const quoted = lines
    .slice(1, end)
    .map((line) => line.replace(/^> ?/, ""))
    .join("\n")
    .trim();
  return { reply: { from, text: quoted }, body: lines.slice(end).join("\n").trim() };
}

/** One line naming a reply, for the composer's banner and the note. */
export const replyLabel = (reply: Reply) => reply.text.replace(/\s+/g, " ");
