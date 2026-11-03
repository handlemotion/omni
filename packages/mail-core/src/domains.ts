// Mail domains and mailbox addresses for onboarding, and Purelymail's DNS setup read as data.
// Pure: the mail service calls Purelymail's API and hands the answers here. Imported by the Worker
// and the mail service as `@omni/mail-core/domains`.

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

/**
 * The canonical form of a domain someone typed, or null if it is not one. Lowercase, punycode,
 * no scheme, path, port or trailing dot, so every spelling of a domain claims the same row.
 */
export function normalizeDomain(input: string): string | null {
  // A domain is at most 253 characters; anything far longer is not one, whatever follows.
  if (input.length > 2048) return null;
  let text = input.trim().replace(/^@/, "");
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  // Drop a path, query or fragment. `search` with one character class is linear; a `[/?#].*$`
  // replace is quadratic on input like "####…".
  const end = text.search(/[/?#]/);
  if (end !== -1) text = text.slice(0, end);
  // `user@host` and `host:port` would parse as a URL's credentials or port; neither is a domain.
  if (!text || /[@:\s\\]/.test(text)) return null;
  let host: string;
  try {
    host = new URL(`http://${text}`).hostname;
  } catch {
    return null;
  }
  host = host.replace(/\.$/, "");
  if (host.length > 253) return null;
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
  // An all-digit last label is an IP address, not a domain.
  if (/^\d+$/.test(labels.at(-1)!)) return null;
  return host;
}

// Conservative on purpose: `+` is Purelymail's subaddress separator, and quoted or exotic local
// parts break more mail clients than they help.
const LOCAL_PART = /^[a-z0-9](?:[a-z0-9_-]|\.(?!\.))*(?<!\.)$/;

/**
 * The full address for a mailbox on `domain`, from a local part ("Rodrigo") or a full address on
 * that same domain ("rodrigo@acme.com"). Null if it is not a valid mailbox on that domain.
 */
export function mailboxAddress(input: string, domain: string): string | null {
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
export function purelymailDnsRecords(domain: string, ownershipCode: string): DnsRecord[] {
  return [
    { check: "ownership", type: "TXT", name: domain, value: ownershipCode },
    { check: "mx", type: "MX", name: domain, value: "mailserver.purelymail.com", priority: 50 },
    { check: "spf", type: "TXT", name: domain, value: "v=spf1 include:_spf.purelymail.com ~all" },
    ...[1, 2, 3].map((n): DnsRecord => ({
      check: "dkim",
      type: "CNAME",
      name: `purelymail${n}._domainkey.${domain}`,
      value: `key${n}.dkimroot.purelymail.com`,
    })),
    { check: "dmarc", type: "CNAME", name: `_dmarc.${domain}`, value: "dmarcroot.purelymail.com" },
  ];
}

/** What Purelymail reports about one domain on the account. */
export interface PurelymailDomainState {
  /** On the account: the ownership record was found when it was added. */
  added: boolean;
  checks: Record<DnsCheck, boolean>;
}

/**
 * Reads `domain` out of a `listDomains` result (`{ domains: ApiDomainInfo[] }`). A domain that is
 * not on the account has proven nothing yet. Throws when the answer is not that shape, so a
 * changed API reads as an error rather than as "waiting" forever.
 */
export function purelymailDomainState(result: unknown, domain: string): PurelymailDomainState {
  const domains = (result as { domains?: unknown } | null)?.domains;
  if (!Array.isArray(domains)) throw new TypeError("listDomains: no domains array");
  const entry = domains.find(
    (d: { name?: unknown }) => typeof d?.name === "string" && normalizeDomain(d.name) === domain,
  ) as { dnsSummary?: Record<string, unknown> } | undefined;
  if (!entry) {
    return {
      added: false,
      checks: { ownership: false, mx: false, spf: false, dkim: false, dmarc: false },
    };
  }
  const summary = entry.dnsSummary;
  const flag = (name: string) => {
    const value = summary?.[name];
    if (typeof value !== "boolean") throw new TypeError(`listDomains: dnsSummary.${name} missing`);
    return value;
  };
  return {
    added: true,
    checks: {
      ownership: true,
      mx: flag("passesMx"),
      spf: flag("passesSpf"),
      dkim: flag("passesDkim"),
      dmarc: flag("passesDmarc"),
    },
  };
}

/** Each record with the result of its check. */
export function withChecks(
  records: DnsRecord[],
  checks: Record<DnsCheck, boolean>,
): DnsRecordStatus[] {
  return records.map((record) => ({ ...record, verified: checks[record.check] }));
}
