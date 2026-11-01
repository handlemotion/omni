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

/**
 * Text past this many characters is not read for reply stripping. New content sits at the
 * top; a text part this long is a newsletter or a dump, and its clean text is cut here.
 */
export const MAX_TEXT_LENGTH = 1_000_000;

/** Splits plain text into new content and, for forwards, the forwarded message. */
export function stripReply(text: string, subject = ""): StrippedText {
  const head =
    text.length > MAX_TEXT_LENGTH
      ? text.slice(0, text.lastIndexOf("\n", MAX_TEXT_LENGTH) + 1 || MAX_TEXT_LENGTH)
      : text;
  const normalized = head.replace(/\r\n?/g, "\n");
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
  return visibleText(outlook === null ? lines : lines.slice(0, outlook.cut))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The fragment rules of email-reply-parser (a port of GitHub's EmailReplyParser), kept in
// house because its patterns backtrack catastrophically: 2,000 lines of "abc. x skrev x"
// (30 KB) took 19 s, and it exports no way to swap them. Every pattern below runs on one
// line at a time and scans it a bounded number of times.

/** Lines longer than this are never quote headers; capping them keeps header checks cheap. */
const MAX_HEADER_LINE = 500;

// "On DATE, NAME <EMAIL> wrote:" and its translations: an opening word, anything, a verb.
const HEADER_VERB_LAST =
  /^[-\s]*(?:On|Le|El|Il|Em|W\sdniu|Dnia|pe|In\sdata)\s.*\s(?:wrote|écrit|escribió|scritto|escreveu|pisze|napisał(?:\(a\))?|kirjoitti)\s?:?[-\s]*$/u;
// "Am DATE schrieb NAME <EMAIL>:": the verb comes before the name.
const HEADER_VERB_FIRST = /^\s*(?:Am|Op|Den)\s.*\s(?:schrieb|schreef|skrev)(?:\s.*)?:$/u;
const QUOTE_HEADERS = [
  HEADER_VERB_LAST,
  HEADER_VERB_FIRST,
  /^\s*(?:From|Von|De|Van|Da)\s?:[^<[]*[<[][^>\]]*[>\]]/, // From: NAME <EMAIL>
  /^\s*ср,\s.*\sг\.\sв\s[^<[]*[<[][^>\]]*[>\]]:$/u, // ср, DATE г. в TIME, NAME <EMAIL>:
  /^在.*写道：$/u, // 在 DATE, TIME, NAME 写道：
  /^20\d{2}\..*\s작성:$/u, // DATE TIME NAME 작성:
  /^20\d{2}\/.*のメッセージ:$/u, // DATE TIME、NAME のメッセージ:
  /^[^<]*\s<[^<>]*>\sschrieb:$/, // NAME <EMAIL> schrieb:
  /^20\d{2}-\d{2}.\d{2}.\d{2}:\d{2}.*>:$/, // 20YY-MM-DD HH:II GMT+01:00 NAME <EMAIL>:
  /^\s*[a-z]{3,4}\.\s.*\sskrev\s.*:$/, // DATE skrev NAME <EMAIL>:
  /^\d{2}.\d{2}.20\d{2}[^<]*<[^<>]*> *:$/, // DD.MM.20YY HH:II NAME <EMAIL>:
  /^\d{2}:\d{2}[^<]*\d{4}[^<]*<[^<>]*> *:$/, // HH:II, DATE, NAME <EMAIL>:
  /^-{1,12} ?(?:original message|oprindelig besked|message d'origine|ursprüngliche nachricht) ?-{0,12}$/i,
];
// "NAME on DATE at TIME wrote:": three free-form gaps, so it is checked with indexOf.
function isOnAtWrote(line: string): boolean {
  if (!line.endsWith(" wrote:")) return false;
  const on = line.indexOf(" on ");
  return on > 0 && line.indexOf(" at ", on) !== -1;
}

const SIGNATURES = [
  /^\s*-{2,4}$/,
  /^\s*_{2,4}$/,
  /^-- $/,
  /^\+{2,4}$/,
  /^={2,4}$/,
  /^_{32}$/,
  /^(?:Sent from|Get Outlook for|Sendt fra|Envoyé depuis|Envoyé de mon|Envoyé à partir de|Télécharger Outlook pour|Enviado desde|Verzonden vanaf|Verstuurd vanaf) ./,
  /^Von .* gesendet$/,
  /^Gesendet von .* für ./,
  /^(?:Cheers|Best wishes),?!?$/i,
  /^\w{0,20}\s?(?:\sand\s)?Regards,?!?！?$/i,
  /^Bien . vous,?!?$/i,
  /^\w{0,20}\s?cordialement,?!?$/i,
  /^Bonne (?:journ.e|soir.e)!?$/i,
];

function isQuoteHeader(line: string): boolean {
  if (line.length > MAX_HEADER_LINE) return false;
  return QUOTE_HEADERS.some((pattern) => pattern.test(line)) || isOnAtWrote(line);
}

function isSignature(line: string): boolean {
  return line.length <= MAX_HEADER_LINE && SIGNATURES.some((pattern) => pattern.test(line));
}

interface Fragment {
  /** Bottom-up: the parser walks the message from its last line. */
  lines: string[];
  quoted: boolean;
  signature: boolean;
}

/** The lines a reader sees: no ">" quotes, no quote header with what follows it, no signature. */
function visibleText(input: string[]): string {
  const lines = joinWrappedHeaders(input);
  const fragments: Fragment[] = [];
  let fragment: Fragment | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    let line = lines[i] ?? "";
    if (!isSignature(line)) line = line.trimEnd();
    if (fragment) {
      const below = fragment.lines.at(-1) ?? "";
      if (isSignature(below)) {
        fragment.signature = true;
        fragments.push(fragment);
        fragment = null;
      } else if (line === "" && isQuoteHeader(below)) {
        fragment.quoted = true;
        fragments.push(fragment);
        fragment = null;
      }
    }
    const quoted = line.startsWith(">");
    const continues =
      fragment !== null &&
      (fragment.quoted === quoted || (fragment.quoted && (line === "" || isQuoteHeader(line))));
    if (!continues) {
      if (fragment) fragments.push(fragment);
      fragment = { lines: [], quoted, signature: false };
    }
    fragment?.lines.push(line);
  }
  if (fragment) fragments.push(fragment);

  const visible = fragments
    .filter((f) => !f.quoted && !f.signature && f.lines.join("") !== "")
    .toReversed()
    .map((f) => f.lines.toReversed().join("\n").replace(/^\n/, ""));
  let text = visible.join("\n");
  let end = text.length;
  while (end > 0 && text[end - 1] === "~") end--;
  text = text.slice(0, end);
  return text;
}

/** Clients wrap long quote headers ("On … Ana <ana@…>\nwrote:"); rejoin them to one line. */
function joinWrappedHeaders(lines: string[]): string[] {
  const joined: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const next = lines[i + 1];
    if (next !== undefined && !isQuoteHeader(line) && isQuoteHeader(`${line} ${next}`)) {
      joined.push(`${line} ${next}`);
      i++;
    } else {
      joined.push(line);
    }
  }
  return joined;
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
