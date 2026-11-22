import { alias } from "drizzle-orm/pg-core";
import { and, asc, eq, exists, gt, gte, inArray, lt, ne, notExists, or, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { orgHoldsCrmRecords } from "./crm.ts";
import { orgHasMailbox } from "./mail.ts";
import { isCompany } from "./personal-space.ts";
import { invitations, members, organizations, sessions, users } from "./schema/auth.ts";
import { personalSpaces, userEmails } from "./schema/identity.ts";
import { grantsForUserRow, orgHoldsFiles } from "./storage.ts";

/** How long an account with no workspace may sit unused before it is deleted. */
export const ABANDONED_SIGN_UP_DAYS = 30;

/** Most accounts one run deletes; the next run takes the rest. */
export const ABANDONED_SIGN_UP_BATCH = 500;

/**
 * Deletes accounts that have no workspace and nothing that would give them one, created and last
 * signed in to before `idleSince`, oldest first, at most `limit`. Answers what it deleted.
 *
 * Kept: anyone in a company, or whose Personal space holds a mailbox, a file or a CRM record, or
 * has another
 * member (deleting it would take their workspace); anyone with a
 * live invitation to their primary or any extra sign-in email (they may still accept it); anyone
 * who ever invited someone (they were a member, and deleting them would cascade to those
 * invitations); anyone something in Storage is shared with, at an address they verified (the
 * grant is why they signed up); anyone with a session used since `idleSince`. Safe to run twice and from two
 * places at once: a row another run holds is skipped.
 */
export async function deleteAbandonedSignUps(
  db: Db,
  { idleSince, limit = ABANDONED_SIGN_UP_BATCH }: { idleSince: Date; limit?: number },
) {
  const invitedAddress = sql`lower(${invitations.email})`;
  const others = alias(members, "others");
  const abandoned = db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        lt(users.createdAt, idleSince),
        notExists(
          db
            .select({ one: sql`1` })
            .from(members)
            .where(
              and(
                eq(members.userId, users.id),
                or(
                  isCompany(db, members.organizationId),
                  orgHasMailbox(sql`${members.organizationId}`),
                  orgHoldsFiles(sql`${members.organizationId}`),
                  orgHoldsCrmRecords(sql`${members.organizationId}`),
                  exists(
                    db
                      .select({ one: sql`1` })
                      .from(others)
                      .where(
                        and(
                          eq(others.organizationId, members.organizationId),
                          ne(others.userId, users.id),
                        ),
                      ),
                  ),
                ),
              ),
            ),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(invitations)
            .where(eq(invitations.inviterId, users.id)),
        ),
        notExists(grantsForUserRow(db)),
        notExists(
          db
            .select({ one: sql`1` })
            .from(sessions)
            .where(and(eq(sessions.userId, users.id), gte(sessions.updatedAt, idleSince))),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(invitations)
            .where(
              and(
                eq(invitations.status, "pending"),
                gt(invitations.expiresAt, new Date()),
                or(
                  eq(invitedAddress, sql`lower(${users.email})`),
                  inArray(
                    invitedAddress,
                    db
                      .select({ email: sql`lower(${userEmails.email})` })
                      .from(userEmails)
                      .where(eq(userEmails.userId, users.id)),
                  ),
                ),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(users.createdAt))
    .limit(limit)
    .for("update", { skipLocked: true });

  return db.transaction<{ id: string; image: string | null }[]>(async (tx) => {
    const ids = (
      await tx.select({ id: users.id }).from(users).where(inArray(users.id, abandoned))
    ).map((row) => row.id);
    if (ids.length === 0) return [];
    await tx
      .delete(organizations)
      .where(
        inArray(
          organizations.id,
          tx
            .select({ id: personalSpaces.orgId })
            .from(personalSpaces)
            .where(inArray(personalSpaces.userId, ids)),
        ),
      );
    return tx
      .delete(users)
      .where(inArray(users.id, ids))
      .returning({ id: users.id, image: users.image });
  });
}
