import { and, eq } from "drizzle-orm";
import type { Db } from "../client.ts";
import { mailboxes } from "../schema/index.ts";
import { ownedPersonalMailbox } from "./forwarding.ts";

/**
 * Names one of the user's own personal inboxes ("Work", "Personal"); null clears it. False when
 * the mailbox is not a personal one they own.
 */
export async function labelMailbox(
  db: Db,
  input: { userId: string; scopeOrgId?: string | null; mailboxId: string; label: string | null },
) {
  const rows = await db
    .update(mailboxes)
    .set({ label: input.label })
    .where(
      and(eq(mailboxes.id, input.mailboxId), ownedPersonalMailbox(input.userId, input.scopeOrgId)),
    )
    .returning({ id: mailboxes.id });
  return rows.length > 0;
}
