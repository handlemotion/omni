// Sign-in emails (ADR 0014): every address a person may sign in with. The primary is
// `users.email`; the others are verified rows in `user_emails`. An address belongs to at most one
// person, primary or not, so a sign-in, a Google link or an invitation to it always means them.
import { and, eq, sql, TransactionRollbackError } from "drizzle-orm";
import type { Db } from "./client.ts";
import { users, verifications } from "./schema/auth.ts";
import { userEmails } from "./schema/identity.ts";

/** A link to add an address works for an hour, once. */
export const SIGN_IN_EMAIL_TOKEN_TTL_MS = 60 * 60 * 1000;
const TOKEN_PREFIX = "sign-in-email:";

const normalize = (email: string) => email.trim().toLowerCase();

async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/**
 * Whose address this is: the user whose primary it is, verified or not, or the user who verified
 * it as an extra one. Null when nobody has it.
 */
export async function findEmailOwner(db: Db, email: string) {
  const address = normalize(email);
  const [primary] = await db
    .select({ userId: users.id, verified: users.emailVerified })
    .from(users)
    .where(eq(sql`lower(${users.email})`, address))
    .limit(1);
  if (primary) return { userId: primary.userId, primary: true, verified: primary.verified };
  const [extra] = await db
    .select({ userId: userEmails.userId })
    .from(userEmails)
    .where(eq(sql`lower(${userEmails.email})`, address))
    .limit(1);
  return extra ? { userId: extra.userId, primary: false, verified: true } : null;
}

/** The user who verified `email` as an extra sign-in address, or null. */
export async function findUserIdByExtraEmail(db: Db, email: string) {
  const owner = await findEmailOwner(db, email);
  return owner && !owner.primary ? owner.userId : null;
}

export interface SignInEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

/** The primary first, then the extra addresses in the order they were added. */
export async function listSignInEmails(db: Db, userId: string): Promise<SignInEmail[]> {
  const [user] = await db
    .select({ email: users.email, verified: users.emailVerified })
    .from(users)
    .where(eq(users.id, userId));
  if (!user) return [];
  const extra = await db
    .select({ email: userEmails.email })
    .from(userEmails)
    .where(eq(userEmails.userId, userId))
    .orderBy(userEmails.createdAt);
  return [
    { email: user.email, primary: true, verified: user.verified },
    ...extra.map((row) => ({ email: row.email, primary: false, verified: true })),
  ];
}

export type StartSignInEmailResult =
  | { status: "sent"; token: string; email: string; expiresAt: Date }
  /** Already one of this user's addresses. */
  | { status: "yours" }
  /** Someone else's. The caller answers as if it were sent, so nobody learns who has an account. */
  | { status: "taken" };

/**
 * Starts adding `email` to `userId`: a single-use token, stored hashed, to be mailed to the
 * address. Nothing is added until the link comes back to the same user (`verifySignInEmail`).
 */
export async function startSignInEmail(
  db: Db,
  input: { userId: string; email: string },
): Promise<StartSignInEmailResult> {
  const email = normalize(input.email);
  const owner = await findEmailOwner(db, email);
  if (owner?.userId === input.userId) return { status: "yours" };
  if (owner) return { status: "taken" };
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SIGN_IN_EMAIL_TOKEN_TTL_MS);
  await db.insert(verifications).values({
    id: crypto.randomUUID(),
    identifier: TOKEN_PREFIX + (await sha256Hex(token)),
    value: JSON.stringify({ userId: input.userId, email }),
    expiresAt,
  });
  return { status: "sent", token, email, expiresAt };
}

export type VerifySignInEmailResult =
  | { status: "verified"; email: string }
  /** Unknown, used or expired. */
  | { status: "invalid" }
  /** Issued to another user: left unused so its owner can still open it. */
  | { status: "wrong_user" }
  /** Someone else claimed the address after the link was sent. */
  | { status: "taken" };

