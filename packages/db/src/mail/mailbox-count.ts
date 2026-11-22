import { and, count, eq, ne } from "drizzle-orm";
import type { Db } from "../client.ts";
import { mailboxes } from "../schema/mail/mailboxes.ts";

/** Inboxes `orgId` holds, personal and shared, leaving out disabled ones. */
export async function mailboxCount(db: Pick<Db, "select">, orgId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(mailboxes)
    .where(and(eq(mailboxes.orgId, orgId), ne(mailboxes.status, "disabled")));
  return row?.n ?? 0;
}
