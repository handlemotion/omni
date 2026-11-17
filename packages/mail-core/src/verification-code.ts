const SCAN_CHARS = 4000;

const KEYWORD_SOURCE =
  "(?<!\\b(?:zip|postal|area|country|promo|discount|coupon|error|status|source|qr|bar)\\s)" +
  "(?<![\\p{L}\\d])(?:code|c[oó]digo|codice|otp|passcode|one[- ]time (?:password|pin))(?![\\p{L}\\d])";
const KEYWORD = new RegExp(KEYWORD_SOURCE, "iu");

const DIGITS = "\\d{3}[ -]\\d{3}|\\d{4,8}";
const MIXED = "[A-Z0-9]{3,5}-[A-Z0-9]{3,5}|[A-Z0-9]{5,8}";
const DIGITS_ALONE = `(?<![\\p{L}\\d#$€£:./,-])(${DIGITS})(?![\\p{L}\\d:/,-]|\\.\\d)`;

const STANDALONE_LINE = new RegExp(`^[ \\t>*_]*(${DIGITS}|${MIXED})[ \\t*_]*$`, "gm");
const AFTER_KEYWORD = new RegExp(
  `${KEYWORD_SOURCE}[^\\d\\n]{0,40}?(?<![\\p{L}\\d#$€£./,-])(${DIGITS}|${MIXED})(?![\\p{L}\\d:/,-]|\\.\\d)`,
  "giu",
);
const BEFORE_KEYWORD = new RegExp(
  `${DIGITS_ALONE} (?:is|es|est|é|è) [^\\d\\n]{0,40}?${KEYWORD_SOURCE}`,
  "giu",
);
const SUBJECT_DIGITS = new RegExp(DIGITS_ALONE, "gu");

/**
 * The verification code a message carries, as the reader would type it (digit groups joined:
 * "123 456" is `123456`), or null when it has none or more than one candidate.
 */
export function verificationCode(message: { subject: string; text: string }) {
  const text = message.text.slice(0, SCAN_CHARS);
  if (!KEYWORD.test(message.subject) && !KEYWORD.test(text)) return null;

  if (KEYWORD.test(message.subject)) {
    const inSubject = only(codes(message.subject.matchAll(SUBJECT_DIGITS)));
    if (inSubject) return inSubject;
  }
  const named = [
    ...new Set([...codes(text.matchAll(AFTER_KEYWORD)), ...codes(text.matchAll(BEFORE_KEYWORD))]),
  ].filter((code) => !isYear(code));
  if (named.length > 0) return only(named);
  return only(codes(text.matchAll(STANDALONE_LINE)));
}

function codes(matches: Iterable<RegExpMatchArray>) {
  const found = new Set<string>();
  for (const match of matches) {
    const raw = match[1];
    if (!raw || !/\d/.test(raw)) continue;
    found.add(/^[\d -]+$/.test(raw) ? raw.replace(/[ -]/g, "") : raw);
  }
  return [...found] satisfies string[];
}

function only(found: readonly string[]) {
  return found.length === 1 ? (found[0] ?? null) : null;
}

function isYear(code: string) {
  return /^(?:19|20)\d\d$/.test(code);
}
