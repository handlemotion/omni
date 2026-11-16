// What "the same address" and "a company's domain" mean, for every module (ADR 0035 decision 5).
// Mail participants, Storage grants, sign-in emails, helpdesk customers and CRM people are all
// keyed by the address this normalises, and companies by its domain. Pure; imported as
// `@omni/mail-core/addresses`.

/** Mail hosts shared by many unrelated people: their domain says nothing about a company. */
export const WEBMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.de",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "fastmail.com",
  "hey.com",
]);

/** The form every module stores and compares an address in: trimmed and lowercased. */
export function normalizeAddress(address: string) {
  return address.trim().toLowerCase();
}

/**
 * Input that must be exactly one address (`local@domain`: one `@`, no spaces, a dotted domain),
 * in its normalized form with any trailing dot on the domain dropped; null when it is not one.
 * For values a person types as a key, where a malformed one would be stored and never match.
 */
export function parseAddress(input: string): string | null {
  const address = normalizeAddress(input);
  const at = address.indexOf("@");
  if (at <= 0 || at !== address.lastIndexOf("@") || /\s/.test(address)) return null;
  const domain = address.slice(at + 1).replace(/\.$/, "");
  if (!domain.includes(".") || domain.startsWith(".") || domain.includes("..")) return null;
  return `${address.slice(0, at)}@${domain}`;
}

/** Whether two spellings are the same address. */
export function sameAddress(a: string, b: string) {
  return normalizeAddress(a) === normalizeAddress(b);
}

/** The address's domain, lowercased, or null when it has none. */
export function domainOf(address: string) {
  const normalized = normalizeAddress(address);
  const at = normalized.lastIndexOf("@");
  if (at === -1) return null;
  return normalized.slice(at + 1) || null;
}

/** Whether a domain is shared webmail, so it can stand for no company. */
export function isWebmailDomain(domain: string) {
  return WEBMAIL_DOMAINS.has(normalizeAddress(domain));
}

/** The address's company domain and a name guessed from it; both null for webmail or no domain. */
export function companyFromAddress(address: string) {
  const domain = domainOf(address);
  if (!domain || isWebmailDomain(domain)) return { domain: null, company: null };
  // `mail.acme.co.uk` → "Acme": the label before the public suffix, roughly.
  const labels = domain.split(".");
  const short = labels.length > 2 && labels.at(-2)!.length <= 3 ? labels.at(-3) : labels.at(-2);
  const company = short ? short[0]!.toUpperCase() + short.slice(1) : null;
  return { domain, company };
}
