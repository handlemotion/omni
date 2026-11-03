// Why a DNS record is not passing yet, in words a person can act on (ADR 0011). Pure: the mail
// service asks the domain's nameservers, and the answers are read here. Each verdict carries what
// was found, so a wrong value can be shown next to the right one. Imported as
// `@omni/mail-core/dns-diagnostics`.

/** One answer from a nameserver, as `@omni/contracts`' `dnsAnswerSchema` carries it. */
export type DnsAnswer =
  | { status: "found"; values: string[] }
  | { status: "nxdomain" }
  | { status: "nodata" }
  | { status: "error"; code: string };

export type RecordType = "TXT" | "MX" | "CNAME";

export interface ExpectedRecord {
  type: RecordType;
  name: string;
  value: string;
  priority?: number;
}

export type DiagnosticStatus =
  /** As expected. */
  | "ok"
  /** Nothing at that name yet. */
  | "missing"
  /** A record of the right type, with another value. */
  | "wrong_value"
  /** An SPF record exists already: add our include to it rather than a second record. */
  | "spf_merge"
  /** Two or more SPF records: receivers treat that as no SPF at all. Merge them into one. */
  | "spf_multiple"
  /** MX points elsewhere: mail moves to the new host when it changes. */
  | "mx_elsewhere"
  /** Ours is there, but other MX hosts are too, and some mail would still go to them. */
  | "mx_extra"
  /** A CNAME sits at a name that needs another record type; a CNAME can share it with nothing. */
  | "cname_conflict"
  /** Other records sit at the name that needs a CNAME. */
  | "conflict"
  /** The nameservers did not answer; nothing is known. */
  | "unknown";

export interface Diagnostic {
  status: DiagnosticStatus;
  /** One or two sentences for the member. */
  message: string;
  /** What is at the name now (values of the relevant type, or the conflicting records). */
  found: string[];
  /** The value to use instead, when it is not simply the expected one (a merged SPF record). */
  suggestion?: string;
}

/** The lookups a record's diagnosis needs: its own type, and whatever could conflict with it. */
export function queriesFor(record: ExpectedRecord): { name: string; type: RecordType }[] {
  return record.type === "CNAME"
    ? [
        { name: record.name, type: "CNAME" },
        { name: record.name, type: "TXT" },
      ]
    : [
        { name: record.name, type: record.type },
        { name: record.name, type: "CNAME" },
      ];
}

export type Answers = Partial<Record<RecordType, DnsAnswer>>;

const host = (value: string) => value.trim().toLowerCase().replace(/\.$/, "");
const values = (answer: DnsAnswer | undefined) => (answer?.status === "found" ? answer.values : []);
const SPF = /^v=spf1(\s|$)/i;

/**
 * The verdict for one expected record from the answers at its name (`queriesFor`). `matched`
 * overrides how a TXT value is compared: Omni's challenge is compared by hash, never as text.
 */
export function diagnose(
  record: ExpectedRecord,
  answers: Answers,
  options: { matched?: boolean } = {},
): Diagnostic {
  const own = answers[record.type];
  if (own?.status === "error") {
    return {
      status: "unknown",
      message: "The domain's nameservers did not answer. Check again in a moment.",
      found: [],
    };
  }
  if (record.type === "CNAME") return diagnoseCname(record, answers);

  const cname = values(answers.CNAME);
  if (cname.length > 0) {
    return {
      status: "cname_conflict",
      message: `${record.name} is a CNAME to ${cname[0]}. A CNAME cannot share its name with other records: remove it, then add this ${record.type} record.`,
      found: cname.map(host),
    };
  }
  if (record.type === "MX") return diagnoseMx(record, values(own));
  if (SPF.test(record.value)) return diagnoseSpf(record, values(own));

  const found = values(own);
  const ok = options.matched ?? found.some((v) => v.trim() === record.value.trim());
  if (ok) return { status: "ok", message: "Found.", found };
  // Unrelated TXT records (site verifications, SPF) can share the name; only ones that look like
  // an attempt at this record are shown as wrong.
  const prefix = record.value.split("=")[0]!;
  const attempts = found.filter((v) => v.includes("=") && v.split("=")[0] === prefix);
  if (attempts.length > 0) {
    return {
      status: "wrong_value",
      message: "A record is there with another value. Replace it with the value above.",
      found: attempts,
    };
  }
  return { status: "missing", message: "Not found yet.", found: [] };
}

function diagnoseCname(record: ExpectedRecord, answers: Answers): Diagnostic {
  const target = values(answers.CNAME).map(host);
  if (target.includes(host(record.value)))
    return { status: "ok", message: "Found.", found: target };
  if (target.length > 0) {
    return {
      status: "wrong_value",
      message: `${record.name} points to ${target[0]}. Change it to the value above.`,
      found: target,
    };
  }
  const other = values(answers.TXT);
  if (other.length > 0) {
    return {
      status: "conflict",
      message: `${record.name} already has a TXT record. A CNAME cannot share its name: remove the TXT record, then add the CNAME.`,
      found: other,
    };
  }
  return { status: "missing", message: "Not found yet.", found: [] };
}

