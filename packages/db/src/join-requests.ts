// Join requests (ADR 0024 decision 3): a sign-in with a company's address reaches only that
// company, so someone who is not its member asks to join, and an owner or admin decides.
import { and, asc, eq, like } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "./client.ts";
import { joinRequests, members, organizations, users } from "./schema/index.ts";

/** Records `userId`'s request to join `orgId`. `created` is false when one was already waiting. */
export async function requestToJoin(db: Db, input: { orgId: string; userId: string }) {
  const [row] = await db
    .insert(joinRequests)
    .values(input)
    .onConflictDoNothing({ target: [joinRequests.orgId, joinRequests.userId] })
    .returning({ id: joinRequests.id });
  return { created: row !== undefined };
}

/** The company `userId` may ask to join, and whether they already asked. */
export async function joinStatus(db: Db, input: { orgId: string; userId: string }) {
  const [org] = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, input.orgId));
  if (!org) return null;
  const [request] = await db
    .select({ id: joinRequests.id })
    .from(joinRequests)
    .where(and(eq(joinRequests.orgId, input.orgId), eq(joinRequests.userId, input.userId)));
  return { company: org, requested: request !== undefined };
}

/** The requests waiting in `orgId`, oldest first, with who asked. */
export function listJoinRequests(db: Db, orgId: string) {
  return db
    .select({
      id: joinRequests.id,
      createdAt: joinRequests.createdAt,
      user: { id: users.id, name: users.name, email: users.email, image: users.image },
    })
    .from(joinRequests)
    .innerJoin(users, eq(users.id, joinRequests.userId))
    .where(eq(joinRequests.orgId, orgId))
    .orderBy(asc(joinRequests.createdAt));
}

/**
 * Accepts request `requestId` in `orgId`: its person becomes a member there (unless they already
 * are), and the request goes. Answers the new member's user id, or null for no such request.
 */
export async function acceptJoinRequest(db: Db, input: { orgId: string; requestId: string }) {
  return db.transaction(async (tx) => {
    const [request] = await tx
      .delete(joinRequests)
      .where(and(eq(joinRequests.id, input.requestId), eq(joinRequests.orgId, input.orgId)))
      .returning({ userId: joinRequests.userId });
    if (!request) return null;
    const [existing] = await tx
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.organizationId, input.orgId), eq(members.userId, request.userId)));
    if (!existing) {
      await tx.insert(members).values({
        id: uuidv7(),
        organizationId: input.orgId,
        userId: request.userId,
        role: "member",
        createdAt: new Date(),
      });
    }
    return request.userId;
  });
}

/** Declines request `requestId` in `orgId`. Answers whether there was one. */
export async function declineJoinRequest(db: Db, input: { orgId: string; requestId: string }) {
  const rows = await db
    .delete(joinRequests)
    .where(and(eq(joinRequests.id, input.requestId), eq(joinRequests.orgId, input.orgId)))
    .returning({ id: joinRequests.id });
  return rows.length > 0;
}

/** The addresses of `orgId`'s owners, who hear about a new request. */
export async function ownerEmails(db: Db, orgId: string) {
  const rows = await db
    .select({ email: users.email })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(and(eq(members.organizationId, orgId), like(members.role, "%owner%")));
  return rows.map((row) => row.email);
}
