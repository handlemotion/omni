// Mail domains: claims, locks and their audit trail (ADR 0007, ADR 0010).
//
// A claim is an org's attempt to prove it controls a domain: a pending `domain_claims` row with the
// hash of a challenge TXT value. The first org whose challenge shows up in the domain's DNS locks
// it: a `mail_domains` row, unique on the domain. Only a lock lets mailboxes be created, and only
// the conditional statements below create, move or remove one, so two orgs racing never both win.
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
  TransactionRollbackError,
} from "drizzle-orm";
import type { Db } from "./client.ts";
import {
  auditEvents,
  type DomainCheck,
  domainClaims,
  mailboxes,
  mailDomains,
  type MailDomainRecord,
  members,
  users,
} from "./schema/index.ts";

/** Roles that may set up domains and mailboxes for their org. */
export const DOMAIN_ADMIN_ROLES = ["owner", "admin"] as const;

/** How long a pending claim can wait for its challenge. Claiming again starts a new one. */
export const PENDING_CLAIM_TTL_MS = 7 * 24 * 60 * 60_000;

/** Pending claims one org may hold at once, so nobody parks claims on every name they can think of. */
export const MAX_PENDING_CLAIMS = 5;

const lockFields = {
  id: mailDomains.id,
  orgId: mailDomains.orgId,
  domain: mailDomains.domain,
  provider: mailDomains.provider,
  dnsRecords: mailDomains.dnsRecords,
  addedAt: mailDomains.addedAt,
  verifiedAt: mailDomains.verifiedAt,
  checkedAt: mailDomains.checkedAt,
  dnsLostAt: mailDomains.dnsLostAt,
};

export type MailDomain = {
  [K in keyof typeof lockFields]: (typeof mailDomains.$inferSelect)[K];
};

export type DomainClaim = typeof domainClaims.$inferSelect;

/** A domain as onboarding sees it: the org's claim on it, its lock, or both. */
export interface DomainSetup {
  /** Null for a domain locked before claims existed (ADR 0010: those keep their lock). */
  claim: DomainClaim | null;
  /** Null until the claim's challenge verified. */
  lock: MailDomain | null;
}

/** Postgres advisory locks key on a bigint; `hashtext` folds the text into one. */
const advisoryLock = (key: string) => sql`select pg_advisory_xact_lock(hashtext(${key}))`;

/** The domains a lock on any of them covers `domain`: itself and every parent. */
function coveringDomains(domain: string) {
  const labels = domain.split(".");
  const out = [domain];
  for (let i = 1; i < labels.length - 1; i++) out.push(labels.slice(i).join("."));
  return out;
}

/**
 * Another org's lock on `domain` or on a domain above it, if any: either stops `orgId` from
 * claiming it. (A parent is not blocked by another org's lock on a subdomain.)
 */
export async function conflictingLock(db: Db, orgId: string, domain: string) {
  const [row] = await db
    .select({ domain: mailDomains.domain, orgId: mailDomains.orgId })
    .from(mailDomains)
    .where(and(inArray(mailDomains.domain, coveringDomains(domain)), ne(mailDomains.orgId, orgId)))
    .limit(1);
  return row ?? null;
}

/**
 * Opens `orgId`'s claim on `domain` with a fresh challenge, or returns the one it has. A live
 * claim (pending and unexpired, or verified) is returned as is with `created: false`: claiming
 * twice must not invalidate a record already published. An expired or released one is renewed.
 * Refused past `MAX_PENDING_CLAIMS`; the count and the insert run under one per-org lock.
 */
