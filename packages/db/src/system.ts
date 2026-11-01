// System reads for the Worker's trusted paths (auth mail, background jobs). Not member-scoped:
// never call these with input from a member's request to decide what that member may see.
import { asc, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { mailboxes } from "./schema/index.ts";

/** The mailbox that sends system mail (magic links), by address. Oldest wins if several orgs share it. */
export async function findMailboxByAddress(db: Db, address: string) {
  const [row] = await db
    .select({ id: mailboxes.id, orgId: mailboxes.orgId, address: mailboxes.address })
    .from(mailboxes)
    .where(sql`lower(${mailboxes.address}) = ${address.toLowerCase()}`)
    .orderBy(asc(mailboxes.createdAt))
    .limit(1);
  return row ?? null;
}
