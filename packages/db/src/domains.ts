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
import { countMailboxesOnDomain, type InboxAuditAction } from "./mail.ts";
import { workspaceKind } from "./personal-space.ts";
import {
  auditEvents,
  type DomainCheck,
  domainClaims,
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

/**
 * A domain's setup always has a claim, a lock, or both: a claim with no lock is waiting for its
 * challenge, and a lock with no claim predates claims (ADR 0010: those keep their lock).
 */
export type DomainSetup =
  | { claim: DomainClaim; lock: MailDomain | null }
  | { claim: null; lock: MailDomain };

const advisoryLock = (key: string) => sql`select pg_advisory_xact_lock(hashtext(${key}))`;

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
) {
  const now = input.now ?? new Date();
  return db.transaction<{ claim: DomainClaim; created: boolean } | { error: "cap" }>(async (tx) => {
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
export async function orgDomainAdmins(db: Db, orgId: string) {
  const rows = await db
    .select({ id: members.id })
    .from(members)
    .where(and(eq(members.organizationId, orgId), inArray(members.role, DOMAIN_ADMIN_ROLES)));
  return rows.map((r) => r.id) satisfies string[];
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
export async function lockClaim(db: Db, claim: DomainClaim, now = new Date()) {
  return db
    .transaction(async (tx) => {
      await tx.execute(advisoryLock(`lock:${claim.domain.split(".").slice(-2).join(".")}`));
      const conflict = await conflictingLock(tx as unknown as Db, claim.orgId, claim.domain);
      if (conflict) {
        const result: LockResult = { ok: false, reason: "taken", by: conflict.domain };
        return result;
      }

      const imap = claim.provider === "imap" || claim.provider === "gmail";
      const [inserted] = await tx
        .insert(mailDomains)
        .values({
          id: claim.id,
          orgId: claim.orgId,
          domain: claim.domain,
          provider: claim.provider,
          dnsRecords: claim.dnsRecords,
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
        if (!lock) {
          const result: LockResult = { ok: false, reason: "taken", by: claim.domain };
          return result;
        }
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
          tx.rollback();
        }
      }
      const result: LockResult = { ok: true, lock, locked: inserted !== undefined };
      return result;
    })
    .catch((error: unknown) => {
      if (isRollback(error)) return { ok: false, reason: "expired" } satisfies LockResult;
      throw error;
    }) satisfies Promise<LockResult>;
}

function isRollback(error: unknown) {
  return error instanceof TransactionRollbackError;
}

/**
 * Updates a lock with the provider's latest check. Never creates one: only `lockClaim` does.
 * Idempotent: `addedAt` keeps its first time while the provider lists the domain, `verifiedAt` the
 * time every record first passed; each clears when that stops being true.
 */
export const saveMailDomain: (
  db: Db,
  input: {
    orgId: string;
    domain: string;
    provider: MailDomain["provider"];
    dnsRecords: MailDomainRecord[];
    added: boolean;
    verified: boolean;
  },
) => Promise<MailDomain | null> = async (db, input) => {
  const now = new Date();
  const at = sql`${now.toISOString()}::timestamptz`;
  const [row] = await db
    .update(mailDomains)
    .set({
      provider: input.provider,
      dnsRecords: input.dnsRecords,
      addedAt: input.added ? sql`coalesce(${mailDomains.addedAt}, ${at})` : null,
      verifiedAt: input.verified ? sql`coalesce(${mailDomains.verifiedAt}, ${at})` : null,
      checkedAt: now,
      updatedAt: now,
    })
    .where(and(eq(mailDomains.domain, input.domain), eq(mailDomains.orgId, input.orgId)))
    .returning(lockFields);
  return row ?? null;
};

/**
 * Records whether a locked domain's challenge still verifies, and says if that changed: `lost`
 * the first time it is gone (sending from it pauses), `restored` when it is back. Each transition
 * is one conditional update, so two checks at once report it once.
 */
export const recordChallengeState: (
  db: Db,
  input: { orgId: string; domain: string; ok: boolean; now?: Date },
) => Promise<"lost" | "restored" | null> = async (db, input) => {
  const now = input.now ?? new Date();
  const where = and(eq(mailDomains.domain, input.domain), eq(mailDomains.orgId, input.orgId));
  const [changed] = await db
    .update(mailDomains)
    .set({ dnsLostAt: input.ok ? null : now, updatedAt: now })
    .where(and(where, input.ok ? isNotNull(mailDomains.dnsLostAt) : isNull(mailDomains.dnsLostAt)))
    .returning({ id: mailDomains.id });
  if (!changed) return null;
  return input.ok ? "restored" : "lost";
};

export type HandOverResult =
  | { ok: true }
  | { ok: false; reason: "not_locked" | "has_mailboxes" | "personal_space" };

/**
 * Gives up `orgId`'s lock on `domain`: anyone can claim it again. Refused while the org has
 * mailboxes on it, since their mail rows belong to the org.
 */
export async function releaseDomain(db: Db, input: { orgId: string; domain: string; now?: Date }) {
  const now = input.now ?? new Date();
  return db.transaction<HandOverResult>(async (tx) => {
    if ((await countMailboxesOnDomain(tx as unknown as Db, input.orgId, input.domain)) > 0) {
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
 * Withdraws `orgId`'s claim that never locked its domain (pending or expired): it stops counting
 * toward the cap and leaves the list. Nothing else changes, since no mailbox can exist without a
 * lock; adding the domain again opens a new claim with a new value. False when there is no such
 * claim, or it verified meanwhile (that one is released with `releaseDomain`).
 */
export async function withdrawClaim(db: Db, input: { orgId: string; claimId: string; now?: Date }) {
  const now = input.now ?? new Date();
  const [withdrawn] = await db
    .update(domainClaims)
    .set({ status: "released", updatedAt: now })
    .where(
      and(
        eq(domainClaims.id, input.claimId),
        eq(domainClaims.orgId, input.orgId),
        eq(domainClaims.status, "pending"),
      ),
    )
    .returning({ id: domainClaims.id });
  return withdrawn !== undefined;
}

/**
 * Moves `fromOrgId`'s lock on `domain` to `toOrgId` in one step, with its verified claim (whose
 * challenge is the one in DNS). The destination's own pending claim on it, if any, is dropped.
 * Refused while the source has mailboxes on it.
 */
export async function transferDomain(
  db: Db,
  input: { fromOrgId: string; toOrgId: string; domain: string; now?: Date },
) {
  const now = input.now ?? new Date();
  return db.transaction<HandOverResult>(async (tx) => {
    if ((await workspaceKind(tx, input.toOrgId)) === "personal") {
      return { ok: false, reason: "personal_space" } as const;
    }
    if ((await countMailboxesOnDomain(tx as unknown as Db, input.fromOrgId, input.domain)) > 0) {
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
export async function sendingPaused(db: Db, domain: string) {
  const [row] = await db
    .select({ id: mailDomains.id })
    .from(mailDomains)
    .where(and(eq(mailDomains.domain, domain), isNotNull(mailDomains.dnsLostAt)));
  return row !== undefined;
}

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
export async function listMemberDomains(db: Db, memberId: string) {
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
  return setups satisfies DomainSetup[];
}

/** One of the member's org's domains, by claim id or (for a legacy lock) lock id. */
export async function findMemberDomain(db: Db, memberId: string, id: string) {
  const setups = await listMemberDomains(db, memberId);
  return setups.find((s) => s.claim?.id === id || s.lock?.id === id) ?? null;
}

/** `orgId`'s lock on `domain`, or null if it has none. */
export async function findOrgDomain(db: Db, orgId: string, domain: string) {
  const [row] = await db
    .select(lockFields)
    .from(mailDomains)
    .where(and(eq(mailDomains.orgId, orgId), eq(mailDomains.domain, domain)));
  return row ?? null;
}

/** Owners' addresses, for telling them their domain changed hands or lost its DNS. */
export async function orgOwnerEmails(db: Db, orgId: string) {
  const rows = await db
    .select({ email: users.email })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, orgId), eq(members.role, "owner")))
    .orderBy(asc(users.email));
  return rows.map((r) => r.email) satisfies string[];
}

/** The member's role in `orgId`, or null when they are not in it (for transfers between orgs). */
export async function roleInOrg(db: Db, userId: string, orgId: string) {
  const [row] = await db
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.userId, userId), eq(members.organizationId, orgId)));
  return row?.role ?? null;
}

export type DomainAuditAction =
  | "domain.claimed"
  | "domain.challenge_rotated"
  | "domain.verified"
  | "domain.claim_refused"
  | "domain.claim_withdrawn"
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
    action: DomainAuditAction | InboxAuditAction;
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
