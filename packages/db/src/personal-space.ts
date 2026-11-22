import { and, eq, notExists, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "./client.ts";
import { members, organizations, orgSetup, personalSpaces } from "./schema/index.ts";

export type WorkspaceKind = "personal" | "company";

type Executor = Pick<Db, "select">;

/**
 * `userId`'s Personal space while they are still a member of it, or null. One they left (after
 * making someone else its owner) is no longer theirs: it stays with the people in it.
 */
export async function ownPersonalSpace(db: Executor, userId: string) {
  const [row] = await db
    .select({ orgId: personalSpaces.orgId })
    .from(personalSpaces)
    .innerJoin(
      members,
      and(
        eq(members.organizationId, personalSpaces.orgId),
        eq(members.userId, personalSpaces.userId),
      ),
    )
    .where(eq(personalSpaces.userId, userId));
  return row?.orgId ?? null;
}

/**
 * Creates `userId`'s Personal space and their owner membership if missing, and returns its id.
 * One they have left is let go (the workspace stays with its people) and a new one is made.
 * Idempotent and safe under concurrency: a per-user advisory lock serializes callers, and the
 * second finds the first one's row. Its slug is random, so no company handle can collide with it.
 * Setup is `complete` from the start: a Personal space has nothing to set up.
 */
export async function ensurePersonalSpace(db: Db, userId: string) {
  return db.transaction<string>(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`personal-space:${userId}`}))`);
    const existing = await ownPersonalSpace(tx, userId);
    if (existing) return existing;
    await tx.delete(personalSpaces).where(eq(personalSpaces.userId, userId));
    const orgId = uuidv7();
    const now = new Date();
    await tx
      .insert(organizations)
      .values({ id: orgId, name: "Personal", slug: `personal-${uuidv7()}`, createdAt: now });
    await tx.insert(personalSpaces).values({ orgId, userId });
    await tx
      .insert(members)
      .values({ id: uuidv7(), organizationId: orgId, userId, role: "owner", createdAt: now });
    await tx.insert(orgSetup).values({ orgId, step: "complete" });
    return orgId;
  });
}

/** `orgId`'s kind: `personal` when it is someone's Personal space, else `company`. */
export async function workspaceKind(db: Executor, orgId: string) {
  const [row] = await db
    .select({ orgId: personalSpaces.orgId })
    .from(personalSpaces)
    .where(eq(personalSpaces.orgId, orgId));
  return (row ? "personal" : "company") satisfies WorkspaceKind;
}

/** SQL condition: the organization id in `orgId` is a company, not a Personal space. */
export function isCompany(db: Executor, orgId: AnyColumn | SQL) {
  return notExists(
    db
      .select({ one: sql`1` })
      .from(personalSpaces)
      .where(eq(personalSpaces.orgId, orgId)),
  ) satisfies SQL;
}