export async function openClaim(
  db: Db,
  input: {
    orgId: string;
    domain: string;
    memberId: string;
    challengeHash: string;
    provider: DomainClaim["provider"];
    dnsRecords: MailDomainRecord[];
    now?: Date;
  },
): Promise<{ claim: DomainClaim; created: boolean } | { error: "cap" }> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    await tx.execute(advisoryLock(`claims:${input.orgId}`));
    const [existing] = await tx
      .select()
      .from(domainClaims)
      .where(and(eq(domainClaims.orgId, input.orgId), eq(domainClaims.domain, input.domain)));
    const live = (claim: DomainClaim) =>
      claim.status === "verified" || (claim.status === "pending" && claim.expiresAt > now);
    if (existing && live(existing)) return { claim: existing, created: false };

    const [{ pending }] = (await tx
      .select({ pending: sql<number>`count(*)::int` })
      .from(domainClaims)
      .where(
        and(
          eq(domainClaims.orgId, input.orgId),
          eq(domainClaims.status, "pending"),
          gt(domainClaims.expiresAt, now),
        ),
      )) as [{ pending: number }];
    if (pending >= MAX_PENDING_CLAIMS) return { error: "cap" as const };

    const fresh = {
      status: "pending" as const,
      challengeHash: input.challengeHash,
      provider: input.provider,
      dnsRecords: input.dnsRecords,
      createdByMemberId: input.memberId,
      expiresAt: new Date(now.getTime() + PENDING_CLAIM_TTL_MS),
      verifiedAt: null,
      checkedAt: null,
    };
    const [claim] = await tx
      .insert(domainClaims)
      .values({ orgId: input.orgId, domain: input.domain, ...fresh })
      .onConflictDoUpdate({
        target: [domainClaims.orgId, domainClaims.domain],
        set: { ...fresh, updatedAt: now },
      })
      .returning();
    return { claim: claim!, created: true };
  });
}

/**
 * A new challenge for a claim: restarts a pending claim's week. A verified claim may rotate too
 * (its owner lost the value and needs a record to put back); it keeps the lock, and reads as lost
 * until DNS holds the new value. Null for a released claim or another org's.
 */
export async function rotateChallenge(
  db: Db,
  input: { orgId: string; claimId: string; challengeHash: string; now?: Date },
) {
  const now = input.now ?? new Date();
  const [claim] = await db
    .update(domainClaims)
    .set({
      challengeHash: input.challengeHash,
      expiresAt: new Date(now.getTime() + PENDING_CLAIM_TTL_MS),
      checkedAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(domainClaims.id, input.claimId),
        eq(domainClaims.orgId, input.orgId),
        ne(domainClaims.status, "released"),
      ),
    )
    .returning();
  return claim ?? null;
}

/** Records a claim's check, whatever the result: when, and (with `check`) what it saw. */
export async function touchClaim(db: Db, claimId: string, check?: DomainCheck, now = new Date()) {
  await db
    .update(domainClaims)
    .set({ checkedAt: now, updatedAt: now, ...(check ? { lastCheck: check } : {}) })
    .where(eq(domainClaims.id, claimId));
}

/** Member ids of the org's owners and admins: who sees a domain's progress live. */
export async function orgDomainAdmins(db: Db, orgId: string): Promise<string[]> {
  const rows = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.organizationId, orgId), inArray(members.role, DOMAIN_ADMIN_ROLES)));
  return rows.map((r) => r.id);
}

export type LockResult =
  | { ok: true; lock: MailDomain; locked: boolean }
  | { ok: false; reason: "taken" | "expired"; by?: string };

/**
 * Locks the claim's domain to its org: call only once its challenge verified. In one transaction,
 * serialized with every other lock under the same registrable-looking suffix: refuse if another
 * org locks it or a parent; insert the lock (`on conflict do nothing`, so of two racing orgs one
 * row wins); move the claim from pending to verified only if it still is pending and unexpired.
 * `locked` is false when the org already held the lock (a repeat is a no-op).
 */
