// Domain claims (ADR 0010): proving an org controls a domain before it is locked to that org, and
// keeping that proof current. Routes and the scheduled re-check share this module; the mail
// service answers the DNS questions (it can ask a zone's nameservers directly) and does the
// provider work. Every step is safe to repeat: the database writes are conditional, and a check
// that changes nothing records nothing.
import {
  DNS_LOOKUP_PATH,
  dnsLookupResultSchema,
  PROVISION_DOMAIN_PATH,
  provisionDomainResultSchema,
  type DnsAnswer,
  type DnsLookupBody,
} from "@omni/contracts";
import { challengeMatches, newChallenge } from "@omni/crypto";
import {
  advanceOrgSetup,
  conflictingLock,
  type Db,
  type DomainAuditAction,
  type DomainClaim,
  type DomainSetup,
  listVerifiedLocks,
  lockClaim,
  openClaim,
  orgOwnerEmails,
  recordAudit,
  recordChallengeState,
  saveMailDomain,
  schema,
  touchClaim,
} from "@omni/db";
import { challengeRecordName } from "@omni/mail-core/domains";
import { eq } from "drizzle-orm";
import { systemMailSender } from "./context.ts";
import { inspectDomain } from "./dns-check.ts";
import { callMailService, MailServiceError, type MailServiceScope } from "./mail-service.ts";

export interface DomainDeps extends MailServiceScope {
  db: Db;
  /** Cloudflare Email Sending, for notices to owners. */
  email: SendEmail;
  waitUntil(promise: Promise<unknown>): void;
}

/** A refusal with the status the route answers. */
export class DomainError extends Error {
  override name = "DomainError";
  readonly status: 400 | 403 | 404 | 409 | 410 | 422 | 429 | 502;
  constructor(status: DomainError["status"], message: string) {
    super(message);
    this.status = status;
  }
}

function fromMailService(error: unknown): never {
  if (error instanceof MailServiceError) throw new DomainError(error.status, error.message);
  throw error;
}

/** The domain's own nameservers' answers, through the mail service. */
export function lookupDns(scope: MailServiceScope, body: DnsLookupBody) {
  return callMailService(scope, DNS_LOOKUP_PATH, body, dnsLookupResultSchema).catch(
    fromMailService,
  );
}

/**
 * Resumable setup (ADR 0009): a claimed domain counts as added; once it is locked and every
 * provider record passed (`domainView(...).verified`), as DNS verified.
 */
export function advanceDomainStep(db: Db, orgId: string, view: { verified: boolean }) {
  return advanceOrgSetup(db, orgId, view.verified ? "dns_verified" : "domain_added");
}

/**
 * What the onboarding screen shows for a domain, with the last check's verdict on each record.
 * `challengeValue` (and the one-click URL that carries it) only right after the value is made.
 */
export function domainView(
  setup: DomainSetup,
  options: {
    challengeValue?: string;
    addError?: string;
    domainConnectUrl?: string | null;
    now?: Date;
  } = {},
) {
  const { claim, lock } = setup;
  const now = options.now ?? new Date();
  const domain = (claim?.domain ?? lock?.domain)!;
  const status = lock ? "verified" : claim!.expiresAt <= now ? "expired" : "pending";
  const check = claim?.lastCheck ?? null;
  const diagnosticOf = (type: string, name: string) =>
    check?.records.find((d) => d.type === type && d.name === name) ?? null;
  return {
    /** The claim's id; the lock shares it. A legacy lock (no claim) has only its own. */
    id: (claim?.id ?? lock?.id)!,
    domain,
    /** `pending`: waiting for the challenge. `verified`: locked to this workspace. */
    status: status as "pending" | "verified" | "expired",
    /** `purelymail`: records to add below. `imap`: mailboxes are existing logins on your host. */
    provider: (lock?.provider ?? claim?.provider)!,
    /** Omni's ownership record. Its value is shown once, when it is made; null for legacy locks. */
    challenge: claim
      ? {
          type: "TXT" as const,
          name: challengeRecordName(domain),
          value: options.challengeValue ?? null,
          verified: claim.status === "verified" && lock?.dnsLostAt == null,
          /** Why it is not passing yet, as the domain's nameservers answered at the last check. */
          diagnostic: check?.challenge ?? null,
        }
      : null,
    records: (lock?.dnsRecords ?? claim?.dnsRecords ?? []).map((record) => ({
      ...record,
      diagnostic: diagnosticOf(record.type, record.name),
    })),
    /** Who serves the domain's DNS, with where to add records there, when it is a host we know. */
    dnsHost: check?.host ?? null,
    /**
     * One-click setup at the DNS host (Domain Connect), when it has our template. `url` is set
     * only while the challenge value is in hand; without it, make a new value to get one.
     */
    domainConnect: check?.domainConnect
      ? { providerName: check.domainConnect.providerName, url: options.domainConnectUrl ?? null }
      : null,
    /** The provider accepted the domain, so mailboxes can be created on it. */
    added: lock?.addedAt != null,
    /** Locked and every provider record passed at the last check. */
    verified: lock?.verifiedAt != null,
    /** The challenge left DNS: sending from the domain is paused until it is back. */
    dnsLost: lock?.dnsLostAt != null,
    checkedAt: (lock?.checkedAt ?? claim?.checkedAt)?.toISOString() ?? null,
    /** When a pending claim stops waiting. */
    expiresAt: lock ? null : (claim?.expiresAt.toISOString() ?? null),
    /** Why the provider would not add it yet, in its words (usually: no ownership record). */
    ...(options.addError ? { addError: options.addError } : {}),
  };
}

