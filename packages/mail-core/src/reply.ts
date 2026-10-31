import EmailReplyParser from "email-reply-parser";

export interface ForwardedMessage {
  from: string | null;
  date: string | null;
  subject: string | null;
  to: string | null;
  /** The forwarded body, unstripped: it renders as a quoted card. */
  text: string;
}

export interface StrippedText {
  /** Only what the sender newly wrote: no quoted history, no signature. */
  cleanText: string;
  /** Set when the message forwards another one. */
  forwarded: ForwardedMessage | null;
}

// Gmail "---------- Forwarded message ---------", Thunderbird "-------- Forwarded Message --------",
// Apple Mail "Begin forwarded message:".
const FORWARD_MARKER = /^(?:-{3,}\s*forwarded message\s*-{3,}|begin forwarded message:)\s*$/im;

// Outlook (desktop and web) quotes with a header block instead of ">" lines:
//   From: Ana <ana@example.com>
//   Sent: Tuesday, October 28, 2026 10:14 AM
// Bold markers survive from HTML-to-text ("*From:*"). Localized labels for the common locales.
const OUTLOOK_FROM = /^\s*\*?(?:from|de|von|van|da|från|fra|od)\s*:\*?\s*\S/i;
const OUTLOOK_SENT =
  /^\s*\*?(?:sent|date|enviado|fecha|gesendet|datum|envoyé|verzonden|inviato|data|skickat|sendt|wysłano)\s*:\*?\s*\S/i;
const OUTLOOK_LOOKAHEAD = 3;
// Lines Outlook puts right above that block.
const OUTLOOK_SEPARATOR = /^\s*(?:_{10,}|-{3,}\s*original message\s*-{3,})\s*$/i;

const FORWARD_HEADER = /^\s*\*?(from|date|sent|subject|to|cc)\s*:\*?\s*(.*)$/i;

/** Splits plain text into new content and, for forwards, the forwarded message. */
export function stripReply(text: string, subject = ""): StrippedText {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");

  const forwardAt = forwardStart(lines, subject);
  if (forwardAt !== null) {
    return {
      cleanText: stripQuotes(lines.slice(0, forwardAt.noteEnd)),
      forwarded: parseForwarded(lines.slice(forwardAt.headersStart)),
    };
  }
  return { cleanText: stripQuotes(lines), forwarded: null };
}

function forwardStart(
  lines: string[],
  subject: string,
): { noteEnd: number; headersStart: number } | null {
  const marker = lines.findIndex((line) => FORWARD_MARKER.test(line));
  if (marker !== -1) return { noteEnd: marker, headersStart: marker + 1 };
  // Outlook forwards reuse the reply header block; only the subject tells them apart.
  if (/^\s*(?:fwd?|wg|tr|rv|enc|vs)\s*[:：]/i.test(subject)) {
    const block = outlookHeaderStart(lines);
    if (block !== null) return { noteEnd: block.cut, headersStart: block.from };
  }
  return null;
}

function outlookHeaderStart(lines: string[]): { cut: number; from: number } | null {
  for (let i = 0; i < lines.length; i++) {
    if (!OUTLOOK_FROM.test(lines[i] ?? "")) continue;
    const window = lines.slice(i + 1, i + 1 + OUTLOOK_LOOKAHEAD);
    if (!window.some((line) => OUTLOOK_SENT.test(line))) continue;
    let cut = i;
    while (
      cut > 0 &&
      (lines[cut - 1]?.trim() === "" || OUTLOOK_SEPARATOR.test(lines[cut - 1] ?? ""))
    ) {
      cut--;
    }
    return { cut, from: i };
  }
  return null;
}

function stripQuotes(lines: string[]): string {
  const outlook = outlookHeaderStart(lines);
  const kept = (outlook === null ? lines : lines.slice(0, outlook.cut)).join("\n");
  return new EmailReplyParser()
    .parseReply(kept)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseForwarded(lines: string[]): ForwardedMessage {
  const forwarded: ForwardedMessage = { from: null, date: null, subject: null, to: null, text: "" };
  let i = 0;
  while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const match = FORWARD_HEADER.exec(line);
    if (!match) break;
    const key = (match[1] ?? "").toLowerCase();
    const value = (match[2] ?? "").trim();
    if (key === "from") forwarded.from = value;
    else if (key === "date" || key === "sent") forwarded.date = value;
    else if (key === "subject") forwarded.subject = value;
    else if (key === "to") forwarded.to = value;
  }
  forwarded.text = lines.slice(i).join("\n").trim();
  return forwarded;
}