function diagnoseMx(record: ExpectedRecord, found: string[]): Diagnostic {
  const ours = host(record.value);
  const hosts = found.map((v) => host(v.split(/\s+/).at(-1)!));
  const others = found.filter((_, i) => hosts[i] !== ours);
  if (hosts.includes(ours) && others.length === 0)
    return { status: "ok", message: "Found.", found };
  if (hosts.includes(ours)) {
    return {
      status: "mx_extra",
      message:
        "Other MX records are still there, so some mail would still go to them. Remove them.",
      found: others,
    };
  }
  if (others.length > 0) {
    return {
      status: "mx_elsewhere",
      message:
        "Mail for this domain goes to another host today. Replace those MX records with this one: new mail arrives in Omni from then on, and mail already delivered stays where it is.",
      found: others,
    };
  }
  return { status: "missing", message: "Not found yet.", found: [] };
}

function diagnoseSpf(record: ExpectedRecord, found: string[]): Diagnostic {
  const spf = found.filter((v) => SPF.test(v.trim()));
  const includes = record.value
    .split(/\s+/)
    .filter((term) => /^(include|a|mx|ip4|ip6):/i.test(term));
  const covers = (value: string) => {
    const terms = value.toLowerCase().split(/\s+/);
    return includes.every((term) => terms.includes(term.toLowerCase()));
  };
  if (spf.length === 0) return { status: "missing", message: "Not found yet.", found: [] };
  if (spf.length > 1) {
    return {
      status: "spf_multiple",
      message:
        "There are several SPF records, and receivers then ignore them all. Replace them with this one record:",
      found: spf,
      suggestion: mergeSpf(spf, includes),
    };
  }
  if (covers(spf[0]!)) return { status: "ok", message: "Found.", found: spf };
  return {
    status: "spf_merge",
    message:
      "An SPF record already exists. A domain can have only one, so edit it to this instead of adding a second:",
    found: spf,
    suggestion: mergeSpf(spf, includes),
  };
}

/**
 * One SPF record holding every mechanism of `existing` plus `includes`, ending in the first
 * record's `all` (or `~all`). Duplicates are dropped; `redirect=` is kept from the first record.
 */
export function mergeSpf(existing: string[], includes: string[]): string {
  const terms: string[] = [];
  let all: string | undefined;
  for (const record of existing) {
    for (const term of record.trim().split(/\s+/).slice(1)) {
      if (/^[-~?+]?all$/i.test(term)) {
        all ??= term;
        continue;
      }
      if (!terms.some((t) => t.toLowerCase() === term.toLowerCase())) terms.push(term);
    }
  }
  for (const term of includes) {
    if (!terms.some((t) => t.toLowerCase() === term.toLowerCase())) terms.push(term);
  }
  const redirect = terms.findIndex((t) => /^redirect=/i.test(t));
  // `redirect=` only applies without an `all`; keep the record's own choice.
  if (redirect !== -1 && all !== undefined) terms.splice(redirect, 1);
  return ["v=spf1", ...terms, ...(all ? [all] : redirect === -1 ? ["~all"] : [])].join(" ");
}

// DNS hosts, told apart by their nameservers.

export interface DnsProvider {
  id: string;
  name: string;
  /** Where records are added, in that host's words. */
  steps: string;
  help: string;
}

