// Files staged for a send that no send took (ADR 0021): deleted once they expire.
import { takeExpiredUploads } from "@omni/db";
import { openDb } from "./db.ts";
import { createLogger } from "./log.ts";

/** Deletes expired unsent uploads, rows first, in batches. Safe to run twice. */
export async function cleanupExpiredUploads(env: Env) {
  const { db, close } = openDb(env);
  const log = createLogger({ component: "uploads", requestId: crypto.randomUUID() });
  let deleted = 0;
  try {
    for (;;) {
      const batch = await takeExpiredUploads(db);
      if (!batch.length) break;
      await env.MAIL_BUCKET.delete(batch.map((row) => row.r2Key));
      deleted += batch.length;
    }
    log.info("uploads.expired", { deleted });
  } finally {
    await close();
  }
}
