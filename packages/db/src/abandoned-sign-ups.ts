// Abandoned sign-ups: people who signed up and never joined or created a workspace. Sign-up is
// invitation-only, so these are mostly invitations someone opened (which creates the user) and
// never accepted. Without a workspace the account reaches nothing, so after a quiet spell it goes,
// with its sessions, passkeys, linked accounts and sign-in emails (all `on delete cascade`). An
// invitation sent later lets the person sign up again.
import { and, asc, eq, gt, gte, inArray, lt, notExists, or, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { orgHasMailbox } from "./mail.ts";
import { isCompany } from "./personal-space.ts";
import { invitations, members, organizations, sessions, users } from "./schema/auth.ts";
import { personalSpaces, userEmails } from "./schema/identity.ts";
import { storageGrants, storageNodes } from "./schema/storage.ts";

/** How long an account with no workspace may sit unused before it is deleted. */
export const ABANDONED_SIGN_UP_DAYS = 30;

/** Most accounts one run deletes; the next run takes the rest. */
export const ABANDONED_SIGN_UP_BATCH = 500;

/**
 * Deletes accounts that have no workspace and nothing that would give them one, created and last
 * signed in to before `idleSince`, oldest first, at most `limit`. Answers what it deleted.
 *
 * Kept: anyone in a company, or whose Personal space holds a mailbox or a file; anyone with a
 * live invitation to their primary or any extra sign-in email (they may still accept it); anyone
 * who ever invited someone (they were a member, and deleting them would cascade to those
 * invitations); anyone something in Storage is shared with, at an address they verified (the
 * grant is why they signed up, ADR 0034); anyone with a session used since `idleSince`. Safe to run twice and from two
 * places at once: a row another run holds is skipped.
 */
export async function deleteAbandonedSignUps(
  db: Db,
  { idleSince, limit = ABANDONED_SIGN_UP_BATCH }: { idleSince: Date; limit?: number },
) {
  const invitedAddress = sql`lower(${invitations.email})`;
  const abandoned = db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        lt(users.createdAt, idleSince),
        // A Personal space (ADR 0024) alone is not a workspace until it holds a mailbox or a
        // file (ADR 0034): storage rows are the truth, so an idle account never loses them.
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
                  sql`exists (select 1 from ${storageNodes} sn where sn.org_id = ${members.organizationId})`,
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
        // A grant is addressed to an address, and opens for whoever verified it (ADR 0034).
        notExists(
          db
            .select({ one: sql`1` })
            .from(storageGrants)
            .where(
              or(
                and(
                  eq(users.emailVerified, true),
                  eq(storageGrants.email, sql`lower(${users.email})`),
                ),
                inArray(
                  storageGrants.email,
                  db
                    .select({ email: sql`lower(${userEmails.email})` })
                    .from(userEmails)
                    .where(eq(userEmails.userId, users.id)),
                ),
              ),
            ),
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

  return db.transaction<{ id: string; image: string | null }[]>(async (tx) => {
    const ids = (
      await tx.select({ id: users.id }).from(users).where(inArray(users.id, abandoned))
    ).map((row) => row.id);
    if (ids.length === 0) return [];
    // Their empty Personal spaces (ADR 0024) go with them: the user's delete cascades only to
    // the `personal_spaces` row, which would leave the organization behind, owned by nobody.
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
