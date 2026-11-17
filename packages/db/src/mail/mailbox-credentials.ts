// The mail service's writes to a mailbox's sealed login after it was first saved.
import { and, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { mailboxes } from "../schema/index.ts";

/**
 * Swaps a mailbox's sealed login for a new one, only while the stored one is still `expected`:
 * a login saved by someone else meanwhile (a reconnect, a re-provision) wins. True when swapped.
 */
export async function replaceMailboxCredentials(
  db: Db,
  input: { mailboxId: string; expected: string; next: string },
) {
  const rows = await db
    .update(mailboxes)
    .set({ credentialsEnc: input.next, updatedAt: new Date() })
    .where(and(eq(mailboxes.id, input.mailboxId), eq(mailboxes.credentialsEnc, input.expected)))
    .returning({ id: mailboxes.id });
  return rows.length > 0;
}
