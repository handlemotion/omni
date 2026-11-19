import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import type { ServerEndpoint } from "./mailbox-connection.ts";

/** Which mail hosts may skip encryption or sit on a private network. Hostnames, lowercase. */
export interface MailHostPolicy {
  /** Hosts a `secure: false` endpoint may talk to in cleartext when STARTTLS is not offered. */
  plaintextHosts: ReadonlySet<string>;
  /** Hosts a member may point a mailbox at although they resolve to a private address. */
  privateHosts: ReadonlySet<string>;
}

export const hostList = (value: string | undefined) =>
  new Set(
    (value ?? "")
      .split(",")
      .map((s) => normalize(s))
      .filter(Boolean),
  );

const normalize = (host: string) =>
  host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");

function isLoopback(host: string) {
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  return ipaddr.isValid(host) && ipaddr.process(host).range() === "loopback";
}

/**
 * The endpoint with `allowPlaintext` decided by policy: implicit TLS needs none, loopback and
 * listed hosts may stay cleartext (loopback never crosses a wire), everything else must upgrade
 * with STARTTLS.
 */
export function withPlaintextPolicy(
  endpoint: ServerEndpoint,
  policy: Pick<MailHostPolicy, "plaintextHosts">,
) {
  const host = normalize(endpoint.host);
  return {
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.secure,
    allowPlaintext: !endpoint.secure && (isLoopback(host) || policy.plaintextHosts.has(host)),
  } satisfies ServerEndpoint;
}

/** ImapFlow's TLS options: STARTTLS is required unless the endpoint may stay cleartext. */
export const imapTls = (endpoint: ServerEndpoint) =>
  endpoint.secure || endpoint.allowPlaintext
    ? { secure: endpoint.secure }
    : { secure: false, doSTARTTLS: true };

/** Nodemailer's TLS options, with the same rule as `imapTls`. */
export const smtpTls = (endpoint: ServerEndpoint) => ({
  secure: endpoint.secure,
  requireTLS: !endpoint.secure && !endpoint.allowPlaintext,
});

const isPublic = (address: string) =>
  ipaddr.isValid(address) && ipaddr.process(address).range() === "unicast";

export type HostCheck = { ok: true; addresses: string[] } | { ok: false };

/**
 * Resolves a member-supplied mail host and refuses it unless every address it resolves to is
 * public, so a mailbox can't be pointed at the mail service's own network. Listed private hosts
 * pass as they are. On success, `addresses` are what to connect to, in order, so a second
 * lookup can't resolve differently.
 */
export async function checkMailHost(host: string, policy: Pick<MailHostPolicy, "privateHosts">) {
  const name = normalize(host);
  if (policy.privateHosts.has(name)) return { ok: true, addresses: [host] } satisfies HostCheck;
  const addresses = ipaddr.isValid(name)
    ? [ipaddr.process(name).toString()]
    : await lookup(name, { all: true, verbatim: true }).then(
        (found) => found.map((a) => a.address),
        () => [],
      );
  if (addresses.length === 0 || !addresses.every(isPublic)) {
    return { ok: false } satisfies HostCheck;
  }
  return { ok: true, addresses } satisfies HostCheck;
}
