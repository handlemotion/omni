import type { Cap } from "@omni/contracts";
import { and, count, eq, gt, or } from "drizzle-orm";
import type { Db } from "./client.ts";
import { mailboxCount } from "./mail.ts";
import { storageUsageOf } from "./storage.ts";
import { invitations, members } from "./schema/auth.ts";
import { domainClaims } from "./schema/domains.ts";

type Executor = Pick<Db, "select">;

const GB = 1024 ** 3;

async function memberCount(db: Executor, orgId: string, now: Date) {
  const [joined] = await db
    .select({ n: count() })
    .from(members)
    .where(eq(members.organizationId, orgId));
  const [invited] = await db
    .select({ n: count() })
    .from(invitations)
    .where(
      and(
        eq(invitations.organizationId, orgId),
        eq(invitations.status, "pending"),
        gt(invitations.expiresAt, now),
      ),
    );
  return (joined?.n ?? 0) + (invited?.n ?? 0);
}

async function domainCount(db: Executor, orgId: string, now: Date) {
  const [row] = await db
    .select({ n: count() })
    .from(domainClaims)
    .where(
      and(
        eq(domainClaims.orgId, orgId),
        or(
          eq(domainClaims.status, "verified"),
          and(eq(domainClaims.status, "pending"), gt(domainClaims.expiresAt, now)),
        ),
      ),
    );
  return row?.n ?? 0;
}

/** Whether `orgId` already has a live claim on `domain`: claiming it again adds nothing. */
export async function holdsDomain(db: Executor, orgId: string, domain: string, now = new Date()) {
  const [row] = await db
    .select({ id: domainClaims.id })
    .from(domainClaims)
    .where(
      and(
        eq(domainClaims.orgId, orgId),
        eq(domainClaims.domain, domain),
        or(
          eq(domainClaims.status, "verified"),
          and(eq(domainClaims.status, "pending"), gt(domainClaims.expiresAt, now)),
        ),
      ),
    );
  return row !== undefined;
}

/** How much of `cap` the workspace holds now. The one place each cap is counted. */
export async function capUsage(db: Db, orgId: string, cap: Cap, now = new Date()) {
  switch (cap) {
    case "members":
      return memberCount(db, orgId, now);
    case "mailboxes":
      return mailboxCount(db, orgId);
    case "domains":
      return domainCount(db, orgId, now);
    case "storageGb":
      return (await storageUsageOf(db, orgId)).bytes / GB;
  }
}
