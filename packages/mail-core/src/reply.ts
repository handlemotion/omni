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

const FORWARD_MARKER = /^(?:-{3,}\s*forwarded message\s*-{3,}|begin forwarded message:)\s*$/im;

const OUTLOOK_FROM = /^\s*\*?(?:from|de|von|van|da|från|fra|od)\s*:\*?\s*\S/i;
const OUTLOOK_SENT =
  /^\s*\*?(?:sent|date|enviad[oa](?:\s+e[lm])?|fecha|gesendet|datum|envoyé|verzonden|inviato|data|skickat|sendt|wysłano)\s*:\*?\s*\S/i;
const OUTLOOK_LOOKAHEAD = 3;
const OUTLOOK_SEPARATOR = /^\s*(?:_{10,}|-{3,}\s*original message\s*-{3,})\s*$/i;

const FORWARD_HEADER = /^\s*\*?(from|date|sent|subject|to|cc)\s*:\*?\s*(.*)$/i;

/**
 * Text past this many characters is not read for reply stripping. New content sits at the
 * top; a text part this long is a newsletter or a dump, and its clean text is cut here.
 */
export const MAX_TEXT_LENGTH = 1_000_000;

/** Splits plain text into new content and, for forwards, the forwarded message. */
export const stripReply: (text: string, subject?: string) => StrippedText = (
  text,
  subject = "",
) => {
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
};

const forwardStart: (
  lines: string[],
  subject: string,
) => { noteEnd: number; headersStart: number } | null = (lines, subject) => {
  const marker = lines.findIndex((line) => FORWARD_MARKER.test(line));
  if (marker !== -1) return { noteEnd: marker, headersStart: marker + 1 };
  if (/^\s*(?:fwd?|wg|tr|rv|enc|vs)\s*[:：]/i.test(subject)) {
    const block = outlookHeaderStart(lines);
    if (block !== null) return { noteEnd: block.cut, headersStart: block.from };
  }
  return null;
};

const outlookHeaderStart: (lines: string[]) => { cut: number; from: number } | null = (lines) => {
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
};

function stripQuotes(lines: string[]) {
  const outlook = outlookHeaderStart(lines);
  return visibleText(outlook === null ? lines : lines.slice(0, outlook.cut))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const MAX_HEADER_LINE = 500;

const HEADER_VERB_LAST =
  /^[-\s]*(?:On|Le|El|Il|Em|W\sdniu|Dnia|pe|In\sdata)\s.*\s(?:wrote|écrit|escribió|scritto|escreveu|pisze|napisał(?:\(a\))?|kirjoitti)\s?:?[-\s]*$/u;
const HEADER_VERB_FIRST = /^\s*(?:Am|Op|Den)\s.*\s(?:schrieb|schreef|skrev)(?:\s.*)?:$/u;
const QUOTE_HEADERS = [
  HEADER_VERB_LAST,
  HEADER_VERB_FIRST,
  /^\s*(?:From|Von|De|Van|Da)\s?:[^<[]*[<[][^>\]]*[>\]]/,
  /^\s*ср,\s.*\sг\.\sв\s[^<[]*[<[][^>\]]*[>\]]:$/u,
  /^在.*写道：$/u,
  /^20\d{2}\..*\s작성:$/u,
  /^20\d{2}\/.*のメッセージ:$/u,
  /^[^<]*\s<[^<>]*>\sschrieb:$/,
  /^20\d{2}-\d{2}.\d{2}.\d{2}:\d{2}.*>:$/,
  /^\s*[a-z]{3,4}\.\s.*\sskrev\s.*:$/,
  /^\d{2}.\d{2}.20\d{2}[^<]*<[^<>]*> *:$/,
  /^\d{2}:\d{2}[^<]*\d{4}[^<]*<[^<>]*> *:$/,
  /^-{1,12} ?(?:original message|oprindelig besked|message d'origine|ursprüngliche nachricht) ?-{0,12}$/i,
];
function isOnAtWrote(line: string) {
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

function isQuoteHeader(line: string) {
  if (line.length > MAX_HEADER_LINE) return false;
  return QUOTE_HEADERS.some((pattern) => pattern.test(line)) || isOnAtWrote(line);
}

function isSignature(line: string) {
  return line.length <= MAX_HEADER_LINE && SIGNATURES.some((pattern) => pattern.test(line));
}

interface Fragment {
  lines: string[];
  quoted: boolean;
  signature: boolean;
}

function visibleText(input: string[]) {
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

function joinWrappedHeaders(lines: string[]) {
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
  return joined satisfies string[];
}

function parseForwarded(lines: string[]) {
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
  return forwarded satisfies ForwardedMessage;
}