export async function lockClaim(db: Db, claim: DomainClaim, now = new Date()): Promise<LockResult> {
  return db
    .transaction(async (tx): Promise<LockResult> => {
      // Parent and child claims race too (acme.com vs mail.acme.com): one key for both.
      await tx.execute(advisoryLock(`lock:${claim.domain.split(".").slice(-2).join(".")}`));
      const conflict = await conflictingLock(tx as unknown as Db, claim.orgId, claim.domain);
      if (conflict) return { ok: false, reason: "taken", by: conflict.domain };

      const imap = claim.provider === "imap";
      const [inserted] = await tx
        .insert(mailDomains)
        .values({
          // The lock shares the claim's id, so the id the app holds stays valid after verifying.
          id: claim.id,
          orgId: claim.orgId,
          domain: claim.domain,
          provider: claim.provider,
          dnsRecords: claim.dnsRecords,
          // Without a provider API the mail host already serves the domain (ADR 0007).
          addedAt: imap ? now : null,
          verifiedAt: imap ? now : null,
          checkedAt: now,
        })
        .onConflictDoNothing({ target: mailDomains.domain })
        .returning(lockFields);
      let lock = inserted;
      if (!lock) {
        [lock] = await tx
          .select(lockFields)
          .from(mailDomains)
          .where(and(eq(mailDomains.domain, claim.domain), eq(mailDomains.orgId, claim.orgId)));
        if (!lock) return { ok: false, reason: "taken", by: claim.domain };
      }

      const [verified] = await tx
        .update(domainClaims)
        .set({ status: "verified", verifiedAt: now, checkedAt: now, updatedAt: now })
        .where(
          and(
            eq(domainClaims.id, claim.id),
            eq(domainClaims.status, "pending"),
            gt(domainClaims.expiresAt, now),
          ),
        )
        .returning({ id: domainClaims.id });
      if (!verified) {
        const [current] = await tx
          .select({ status: domainClaims.status })
          .from(domainClaims)
          .where(eq(domainClaims.id, claim.id));
        if (current?.status !== "verified") {
          // Expired (or released) while the check ran: undo the insert with the transaction.
          tx.rollback();
        }
      }
      return { ok: true, lock, locked: inserted !== undefined };
    })
    .catch((error: unknown) => {
      if (isRollback(error)) return { ok: false, reason: "expired" } satisfies LockResult;
      throw error;
    });
}

function isRollback(error: unknown) {
  return error instanceof TransactionRollbackError;
}

/**
 * Updates a lock with the provider's latest check. Never creates one: only `lockClaim` does.
 * Idempotent: `addedAt` keeps its first time, `verifiedAt` the time every record first passed.
 */
export async function saveMailDomain(
  db: Db,
  input: {
    orgId: string;
    domain: string;
    provider: MailDomain["provider"];
    dnsRecords: MailDomainRecord[];
    added: boolean;
    verified: boolean;
  },
): Promise<MailDomain | null> {
  const now = new Date();
  // A raw Date in a `sql` template is not typed for the driver: pass it as a timestamptz.
  const at = sql`${now.toISOString()}::timestamptz`;
  const [row] = await db
    .update(mailDomains)
    .set({
      provider: input.provider,
      dnsRecords: input.dnsRecords,
      addedAt: input.added ? sql`coalesce(${mailDomains.addedAt}, ${at})` : mailDomains.addedAt,
      verifiedAt: input.verified ? sql`coalesce(${mailDomains.verifiedAt}, ${at})` : null,
      checkedAt: now,
      updatedAt: now,
    })
    .where(and(eq(mailDomains.domain, input.domain), eq(mailDomains.orgId, input.orgId)))
    .returning(lockFields);
  return row ?? null;
}

/**
 * Records whether a locked domain's challenge still verifies, and says if that changed: `lost`
 * the first time it is gone (sending from it pauses), `restored` when it is back. Each transition
 * is one conditional update, so two checks at once report it once.
 */
export async function recordChallengeState(
  db: Db,
  input: { orgId: string; domain: string; ok: boolean; now?: Date },
): Promise<"lost" | "restored" | null> {
  const now = input.now ?? new Date();
  const where = and(eq(mailDomains.domain, input.domain), eq(mailDomains.orgId, input.orgId));
  const [changed] = await db
    .update(mailDomains)
    .set({ dnsLostAt: input.ok ? null : now, updatedAt: now })
    .where(and(where, input.ok ? isNotNull(mailDomains.dnsLostAt) : isNull(mailDomains.dnsLostAt)))
    .returning({ id: mailDomains.id });
  if (!changed) return null;
  return input.ok ? "restored" : "lost";
}

