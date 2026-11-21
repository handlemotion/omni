import { and, eq, exists, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { ensurePersonalSpace } from "./personal-space.ts";
import { users } from "./schema/index.ts";
import { grantsForUserRow } from "./storage.ts";

/**
 * Makes `userId`'s Personal space when something in Drive is shared with an address they
 * verifiably sign in with, and answers whether it did. Drive acts on a shared item as one of the
 * person's members (its uploads and changes are theirs, and Shared with me lists under one), so
 * a grantee needs a home. Idempotent.
 */
export async function ensurePersonalSpaceForGrantee(db: Db, userId: string) {
  const [granted] = await db
    .select({ one: sql`1` })
    .from(users)
    .where(and(eq(users.id, userId), exists(grantsForUserRow(db))))
    .limit(1);
  if (!granted) return false;
  await ensurePersonalSpace(db, userId);
  return true;
}
