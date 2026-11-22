import { type Db, ensurePersonalSpaceForGrantee } from "@omni/db";

/**
 * At sign-in, a Personal space for someone a Drive item is shared with (Drive acts as one of
 * their members). Nobody else gets one at sign-in: Personal spaces are made on demand. A failure
 * is logged, never thrown: it must never stop anyone signing in, and the next sign-in tries again.
 */
export async function ensureGranteeSpaceQuietly(db: Db, userId: string) {
  try {
    await ensurePersonalSpaceForGrantee(db, userId);
  } catch (error) {
    console.error("personal_space.ensure_failed", { userId, error });
  }
}