export type DomainView = ReturnType<typeof domainView>;

/** Whether the challenge TXT is in DNS: `null` when DNS gave no answer (says nothing either way). */
async function challengeInDns(scope: MailServiceScope, domain: string, hash: string) {
  const name = challengeRecordName(domain);
  const result = await lookupDns(scope, { domain, queries: [{ name, type: "TXT" }] });
  const answer: DnsAnswer = result.answers[0]!.answer;
  if (answer.status === "error") return null;
  return answer.status === "found" && (await challengeMatches(answer.values, hash));
}

/**
 * Opens a claim on `domain` for the member's org and returns it with the challenge to publish.
 * Refused when another org locks the domain or a parent of it, or past the pending cap.
 */
export async function claimDomain(
  deps: DomainDeps,
  member: { id: string; orgId: string },
  domain: string,
) {
  const { db } = deps;
  const conflict = await conflictingLock(db, member.orgId, domain);
  if (conflict) {
    throw new DomainError(
      409,
      conflict.domain === domain
        ? `${domain} is already set up by another workspace`
        : `${domain} is under ${conflict.domain}, which another workspace set up`,
    );
  }
  // The provider's records first: a failure here must not leave a claim whose one-time
  // challenge value was never shown.
  const provision = await callMailService(
    deps,
    PROVISION_DOMAIN_PATH,
    { domain, add: false },
    provisionDomainResultSchema,
  ).catch(fromMailService);
  const challenge = await newChallenge();
  const opened = await openClaim(db, {
    orgId: member.orgId,
    domain,
    memberId: member.id,
    challengeHash: challenge.hash,
    provider: provision.provider,
    dnsRecords: provision.provider === "purelymail" ? provision.records : [],
  });
  if ("error" in opened) {
    throw new DomainError(
      409,
      "this workspace already has 5 domains waiting for DNS: finish one or let it expire",
    );
  }
  if (opened.created) {
    await audit(deps, member.orgId, member.id, "domain.claimed", domain);
  }
  const claim = await withCheck(deps, opened.claim);
  return { claim, challengeValue: opened.created ? challenge.value : undefined };
}

/**
 * Runs a check of the claim's DNS and stores it on the claim. Best effort: a claim whose DNS
 * cannot be read yet is still a claim, and the next check tries again.
 */
export async function withCheck(deps: DomainDeps, claim: DomainClaim): Promise<DomainClaim> {
  try {
    const { check } = await inspectDomain(deps, {
      domain: claim.domain,
      challengeHash: claim.challengeHash,
      records: claim.dnsRecords,
      provider: claim.provider,
      previous: claim.lastCheck,
    });
    await touchClaim(deps.db, claim.id, check);
    return { ...claim, lastCheck: check, checkedAt: new Date() };
  } catch (error) {
    deps.log.warn("domains.inspect_failed", { orgId: claim.orgId, error });
    return claim;
  }
}

/**
 * Checks a domain: its challenge (locking it on the first pass), then the provider's records.
 * Returns the setup as it now stands and the provider's refusal, if any.
 */
