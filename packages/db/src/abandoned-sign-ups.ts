// Abandoned sign-ups: people who signed up and never joined or created a workspace. Sign-up is
// invitation-only, so these are mostly invitations someone opened (which creates the user) and
// never accepted. Without a workspace the account reaches nothing, so after a quiet spell it goes,
// with its sessions, passkeys, linked accounts and sign-in emails (all `on delete cascade`). An
// invitation sent later lets the person sign up again.
import { and, asc, eq, gt, gte, inArray, lt, notExists, or, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { invitations, members, sessions, users } from "./schema/auth.ts";
import { userEmails } from "./schema/identity.ts";

/** How long an account with no workspace may sit unused before it is deleted. */
export const ABANDONED_SIGN_UP_DAYS = 30;

/** Most accounts one run deletes; the next run takes the rest. */
export const ABANDONED_SIGN_UP_BATCH = 500;

/**
 * Deletes accounts that have no workspace and nothing that would give them one, created and last
 * signed in to before `idleSince`, oldest first, at most `limit`. Answers what it deleted.
 *
 * Kept: anyone with a membership; anyone with a live invitation to their primary or any extra
 * sign-in email (they may still accept it); anyone who ever invited someone (they were a member,
 * and deleting them would cascade to those invitations); anyone with a session used since
 * `idleSince`. Safe to run twice and from two places at once: a row another run holds is skipped.
 */
export async function deleteAbandonedSignUps(
  db: Db,
  { idleSince, limit = ABANDONED_SIGN_UP_BATCH }: { idleSince: Date; limit?: number },
): Promise<{ id: string; image: string | null }[]> {
  const invitedAddress = sql`lower(${invitations.email})`;
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
            .where(eq(members.userId, users.id)),
        ),
        notExists(
          db
            .select({ one: sql`1` })
            .from(invitations)
            .where(eq(invitations.inviterId, users.id)),
        ),
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

  return db
    .delete(users)
    .where(inArray(users.id, abandoned))
    .returning({ id: users.id, image: users.image });
}