/** Consumes a token for `userId` and adds its address. Single-use, under a lock on the address. */
export async function verifySignInEmail(
  db: Db,
  input: { userId: string; token: string },
): Promise<VerifySignInEmailResult> {
  const identifier = TOKEN_PREFIX + (await sha256Hex(input.token));
  return db.transaction(async (tx) => {
    const [pending] = await tx
      .select({ id: verifications.id, value: verifications.value })
      .from(verifications)
      .where(and(eq(verifications.identifier, identifier), sql`${verifications.expiresAt} > now()`))
      .for("update");
    if (!pending) return { status: "invalid" as const };
    const { userId, email } = JSON.parse(pending.value) as { userId: string; email: string };
    if (userId !== input.userId) return { status: "wrong_user" as const };
    await tx.delete(verifications).where(eq(verifications.id, pending.id));

    // Two people verifying the same address at once queue here; the unique index backs it up.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"sign-in-email:" + email}))`);
    const owner = await findEmailOwner(tx, email);
    if (owner?.userId === userId) return { status: "verified" as const, email };
    if (owner) return { status: "taken" as const };
    await tx.insert(userEmails).values({ userId, email, verifiedAt: new Date() });
    return { status: "verified" as const, email };
  });
}

export type RemoveSignInEmailResult =
  | { status: "removed" }
  | { status: "not_found" }
  /** The primary cannot be removed: make another address primary first. */
  | { status: "primary" }
  /** It is the last verified address. */
  | { status: "last_verified" };

export async function removeSignInEmail(
  db: Db,
  input: { userId: string; email: string },
): Promise<RemoveSignInEmailResult> {
  const email = normalize(input.email);
  return db
    .transaction(async (tx) => {
      const [user] = await tx
        .select({ email: users.email, verified: users.emailVerified })
        .from(users)
        .where(eq(users.id, input.userId))
        .for("update");
      if (!user) return { status: "not_found" as const };
      if (user.email.toLowerCase() === email) return { status: "primary" as const };
      const removed = await tx
        .delete(userEmails)
        .where(and(eq(userEmails.userId, input.userId), eq(sql`lower(${userEmails.email})`, email)))
        .returning({ id: userEmails.id });
      if (removed.length === 0) return { status: "not_found" as const };
      if (!user.verified) {
        const [left] = await tx
          .select({ id: userEmails.id })
          .from(userEmails)
          .where(eq(userEmails.userId, input.userId))
          .limit(1);
        // Rolls the delete back: someone must always be able to get a sign-in link.
        if (!left) tx.rollback();
      }
      return { status: "removed" as const };
    })
    .catch((error: unknown) => {
      if (error instanceof TransactionRollbackError) {
        return { status: "last_verified" as const };
      }
      throw error;
    });
}

export type SetPrimarySignInEmailResult = { status: "primary" } | { status: "not_found" };

/**
 * Makes a verified extra address the primary (`users.email`). The old primary becomes an extra
 * address if it was verified, and is dropped if it never was.
 */
export async function setPrimarySignInEmail(
  db: Db,
  input: { userId: string; email: string },
): Promise<SetPrimarySignInEmailResult> {
  const email = normalize(input.email);
  return db.transaction(async (tx) => {
    const [user] = await tx
      .select({ email: users.email, verified: users.emailVerified })
      .from(users)
      .where(eq(users.id, input.userId))
      .for("update");
    if (!user) return { status: "not_found" as const };
    if (user.email.toLowerCase() === email) return { status: "primary" as const };
    const [extra] = await tx
      .select({ id: userEmails.id, email: userEmails.email })
      .from(userEmails)
      .where(and(eq(userEmails.userId, input.userId), eq(sql`lower(${userEmails.email})`, email)));
    if (!extra) return { status: "not_found" as const };
    // Free the address in `user_emails` before `users.email` takes it.
    if (user.verified) {
      await tx
        .update(userEmails)
        .set({ email: user.email.toLowerCase(), verifiedAt: new Date() })
        .where(eq(userEmails.id, extra.id));
    } else {
      await tx.delete(userEmails).where(eq(userEmails.id, extra.id));
    }
    await tx
      .update(users)
      .set({ email: extra.email, emailVerified: true, updatedAt: new Date() })
      .where(eq(users.id, input.userId));
    return { status: "primary" as const };
  });
}
