// A domain's DNS as the member's host serves it right now (ADR 0011): one batch of authoritative
// lookups (through the mail service) for Omni's challenge and every provider record, read into
// per-record verdicts, plus which DNS host this is and whether it offers Domain Connect for our
// template. Stored as the claim's `last_check`, so a reload, iOS and the realtime push all show
// the same verdicts.
import type { DnsAnswer } from "@omni/contracts";
import { challengeMatches, signDomainConnectQuery } from "@omni/crypto";
import type { DomainCheck, DomainRecordDiagnostic, MailDomainRecord, schema } from "@omni/db";
import {
  type Answers,
  detectDnsProvider,
  diagnose,
  domainConnectApplyUrl,
  domainConnectHost,
  domainConnectQuery,
  type ExpectedRecord,
  parseDomainConnectSettings,
  queriesFor,
  type RecordType,
} from "@omni/mail-core/dns-diagnostics";
import { challengeRecordName } from "@omni/mail-core/domains";
import { lookupDns, type DomainDeps } from "./domains.ts";

/**
 * Our Domain Connect templates (docs/domain-connect/): `mail` carries Purelymail's records with
 * the challenge, `verify` the challenge alone (a domain that stays on its own mail host).
 */
export const DOMAIN_CONNECT_SERVICES: Partial<Record<MailProvider, "mail" | "verify">> = {
  purelymail: "mail",
  imap: "verify",
};

type MailProvider = (typeof schema.mailProvider.enumValues)[number];

const CHALLENGE: Omit<ExpectedRecord, "name"> = { type: "TXT", value: "omni-challenge=" };

/** The verdicts for a domain's challenge (when `challengeHash` is set) and `records`. */
export async function inspectDomain(
  deps: DomainDeps,
  input: {
    domain: string;
    challengeHash: string | null;
    records: MailDomainRecord[];
    provider: MailProvider;
    /** The last check, whose host and Domain Connect findings are reused instead of fetched again. */
    previous?: DomainCheck | null;
  },
): Promise<{ check: DomainCheck; challengeFound: boolean | null }> {
  const { domain } = input;
  const challenge = input.challengeHash
    ? { ...CHALLENGE, name: challengeRecordName(domain) }
    : null;
  const expected = [...(challenge ? [challenge] : []), ...input.records];
  const queries = new Map<string, { name: string; type: RecordType | "TXT" }>();
  for (const record of expected) {
    for (const q of queriesFor(record)) queries.set(`${q.type} ${q.name}`, q);
  }
  const discover = input.previous === undefined || input.previous === null;
  const dcName = `_domainconnect.${domain}`;
  if (discover) queries.set(`TXT ${dcName}`, { name: dcName, type: "TXT" });

  const result = await lookupDns(deps, { domain, queries: [...queries.values()] });
  const at = (name: string): Answers => {
    const answers: Answers = {};
    for (const a of result.answers) {
      if (a.name === name && a.type !== "NS") answers[a.type] = a.answer;
    }
    return answers;
  };

  let challengeFound: boolean | null = null;
  let challengeDiagnostic: DomainRecordDiagnostic | null = null;
  if (challenge) {
    const answers = at(challenge.name);
    const txt: DnsAnswer | undefined = answers.TXT;
    challengeFound =
      txt?.status === "error"
        ? null
        : txt?.status === "found" && (await challengeMatches(txt.values, input.challengeHash!));
    challengeDiagnostic = {
      type: "TXT",
      name: challenge.name,
      ...diagnose(challenge, answers, { matched: challengeFound === true }),
    };
  }
  const records = input.records.map((record): DomainRecordDiagnostic => ({
    type: record.type,
    name: record.name,
    ...diagnose(record, at(record.name)),
  }));

  const host = discover ? detectDnsProvider(result.nameservers) : (input.previous?.host ?? null);
  const domainConnect = discover
    ? await discoverDomainConnect(deps, {
        domain,
        zone: result.zone ?? domain,
        txt: at(dcName).TXT,
        serviceId: DOMAIN_CONNECT_SERVICES[input.provider],
      })
    : (input.previous?.domainConnect ?? null);

  return {
    challengeFound,
    check: {
      checkedAt: new Date().toISOString(),
      zone: result.zone,
      nameservers: result.nameservers,
      host,
      domainConnect,
      challenge: challengeDiagnostic,
      records,
    },
  };
}