/** Mailboxes the org has on `domain`. A domain with any cannot be released or moved. */
async function mailboxesOn(db: Db, orgId: string, domain: string) {
  const rows = await db
    .select({ id: mailboxes.id })
    .from(mailboxes)
    .where(
      and(eq(mailboxes.orgId, orgId), sql`split_part(${mailboxes.address}, '@', 2) = ${domain}`),
    );
  return rows.length;
}

export type HandOverResult = { ok: true } | { ok: false; reason: "not_locked" | "has_mailboxes" };

/**
 * Gives up `orgId`'s lock on `domain`: anyone can claim it again. Refused while the org has
 * mailboxes on it, since their mail rows belong to the org.
 */
export async function releaseDomain(
  db: Db,
  input: { orgId: string; domain: string; now?: Date },
): Promise<HandOverResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    if ((await mailboxesOn(tx as unknown as Db, input.orgId, input.domain)) > 0) {
      return { ok: false, reason: "has_mailboxes" } as const;
    }
    const [removed] = await tx
      .delete(mailDomains)
      .where(and(eq(mailDomains.domain, input.domain), eq(mailDomains.orgId, input.orgId)))
      .returning({ id: mailDomains.id });
    if (!removed) return { ok: false, reason: "not_locked" } as const;
    await tx
      .update(domainClaims)
      .set({ status: "released", updatedAt: now })
      .where(and(eq(domainClaims.orgId, input.orgId), eq(domainClaims.domain, input.domain)));
    return { ok: true } as const;
  });
}

/**
 * Moves `fromOrgId`'s lock on `domain` to `toOrgId` in one step, with its verified claim (whose
 * challenge is the one in DNS). The destination's own pending claim on it, if any, is dropped.
 * Refused while the source has mailboxes on it.
 */
export async function transferDomain(
  db: Db,
  input: { fromOrgId: string; toOrgId: string; domain: string; now?: Date },
): Promise<HandOverResult> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    if ((await mailboxesOn(tx as unknown as Db, input.fromOrgId, input.domain)) > 0) {
      return { ok: false, reason: "has_mailboxes" } as const;
    }
    const [moved] = await tx
      .update(mailDomains)
      .set({ orgId: input.toOrgId, updatedAt: now })
      .where(and(eq(mailDomains.domain, input.domain), eq(mailDomains.orgId, input.fromOrgId)))
      .returning({ id: mailDomains.id });
    if (!moved) return { ok: false, reason: "not_locked" } as const;
    await tx
      .delete(domainClaims)
      .where(and(eq(domainClaims.orgId, input.toOrgId), eq(domainClaims.domain, input.domain)));
    await tx
      .update(domainClaims)
      .set({ orgId: input.toOrgId, updatedAt: now })
      .where(and(eq(domainClaims.orgId, input.fromOrgId), eq(domainClaims.domain, input.domain)));
    return { ok: true } as const;
  });
}

/** Every lock whose org verified a challenge, for the scheduled re-check. Legacy locks have none. */
export async function listVerifiedLocks(db: Db) {
  return db
    .select({
      orgId: mailDomains.orgId,
      domain: mailDomains.domain,
      challengeHash: domainClaims.challengeHash,
      dnsLostAt: mailDomains.dnsLostAt,
    })
    .from(mailDomains)
    .innerJoin(
      domainClaims,
      and(
        eq(domainClaims.orgId, mailDomains.orgId),
        eq(domainClaims.domain, mailDomains.domain),
        eq(domainClaims.status, "verified"),
      ),
    )
    .orderBy(asc(mailDomains.domain));
}

/** True when sending from `domain` is paused because its challenge left DNS. */
export async function sendingPaused(db: Db, domain: string): Promise<boolean> {
  const [row] = await db
    .select({ id: mailDomains.id })
    .from(mailDomains)
    .where(and(eq(mailDomains.domain, domain), isNotNull(mailDomains.dnsLostAt)));
  return row !== undefined;
}

// Member-scoped reads: only owners and admins see their org's domains; others get nothing.

const adminOf = (
  memberId: string,
  orgColumn: typeof mailDomains.orgId | typeof domainClaims.orgId | typeof auditEvents.orgId,
) =>
  and(
    eq(members.id, memberId),
    eq(members.organizationId, orgColumn),
    inArray(members.role, DOMAIN_ADMIN_ROLES),
  );