export async function checkDomain(
  deps: DomainDeps,
  member: { id: string; orgId: string },
  setup: DomainSetup,
): Promise<{ setup: DomainSetup; addError?: string }> {
  const { db } = deps;
  let { claim, lock } = setup;
  const domain = (claim?.domain ?? lock?.domain)!;

  if (claim && !lock) {
    if (claim.expiresAt <= new Date()) {
      throw new DomainError(410, `the claim on ${domain} expired: add the domain again`);
    }
    const { check, challengeFound } = await inspectDomain(deps, {
      domain,
      challengeHash: claim.challengeHash,
      records: claim.dnsRecords,
      provider: claim.provider,
      previous: claim.lastCheck,
    });
    await touchClaim(db, claim.id, check);
    claim = { ...claim, lastCheck: check, checkedAt: new Date() };
    if (!challengeFound) return { setup: { claim, lock } };
    const result = await lockClaim(db, claim);
    if (!result.ok) {
      if (result.reason === "expired") {
        throw new DomainError(410, `the claim on ${domain} expired: add the domain again`);
      }
      await audit(deps, member.orgId, member.id, "domain.claim_refused", domain, {
        lockedDomain: result.by,
      });
      throw new DomainError(409, `${domain} was set up by another workspace first`);
    }
    if (result.locked) {
      await audit(deps, member.orgId, member.id, "domain.verified", domain);
    }
    lock = result.lock;
    claim = { ...claim, status: "verified" };
  } else if (claim && lock) {
    // Locked already: the challenge must stay, or sending pauses (ADR 0010).
    const { check, challengeFound } = await inspectDomain(deps, {
      domain,
      challengeHash: claim.challengeHash,
      records: lock.dnsRecords,
      provider: lock.provider,
      previous: claim.lastCheck,
    });
    await touchClaim(db, claim.id, check);
    claim = { ...claim, lastCheck: check, checkedAt: new Date() };
    if (challengeFound !== null) {
      await applyChallengeState(deps, member.id, lock.orgId, domain, challengeFound);
    }
  }

  // Only a locked domain reaches the provider.
  const provision = await callMailService(
    deps,
    PROVISION_DOMAIN_PATH,
    { domain, add: true },
    provisionDomainResultSchema,
  ).catch(fromMailService);
  const records = provision.provider === "purelymail" ? provision.records : [];
  const saved = await saveMailDomain(db, {
    orgId: lock!.orgId,
    domain,
    provider: provision.provider,
    dnsRecords: records,
    added: provision.provider === "imap" || provision.added,
    verified:
      provision.provider === "imap" || (provision.added && records.every((r) => r.verified)),
  });
  if (!saved) throw new DomainError(409, `${domain} is no longer set up by this workspace`);
  return {
    setup: { claim, lock: saved },
    addError: provision.provider === "purelymail" ? provision.addError : undefined,
  };
}

/** Records a lost or restored challenge once per change, with an audit event and owner mail. */
async function applyChallengeState(
  deps: DomainDeps,
  actorMemberId: string | null,
  orgId: string,
  domain: string,
  ok: boolean,
) {
  const change = await recordChallengeState(deps.db, { orgId, domain, ok });
  if (!change) return;
  const action = change === "lost" ? "domain.dns_lost" : "domain.dns_restored";
  await audit(deps, orgId, actorMemberId, action, domain);
  await notifyOwners(deps, orgId, {
    subject:
      change === "lost" ? `Sending from ${domain} is paused` : `Sending from ${domain} is back on`,
    text:
      change === "lost"
        ? [
            `${deps.config.auth.appName} can no longer find the ${challengeRecordName(domain)} TXT record in ${domain}'s DNS.`,
            "",
            `Mail from ${domain} is paused until it is back. The domain stays with your workspace.`,
            `Put the record back, or make a new value on the domain's setup page and add that.`,
          ].join("\n")
        : `The ${challengeRecordName(domain)} TXT record is back, so mail from ${domain} is sending again.`,
  });
}

/**
 * The scheduled re-check: every verified lock's challenge, in turn. A name that gives no answer
 * is skipped, so a nameserver outage never pauses anyone's mail.
 */
export async function recheckLocks(deps: DomainDeps) {
  const locks = await listVerifiedLocks(deps.db);
  let changed = 0;
  for (const lock of locks) {
    try {
      const found = await challengeInDns(deps, lock.domain, lock.challengeHash);
      if (found === null || found === (lock.dnsLostAt === null)) continue;
      await applyChallengeState(deps, null, lock.orgId, lock.domain, found);
      changed++;
    } catch (error) {
      deps.log.warn("domains.recheck_failed", { orgId: lock.orgId, error });
    }
  }
  return { checked: locks.length, changed };
}

export async function audit(
  deps: Pick<DomainDeps, "db">,
  orgId: string,
  actorMemberId: string | null,
  action: DomainAuditAction,
  domain: string,
  data?: Record<string, unknown>,
) {
  return recordAudit(deps.db, { orgId, actorMemberId, action, subject: domain, data });
}

/**
 * Mails every owner of `orgId` through Email Sending. Without SYSTEM_MAIL_FROM there is no sender:
 * the audit log stays the record.
 */
export async function notifyOwners(
  deps: DomainDeps,
  orgId: string,
  message: { subject: string; text: string },
) {
  if (!deps.config.SYSTEM_MAIL_FROM) {
    deps.log.warn("domains.notify_skipped", { orgId, reason: "SYSTEM_MAIL_FROM is not set" });
    return;
  }
  const send = systemMailSender(deps);
  for (const to of await orgOwnerEmails(deps.db, orgId)) await send({ to, ...message });
}

/** The org's name, for mail that tells owners about another workspace. */
export async function orgName(db: Db, orgId: string) {
  const [row] = await db
    .select({ name: schema.organizations.name })
    .from(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  return row?.name ?? "another workspace";
}
