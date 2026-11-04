// The daily sweep of abandoned sign-ups (`deleteAbandonedSignUps` in `@omni/db`): accounts that
// never joined or created a workspace and have sat unused for a month. Their rows go with the
// user; their uploaded profile picture goes from the bucket here.
import { ABANDONED_SIGN_UP_DAYS, deleteAbandonedSignUps, type Db } from "@omni/db";
import type { Logger } from "./log.ts";
import { pictureKeyOf } from "./routes/pictures.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes one batch of abandoned accounts and their pictures. Safe to run twice. A picture whose
 * delete fails is logged and left behind; the account is already gone either way.
 */
export async function pruneAbandonedSignUps({
  db,
  bucket,
  log,
  now = new Date(),
}: {
  db: Db;
  bucket: R2Bucket;
  log: Logger;
  now?: Date;
}) {
  const idleSince = new Date(now.getTime() - ABANDONED_SIGN_UP_DAYS * DAY_MS);
  const deleted = await deleteAbandonedSignUps(db, { idleSince });
  const pictures = deleted.flatMap(({ id, image }) => pictureKeyOf(image, "users", id) ?? []);
  if (pictures.length) {
    // One call deletes up to 1000 keys; a batch is at most 500 accounts.
    await bucket.delete(pictures).catch((error: unknown) => {
      log.warn("accounts.pictures_left", { count: pictures.length, error: String(error) });
    });
  }
  return { deleted: deleted.length, pictures: pictures.length };
}
