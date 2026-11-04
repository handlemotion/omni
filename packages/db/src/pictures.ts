// Profile pictures (`users.image`) and workspace logos (`organizations.logo`). Each setter
// returns the value it replaced, so the caller can delete the object that value pointed at.
import { eq } from "drizzle-orm";
import type { Db } from "./client.ts";
import { organizations, users } from "./schema/index.ts";

/** Sets the user's picture URL (null clears it); the previous URL, or undefined with no user. */
export async function setUserImage(db: Db, userId: string, image: string | null) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ image: users.image })
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!row) return undefined;
    await tx.update(users).set({ image, updatedAt: new Date() }).where(eq(users.id, userId));
    return row.image;
  });
}

/** Sets the organization's logo URL (null clears it); the previous URL, or undefined with no org. */
export async function setOrganizationLogo(db: Db, orgId: string, logo: string | null) {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ logo: organizations.logo })
      .from(organizations)
      .where(eq(organizations.id, orgId))
      .for("update");
    if (!row) return undefined;
    await tx.update(organizations).set({ logo }).where(eq(organizations.id, orgId));
    return row.logo;
  });
}
