const REPLY_PREFIX_LANGUAGES = {
  re: "English",
  aw: "German",
  sv: "Danish, Norwegian, Swedish",
  antw: "Dutch",
  odp: "Polish",
  ynt: "Turkish",
  res: "Portuguese",
};

const FORWARD_PREFIX_LANGUAGES = {
  fwd: "English",
  fw: "English (Outlook)",
  wg: "German",
  tr: "French",
  rv: "Spanish",
  enc: "Portuguese",
  vs: "Danish, Norwegian",
};

const COUNTER = String.raw`(?:\[\d+\]|\(\d+\))?`;
const COLON_ASCII_OR_FULL_WIDTH = "[:：]";

const prefixPattern = (words: readonly string[]) =>
  new RegExp(
    String.raw`^\s*(?:${words.join("|")})\s*${COUNTER}\s*${COLON_ASCII_OR_FULL_WIDTH}`,
    "i",
  );

const REPLY_WORDS = Object.keys(REPLY_PREFIX_LANGUAGES);
const FORWARD_WORDS = Object.keys(FORWARD_PREFIX_LANGUAGES);
const REPLY_PREFIX = prefixPattern(REPLY_WORDS);
const FORWARD_PREFIX = prefixPattern(FORWARD_WORDS);
const ANY_PREFIX = prefixPattern([...REPLY_WORDS, ...FORWARD_WORDS]);

/** Whether the subject starts with a reply prefix (`Re:`, `RE[2]:`, `Aw：`, `Odp:`…). */
export function isReplySubject(subject: string) {
  return REPLY_PREFIX.test(subject);
}

/** Whether the subject starts with a forward prefix (`Fwd:`, `FW[2]:`, `RV:`, `Enc:`…). */
export function isForwardSubject(subject: string) {
  return FORWARD_PREFIX.test(subject);
}

/** Subject with reply/forward prefixes removed, lowercased and whitespace-collapsed. */
export function normalizeSubject(subject: string) {
  let rest = subject.trim();
  for (let match = ANY_PREFIX.exec(rest); match; match = ANY_PREFIX.exec(rest)) {
    rest = rest.slice(match[0].length).trim();
  }
  return rest.replace(/\s+/g, " ").toLowerCase();
}