/** The member's org's domains, each with its claim and lock, oldest first. */
export async function listMemberDomains(db: Db, memberId: string): Promise<DomainSetup[]> {
  const [claims, locks] = await Promise.all([
    db
      .select({ claim: domainClaims })
      .from(domainClaims)
      .innerJoin(members, adminOf(memberId, domainClaims.orgId))
      .where(ne(domainClaims.status, "released"))
      .orderBy(asc(domainClaims.createdAt)),
    db
      .select(lockFields)
      .from(mailDomains)
      .innerJoin(members, adminOf(memberId, mailDomains.orgId))
      .orderBy(asc(mailDomains.createdAt)),
  ]);
  const setups: DomainSetup[] = claims.map(({ claim }) => ({
    claim,
    lock: locks.find((l) => l.domain === claim.domain) ?? null,
  }));
  for (const lock of locks) {
    if (!setups.some((s) => s.lock?.domain === lock.domain)) setups.push({ claim: null, lock });
  }
  return setups;
}

/** One of the member's org's domains, by claim id or (for a legacy lock) lock id. */
export async function findMemberDomain(db: Db, memberId: string, id: string) {
  const setups = await listMemberDomains(db, memberId);
  return setups.find((s) => s.claim?.id === id || s.lock?.id === id) ?? null;
}

// Trusted reads for the mail service, which acts only on what the Worker already authorized.

/** `orgId`'s lock on `domain`, or null if it has none. */
export async function findOrgDomain(db: Db, orgId: string, domain: string) {
  const [row] = await db
    .select(lockFields)
    .from(mailDomains)
    .where(and(eq(mailDomains.orgId, orgId), eq(mailDomains.domain, domain)));
  return row ?? null;
}

/** The mailbox at `address` in `orgId`, if any. */
export async function findOrgMailbox(db: Db, orgId: string, address: string) {
  const [row] = await db
    .select({
      id: mailboxes.id,
      provider: mailboxes.provider,
      status: mailboxes.status,
      credentialsEnc: mailboxes.credentialsEnc,
    })
    .from(mailboxes)
    .where(and(eq(mailboxes.orgId, orgId), eq(mailboxes.address, address)));
  return row ?? null;
}

/** Owners' addresses, for telling them their domain changed hands or lost its DNS. */
export async function orgOwnerEmails(db: Db, orgId: string): Promise<string[]> {
  const rows = await db
    .select({ email: users.email })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, orgId), eq(members.role, "owner")))
    .orderBy(asc(users.email));
  return rows.map((r) => r.email);
}

/** The member's role in `orgId`, or null when they are not in it (for transfers between orgs). */
export async function roleInOrg(db: Db, userId: string, orgId: string) {
  const [row] = await db
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.organizationId, orgId)));
  return row?.role ?? null;
}

// Audit log.

export type DomainAuditAction =
  | "domain.claimed"
  | "domain.challenge_rotated"
  | "domain.verified"
  | "domain.claim_refused"
  | "domain.dns_lost"
  | "domain.dns_restored"
  | "domain.released"
  | "domain.transferred_out"
  | "domain.transferred_in";

/** Appends one event. Returns its id, which notifications use as their idempotency key. */
export async function recordAudit(
  db: Db,
  input: {
    orgId: string;
    actorMemberId: string | null;
    action: DomainAuditAction;
    subject: string;
    data?: Record<string, unknown>;
  },
) {
  const [row] = await db
    .insert(auditEvents)
    .values({ ...input, data: input.data ?? {} })
    .returning({ id: auditEvents.id });
  return row!.id;
}

/** A domain's events in the member's org, oldest first. Owners and admins only. */
export async function listDomainAudit(db: Db, memberId: string, domain: string) {
  return db
    .select({
      id: auditEvents.id,
      action: auditEvents.action,
      actorMemberId: auditEvents.actorMemberId,
      data: auditEvents.data,
      createdAt: auditEvents.createdAt,
    })
    .from(auditEvents)
    .innerJoin(members, adminOf(memberId, auditEvents.orgId))
    .where(eq(auditEvents.subject, domain))
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id));
}
