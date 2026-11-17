import { domainToASCII, domainToUnicode } from "node:url";

/** Which provider check a DNS record belongs to. */
export type DnsCheck = "ownership" | "mx" | "spf" | "dkim" | "dmarc";

export interface DnsRecord {
  check: DnsCheck;
  type: "TXT" | "MX" | "CNAME";
  /** Fully qualified host name. DNS dashboards accept it; it stays right for subdomains. */
  name: string;
  value: string;
  priority?: number;
}

export interface DnsRecordStatus extends DnsRecord {
  /** The provider saw this record as it should be at the last check. */
  verified: boolean;
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

const NOT_A_DOMAIN = "that is not a domain name";

/**
 * The canonical form of a domain someone typed, or why it cannot be claimed. Lowercase, punycode,
 * no scheme, path, port or trailing dot, so every spelling of a domain claims the same row. An
 * internationalized name must decode cleanly and stay in one script (see `labelProblem`).
 */
export const parseDomain: (input: string) => { domain: string } | { error: string } = (input) => {
  if (input.length > 2048) return { error: NOT_A_DOMAIN };
  let text = input.trim().replace(/^@/, "");
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const end = text.search(/[/?#]/);
  if (end !== -1) text = text.slice(0, end);
  if (!text || /[@:\s\\]/.test(text)) return { error: NOT_A_DOMAIN };
  let host: string;
  try {
    host = new URL(`http://${text}`).hostname;
  } catch {
    return { error: NOT_A_DOMAIN };
  }
  host = host.replace(/\.$/, "");
  if (host.length > 253) return { error: NOT_A_DOMAIN };
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) {
    return { error: NOT_A_DOMAIN };
  }
  if (/^\d+$/.test(labels.at(-1)!)) return { error: NOT_A_DOMAIN };
  const tld = unicodeLabel(labels.at(-1)!);
  for (const label of labels) {
    const problem = labelProblem(label, tld);
    if (problem) return { error: problem };
  }
  return { domain: host };
};

/** `parseDomain` for callers that only need the canonical form: null when it is not a domain. */
export function normalizeDomain(input: string) {
  const parsed = parseDomain(input);
  return "domain" in parsed ? parsed.domain : null;
}

function unicodeLabel(label: string) {
  if (!label.startsWith("xn--")) return label;
  const unicode = domainToUnicode(label);
  return unicode !== label && domainToASCII(unicode) === label ? unicode : null;
}

const SCRIPTS = [
  "Latin",
  "Cyrillic",
  "Greek",
  "Armenian",
  "Georgian",
  "Hebrew",
  "Arabic",
  "Thaana",
  "Devanagari",
  "Bengali",
  "Gurmukhi",
  "Gujarati",
  "Tamil",
  "Telugu",
  "Kannada",
  "Malayalam",
  "Sinhala",
  "Thai",
  "Lao",
  "Tibetan",
  "Myanmar",
  "Khmer",
  "Ethiopic",
  "Hangul",
  "Hiragana",
  "Katakana",
  "Bopomofo",
  "Han",
].map((name) => ({ name, pattern: new RegExp(`^\\p{Script=${name}}$`, "u") }));

const ALLOWED_MIXES = [
  new Set(["Latin", "Han", "Hiragana", "Katakana"]),
  new Set(["Latin", "Han", "Bopomofo"]),
  new Set(["Latin", "Han", "Hangul"]),
];

const LATIN_LOOKALIKES = new Set("асԁеһіјӏорԛѕԝхуъьҽпгѵѡ");

function labelProblem(label: string, tld: string | null) {
  const unicode = unicodeLabel(label);
  if (unicode === null) return "that domain name is not valid punycode";
  if (unicode === label && !label.startsWith("xn--")) return null;
  const scripts = new Set<string>();
  for (const char of unicode) {
    if (/^[\p{Script=Common}\p{Script=Inherited}]$/u.test(char)) {
      if (/^\p{Cf}$/u.test(char)) return "that domain name has invisible characters";
      continue;
    }
    scripts.add(SCRIPTS.find((s) => s.pattern.test(char))?.name ?? `other:${char}`);
  }
  if (scripts.size > 1 && !ALLOWED_MIXES.some((mix) => [...scripts].every((s) => mix.has(s)))) {
    return "that domain name mixes alphabets, so it could pass for another name";
  }
  const letters = [...unicode].filter((c) => /^\p{L}$/u.test(c));
  const cyrillicTld = tld !== null && /\p{Script=Cyrillic}/u.test(tld);
  if (
    scripts.size === 1 &&
    scripts.has("Cyrillic") &&
    !cyrillicTld &&
    letters.every((c) => LATIN_LOOKALIKES.has(c))
  ) {
    return "that domain name is spelled with letters that look Latin, so it could pass for another name";
  }
  return null;
}

/**
 * The domains above `domain` that could be claimed on their own, nearest first. Not the last label
 * alone: `com` is never a claim. A lock on any of these covers `domain` too.
 */
export function parentDomains(domain: string) {
  const labels = domain.split(".");
  const parents: string[] = [];
  for (let i = 1; i < labels.length - 1; i++) parents.push(labels.slice(i).join("."));
  return parents satisfies string[];
}

/** Where Omni's ownership challenge for `domain` lives: a TXT record only its DNS can publish. */
export function challengeRecordName(domain: string) {
  return `_omni-challenge.${domain}`;
}

const LOCAL_PART = /^[a-z0-9](?:[a-z0-9_-]|\.(?!\.))*(?<!\.)$/;

/**
 * The full address for a mailbox on `domain`, from a local part ("Rodrigo") or a full address on
 * that same domain ("rodrigo@acme.com"). Null if it is not a valid mailbox on that domain.
 */
export function mailboxAddress(input: string, domain: string) {
  const text = input.trim().toLowerCase();
  const at = text.lastIndexOf("@");
  const local = at === -1 ? text : text.slice(0, at);
  if (at !== -1 && normalizeDomain(text.slice(at + 1)) !== domain) return null;
  if (local.length > 64 || !LOCAL_PART.test(local)) return null;
  return `${local}@${domain}`;
}

/**
 * The records Purelymail asks for, from https://purelymail.com/docs/domainDocs. `ownershipCode`
 * is the account's ownership proof value (API `getOwnershipCode`). Optional autoconfig records
 * are left out: Omni does not need them and Purelymail does not check them.
 */
export function purelymailDnsRecords(domain: string, ownershipCode: string) {
  return [
    { check: "ownership", type: "TXT", name: domain, value: ownershipCode },
    { check: "mx", type: "MX", name: domain, value: "mailserver.purelymail.com", priority: 50 },
    { check: "spf", type: "TXT", name: domain, value: "v=spf1 include:_spf.purelymail.com ~all" },
    ...[1, 2, 3].map((n) => {
      const result: DnsRecord = {
        check: "dkim",
        type: "CNAME",
        name: `purelymail${n}._domainkey.${domain}`,
        value: `key${n}.dkimroot.purelymail.com`,
      };
      return result;
    }),
    { check: "dmarc", type: "CNAME", name: `_dmarc.${domain}`, value: "dmarcroot.purelymail.com" },
  ] satisfies DnsRecord[];
}

/** What Purelymail reports about one domain on the account. */
export interface PurelymailDomainState {
  /** On the account: the ownership record was found when it was added. */
  added: boolean;
  checks: Record<DnsCheck, boolean>;
  /**
   * The domain reads `.`, `-`, `_` and `+` in a name as the start of a tag (Purelymail's default
   * for a new domain), so it refuses usernames that contain one. False when not on the account.
   */
  symbolicSubaddressing: boolean;
}

/**
 * Reads `domain` out of a `listDomains` result (`{ domains: ApiDomainInfo[] }`). A domain that is
 * not on the account has proven nothing yet. Throws when the answer is not that shape, so a
 * changed API reads as an error rather than as "waiting" forever.
 */
export const purelymailDomainState: (result: unknown, domain: string) => PurelymailDomainState = (
  result,
  domain,
) => {
  const domains = (result as { domains?: unknown } | null)?.domains;
  if (!Array.isArray(domains)) throw new TypeError("listDomains: no domains array");
  const entry = domains.find(
    (d: { name?: unknown }) => typeof d?.name === "string" && normalizeDomain(d.name) === domain,
  ) as { dnsSummary?: Record<string, unknown> } | undefined;
  if (!entry) {
    return {
      added: false,
      checks: { ownership: false, mx: false, spf: false, dkim: false, dmarc: false },
      symbolicSubaddressing: false,
    };
  }
  const summary = entry.dnsSummary;
  const flag = (name: string) => {
    const value = summary?.[name];
    if (typeof value !== "boolean") throw new TypeError(`listDomains: dnsSummary.${name} missing`);
    return value;
  };
  const checks = {
    ownership: true,
    mx: flag("passesMx"),
    spf: flag("passesSpf"),
    dkim: flag("passesDkim"),
    dmarc: flag("passesDmarc"),
  };
  const symbolic = (entry as { symbolicSubaddressing?: unknown }).symbolicSubaddressing;
  if (typeof symbolic !== "boolean") {
    throw new TypeError("listDomains: symbolicSubaddressing missing");
  }
  return { added: true, checks, symbolicSubaddressing: symbolic };
};

/**
 * Why Purelymail would refuse `address` as a new user, or null. With symbolic subaddressing on,
 * it refuses any name with a symbol (verified live 2026-11-13: `.`, `-`, `_` and `+` all answer
 * `invalidUserName`), because mail to `first.last@` would route to `firstlast@`.
 */
export function purelymailUsernameProblem(address: string, symbolicSubaddressing: boolean) {
  const at = address.lastIndexOf("@");
  const local = address.slice(0, at);
  if (!symbolicSubaddressing || /^[a-z0-9]+$/.test(local)) return null;
  return (
    `${address.slice(at + 1)} treats ".", "-" and "_" in a name as the start of a tag, so ` +
    `"${local}" cannot be its own mailbox there. Use only letters and digits.`
  );
}

/** Each record with the result of its check. */
export function withChecks(records: DnsRecord[], checks: Record<DnsCheck, boolean>) {
  return records.map((record) => ({
    ...record,
    verified: checks[record.check],
  })) satisfies DnsRecordStatus[];
}