const PROVIDERS: (DnsProvider & { nameservers: RegExp })[] = [
  {
    id: "cloudflare",
    name: "Cloudflare",
    nameservers: /\.ns\.cloudflare\.com$/,
    steps:
      "In Cloudflare, open the domain, then DNS → Records → Add record. Keep the proxy off (DNS only) for these.",
    help: "https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/",
  },
  {
    id: "godaddy",
    name: "GoDaddy",
    nameservers: /\.domaincontrol\.com$/,
    steps:
      "In GoDaddy, open My Products → the domain → DNS → Add New Record. Use only the part before the domain as the name.",
    help: "https://www.godaddy.com/help/add-a-txt-record-19232",
  },
  {
    id: "namecheap",
    name: "Namecheap",
    nameservers: /\.registrar-servers\.com$/,
    steps:
      "In Namecheap, open Domain List → Manage → Advanced DNS → Add New Record. Use only the part before the domain as the host.",
    help: "https://www.namecheap.com/support/knowledgebase/article.aspx/317/2237/how-do-i-add-txtspfdkimdmarc-records-for-my-domain/",
  },
  {
    id: "route53",
    name: "Amazon Route 53",
    nameservers: /\.awsdns-\d+\.(com|net|org|co\.uk)$/,
    steps:
      "In the Route 53 console, open Hosted zones → the domain → Create record. Put TXT values in quotes.",
    help: "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-creating.html",
  },
  {
    id: "google",
    name: "Google Cloud DNS",
    nameservers: /^ns-cloud-[a-z]\d\.googledomains\.com$/,
    steps: "In Google Cloud, open Network services → Cloud DNS → the zone → Add standard.",
    help: "https://cloud.google.com/dns/docs/records",
  },
  {
    id: "squarespace",
    name: "Squarespace",
    nameservers: /\.squarespacedns\.com$/,
    steps: "In Squarespace, open Domains → the domain → DNS → Add record.",
    help: "https://support.squarespace.com/hc/en-us/articles/360002101888",
  },
  {
    id: "porkbun",
    name: "Porkbun",
    nameservers: /\.porkbun\.com$/,
    steps:
      "In Porkbun, open Domain Management → the domain → DNS → Add. Leave the host empty for the domain itself.",
    help: "https://kb.porkbun.com/article/68-how-to-edit-dns-records",
  },
  {
    id: "vercel",
    name: "Vercel",
    nameservers: /\.vercel-dns\.com$/,
    steps: "In Vercel, open Domains → the domain → DNS Records → Add.",
    help: "https://vercel.com/docs/domains/managing-dns-records",
  },
  {
    id: "digitalocean",
    name: "DigitalOcean",
    nameservers: /^ns\d\.digitalocean\.com$/,
    steps: "In DigitalOcean, open Networking → Domains → the domain, then create each record.",
    help: "https://docs.digitalocean.com/products/networking/dns/how-to/manage-records/",
  },
  {
    id: "gandi",
    name: "Gandi",
    nameservers: /\.gandi\.net$/,
    steps: "In Gandi, open Domain → the domain → DNS Records → Add record.",
    help: "https://docs.gandi.net/en/domain_names/common_operations/dns_records.html",
  },
];

/** The DNS host behind these nameservers, if it is one we have steps for. */
export function detectDnsProvider(nameservers: readonly string[]): DnsProvider | null {
  for (const ns of nameservers.map(host)) {
    const match = PROVIDERS.find((p) => p.nameservers.test(ns));
    if (match) {
      const { nameservers: _pattern, ...provider } = match;
      return provider;
    }
  }
  return null;
}

// Domain Connect (https://www.domainconnect.org), the open standard for applying a service's
// records at the DNS host with one click. Discovery: a `_domainconnect` TXT on the zone names the
// host's API; its `/v2/<domain>/settings` says where the synchronous flow runs.

export interface DomainConnectSettings {
  providerId: string;
  providerName: string;
  urlSyncUX: string;
  urlAPI: string;
}

/** The settings document, or null when it is not one (missing fields, or not https). */
export function parseDomainConnectSettings(json: unknown): DomainConnectSettings | null {
  const s = json as Partial<Record<keyof DomainConnectSettings, unknown>> | null;
  const https = (v: unknown) => typeof v === "string" && /^https:\/\/[^/\s]+/.test(v);
  if (!s || typeof s.providerId !== "string" || !https(s.urlSyncUX) || !https(s.urlAPI)) {
    return null;
  }
  return {
    providerId: s.providerId,
    providerName: typeof s.providerName === "string" ? s.providerName : s.providerId,
    urlSyncUX: (s.urlSyncUX as string).replace(/\/+$/, ""),
    urlAPI: (s.urlAPI as string).replace(/\/+$/, ""),
  };
}

/** The API host a `_domainconnect` TXT names (`api.example.com/path`), or null. */
export function domainConnectHost(txt: readonly string[]): string | null {
  const value = txt.map((v) => v.trim()).find((v) => /^[a-z0-9.-]+(\/[\w./-]*)?$/i.test(v));
  return value ? value.replace(/\/+$/, "") : null;
}

/**
 * The query string of the synchronous apply flow, in the order it is signed. `domain` is the
 * zone, `host` the part of the claimed domain below it ("" for the zone itself).
 */
export function domainConnectQuery(input: {
  domain: string;
  host: string;
  params: Record<string, string>;
  redirectUri?: string;
  state?: string;
}): string {
  const query = new URLSearchParams();
  query.set("domain", input.domain);
  if (input.host) query.set("host", input.host);
  for (const [key, value] of Object.entries(input.params)) query.set(key, value);
  if (input.redirectUri) query.set("redirect_uri", input.redirectUri);
  if (input.state) query.set("state", input.state);
  return query.toString();
}

/** The apply URL: the settings' sync UX, the template, and the (signed) query. */
export function domainConnectApplyUrl(input: {
  settings: DomainConnectSettings;
  providerId: string;
  serviceId: string;
  query: string;
  signature?: { sig: string; keyHost: string };
}): string {
  const base = `${input.settings.urlSyncUX}/v2/domainTemplates/providers/${encodeURIComponent(input.providerId)}/services/${encodeURIComponent(input.serviceId)}/apply`;
  const signed = input.signature
    ? `&sig=${encodeURIComponent(input.signature.sig)}&key=${encodeURIComponent(input.signature.keyHost)}`
    : "";
  return `${base}?${input.query}${signed}`;
}
