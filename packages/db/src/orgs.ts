// Organization bootstrap for trusted operator tooling (the `org:create` CLI). Members after the
// first join through Better Auth invitations; this is only how an organization and its owner
// come to exist.
import { and, eq, sql } from "drizzle-orm";
import { uuidv7 } from "uuidv7";
import type { Db } from "./client.ts";
import { members, organizations, users } from "./schema/index.ts";

/** Lowercase, ASCII letters and digits joined by single dashes. */
export function slugify(name: string) {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Creates the organization (keyed by slug), the owner's user (keyed by email) if missing, and the
 * owner membership. Idempotent: a second run finds every row and changes nothing, except that an
 * existing member of the org is promoted to owner.
 */
export async function createOrgWithOwner(
  db: Db,
  input: { name: string; slug: string; ownerEmail: string; ownerName?: string },
) {
  const email = input.ownerEmail.toLowerCase();
  return db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .insert(organizations)
      .values({ id: uuidv7(), name: input.name, slug: input.slug, createdAt: now })
      .onConflictDoNothing({ target: organizations.slug });
    const [org] = await tx
      .select({ id: organizations.id, name: organizations.name, slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.slug, input.slug));

    let [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(sql`lower(${users.email})`, email));
    if (!user) {
      // Unverified until the first magic-link sign-in proves the address.
      [user] = await tx
        .insert(users)
        .values({ id: uuidv7(), name: input.ownerName ?? email.split("@")[0]!, email })
        .returning({ id: users.id });
    }

    let [member] = await tx
      .select({ id: members.id, role: members.role })
      .from(members)
      .where(and(eq(members.organizationId, org!.id), eq(members.userId, user!.id)));
    if (!member) {
      [member] = await tx
        .insert(members)
        .values({
          id: uuidv7(),
          organizationId: org!.id,
          userId: user!.id,
          role: "owner",
          createdAt: now,
        })
        .returning({ id: members.id, role: members.role });
    } else if (member.role !== "owner") {
      await tx.update(members).set({ role: "owner" }).where(eq(members.id, member.id));
    }

    return {
      orgId: org!.id,
      name: org!.name,
      slug: org!.slug,
      userId: user!.id,
      memberId: member!.id,
    };
  });
}
