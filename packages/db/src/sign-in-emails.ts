import { normalizeAddress } from "@omni/mail-core/addresses";
import { and, eq, sql, TransactionRollbackError } from "drizzle-orm";
import type { Db } from "./client.ts";
import { omniHostedAddresses } from "./mail.ts";
import { users, verifications } from "./schema/auth.ts";
import { mailDomains } from "./schema/domains.ts";
import { userEmails } from "./schema/identity.ts";

/** A link to add an address works for an hour, once. */
export const SIGN_IN_EMAIL_TOKEN_TTL_MS = 60 * 60 * 1000;
const TOKEN_PREFIX = "sign-in-email:";

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
  const address = normalizeAddress(email);
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
export const listSignInEmails: (db: Db, userId: string) => Promise<SignInEmail[]> = async (
  db,
  userId,
) => {
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
};

/**
 * Where a magic link for `email` is mailed (ADR 0048). An address Omni hosts can't be read before
 * signing in, so its link goes to the owner's first verified sign-in address Omni does not host.
 * Any other address, or a hosted one whose owner has no outside address, gets its own link.
 */
export async function magicLinkRecipient(db: Db, email: string) {
  const address = normalizeAddress(email);
  const owner = await findEmailOwner(db, address);
  if (!owner?.verified) return address;
  const own = (await listSignInEmails(db, owner.userId))
    .filter((row) => row.verified)
    .map((row) => normalizeAddress(row.email));
  const hosted = await omniHostedAddresses(db, [address, ...own]);
  if (!hosted.has(address)) return address;
  return own.find((other) => !hosted.has(other)) ?? address;
}

/**
 * Whether mail to `email` can only be read inside Omni by someone already signed in, so a link
 * mailed to it can't be opened (ADR 0048): Omni hosts the address or its domain, and the address
 * doesn't belong to someone whose sign-in links go to an outside address.
 */
export async function readableOnlyInOmni(db: Db, email: string) {
  const address = normalizeAddress(email);
  if ((await magicLinkRecipient(db, address)) !== address) return false;
  if ((await omniHostedAddresses(db, [address])).has(address)) return true;
  const domain = address.slice(address.lastIndexOf("@") + 1);
  const [hosted] = await db
    .select({ id: mailDomains.id })
    .from(mailDomains)
    .where(and(eq(mailDomains.domain, domain), eq(mailDomains.provider, "purelymail")))
    .limit(1);
  return hosted !== undefined;
}

/**
 * Whether hosting `email` in Omni would leave its owner no address to receive sign-in links at
 * (ADR 0048): it signs someone in, and every other verified address of theirs is hosted too.
 */
export async function hostingStrandsSignIn(db: Db, email: string) {
  const address = normalizeAddress(email);
  const owner = await findEmailOwner(db, address);
  if (!owner?.verified) return false;
  const own = (await listSignInEmails(db, owner.userId))
    .filter((row) => row.verified)
    .map((row) => normalizeAddress(row.email));
  const hosted = await omniHostedAddresses(db, own);
  hosted.add(address);
  return own.every((other) => hosted.has(other));
}

export type StartSignInEmailResult =
  | { status: "sent"; token: string; email: string; expiresAt: Date }
  | { status: "yours" }
  | { status: "taken" };

/**
 * Starts adding `email` to `userId`: a single-use token, stored hashed, to be mailed to the
 * address. Nothing is added until the link comes back to the same user (`verifySignInEmail`).
 */
export const startSignInEmail: (
  db: Db,
  input: { userId: string; email: string },
) => Promise<StartSignInEmailResult> = async (db, input) => {
  const email = normalizeAddress(input.email);
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
};

export type VerifySignInEmailResult =
  | { status: "verified"; email: string }
  | { status: "invalid" }
  | { status: "wrong_user" }
  | { status: "taken" };

/** Consumes a token for `userId` and adds its address. Single-use, under a lock on the address. */
export async function verifySignInEmail(db: Db, input: { userId: string; token: string }) {
  const identifier = TOKEN_PREFIX + (await sha256Hex(input.token));
  return db.transaction<VerifySignInEmailResult>(async (tx) => {
    const [pending] = await tx
      .select({ id: verifications.id, value: verifications.value })
      .from(verifications)
      .where(and(eq(verifications.identifier, identifier), sql`${verifications.expiresAt} > now()`))
      .for("update");
    if (!pending) return { status: "invalid" as const };
    const { userId, email } = JSON.parse(pending.value) as { userId: string; email: string };
    if (userId !== input.userId) return { status: "wrong_user" as const };
    await tx.delete(verifications).where(eq(verifications.id, pending.id));

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
  | { status: "primary" }
  | { status: "last_verified" }
  | { status: "last_outside" };

async function isLastOutsideAddress(db: Db, userId: string, email: string) {
  const own = (await listSignInEmails(db, userId))
    .filter((row) => row.verified)
    .map((row) => normalizeAddress(row.email));
  if (own.length < 2) return false;
  const hosted = await omniHostedAddresses(db, own);
  const outside = own.filter((address) => !hosted.has(address));
  return outside.length === 1 && outside[0] === email;
}

export async function removeSignInEmail(db: Db, input: { userId: string; email: string }) {
  const email = normalizeAddress(input.email);
  return db
    .transaction(async (tx) => {
      const [user] = await tx
        .select({ email: users.email, verified: users.emailVerified })
        .from(users)
        .where(eq(users.id, input.userId))
        .for("update");
      if (!user) return { status: "not_found" as const };
      if (user.email.toLowerCase() === email) return { status: "primary" as const };
      if (await isLastOutsideAddress(tx, input.userId, email)) {
        return { status: "last_outside" as const };
      }
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
        if (!left) tx.rollback();
      }
      return { status: "removed" as const };
    })
    .catch((error: unknown) => {
      if (error instanceof TransactionRollbackError) {
        return { status: "last_verified" as const };
      }
      throw error;
    }) satisfies Promise<RemoveSignInEmailResult>;
}

export type SetPrimarySignInEmailResult = { status: "primary" } | { status: "not_found" };

/**
 * Makes a verified extra address the primary (`users.email`). The old primary becomes an extra
 * address if it was verified, and is dropped if it never was.
 */
export async function setPrimarySignInEmail(db: Db, input: { userId: string; email: string }) {
  const email = normalizeAddress(input.email);
  return db.transaction<SetPrimarySignInEmailResult>(async (tx) => {
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