/**
 * The host's Domain Connect settings, if it offers the standard and has our template. Off unless
 * DOMAIN_CONNECT_PROVIDER_ID is set. Any failure (no TXT, a host that does not answer, a template
 * it has not onboarded) reads as "not offered": the member adds the records by hand.
 */
async function discoverDomainConnect(
  deps: DomainDeps,
  input: { domain: string; zone: string; txt: DnsAnswer | undefined; serviceId?: string },
): Promise<DomainCheck["domainConnect"]> {
  const providerId = deps.config.DOMAIN_CONNECT_PROVIDER_ID;
  if (!providerId || !input.serviceId) return null;
  try {
    let txt = input.txt;
    // `_domainconnect` lives on the zone; a claimed subdomain asks its zone.
    if (input.zone !== input.domain) {
      const name = `_domainconnect.${input.zone}`;
      const zoneAnswer = await lookupDns(deps, {
        domain: input.zone,
        queries: [{ name, type: "TXT" }],
      });
      txt = zoneAnswer.answers[0]?.answer;
    }
    const api = txt?.status === "found" ? domainConnectHost(txt.values) : null;
    if (!api) return null;
    const settings = parseDomainConnectSettings(
      await fetchJson(`https://${api}/v2/${input.zone}/settings`),
    );
    if (!settings) return null;
    const template = await fetch(
      `${settings.urlAPI}/v2/domainTemplates/providers/${encodeURIComponent(providerId)}/services/${encodeURIComponent(input.serviceId)}`,
      { signal: AbortSignal.timeout(3_000) },
    );
    await template.body?.cancel();
    if (!template.ok) return null;
    return {
      providerName: settings.providerName,
      urlSyncUX: settings.urlSyncUX,
      urlAPI: settings.urlAPI,
      zone: input.zone,
    };
  } catch (error) {
    deps.log.info("domains.domain_connect_unavailable", { error });
    return null;
  }
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) return null;
  return response.json().catch(() => null);
}

/**
 * The one-click URL for a check that found Domain Connect. It carries the challenge value, so it
 * exists only while the value is in hand (right after it is made). Signed when the template
 * requires it (DOMAIN_CONNECT_PRIVATE_KEY and DOMAIN_CONNECT_KEY_HOST).
 */
export async function domainConnectUrl(
  deps: Pick<DomainDeps, "config">,
  input: {
    check: DomainCheck | null;
    claimId: string;
    domain: string;
    provider: MailProvider;
    challengeValue: string | undefined;
    records: MailDomainRecord[];
  },
): Promise<string | null> {
  const dc = input.check?.domainConnect;
  const { config } = deps;
  const serviceId = DOMAIN_CONNECT_SERVICES[input.provider];
  if (!dc || !input.challengeValue || !config.DOMAIN_CONNECT_PROVIDER_ID || !serviceId) return null;
  // The templates fix each TXT value's prefix (docs/domain-connect), so only the part after it
  // travels as a variable.
  const challenge = afterPrefix(input.challengeValue, "omni-challenge=");
  const ownershipValue = input.records.find((r) => r.check === "ownership")?.value;
  const ownership = ownershipValue && afterPrefix(ownershipValue, "purelymail_ownership_proof=");
  if (!challenge || ownership === null) return null;
  const query = domainConnectQuery({
    domain: dc.zone,
    host: input.domain === dc.zone ? "" : input.domain.slice(0, -(dc.zone.length + 1)),
    params: { challenge, ...(ownership ? { ownership } : {}) },
    redirectUri: `${config.auth.webAppURL ?? config.auth.baseURL}/onboarding`,
    state: input.claimId,
  });
  const signature =
    config.DOMAIN_CONNECT_PRIVATE_KEY && config.DOMAIN_CONNECT_KEY_HOST
      ? {
          sig: await signDomainConnectQuery(query, config.DOMAIN_CONNECT_PRIVATE_KEY),
          keyHost: config.DOMAIN_CONNECT_KEY_HOST,
        }
      : undefined;
  return domainConnectApplyUrl({
    settings: { ...dc, providerId: "" },
    providerId: config.DOMAIN_CONNECT_PROVIDER_ID,
    serviceId,
    query,
    signature,
  });
}

/** The text after `prefix`, or null when the value does not start with it. */
function afterPrefix(value: string, prefix: string): string | null {
  const trimmed = value.trim();
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : null;
}
