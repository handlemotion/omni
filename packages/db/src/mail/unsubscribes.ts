import { sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { listUnsubscribes, type unsubscribeKind } from "../schema/index.ts";

type UnsubscribeKind = (typeof unsubscribeKind.enumValues)[number];

/**
 * Records that a mailbox left `sender`'s list at `at` (default now). Pressing it again later moves
 * `unsubscribed_at` forward, so mail the list sent in between reads as left too; it never moves
 * back, so a retried request that names its first send's time changes nothing. The caller has
 * checked the grant.
 */
export async function recordUnsubscribe(
  db: Db,
  input: {
    orgId: string;
    mailboxId: string;
    sender: string;
    kind: UnsubscribeKind;
    memberId: string;
    at?: Date;
  },
) {
  const { at, ...row } = input;
  const sender = row.sender.toLowerCase();
  const when = at ? sql`${at.toISOString()}::timestamptz` : sql`now()`;
  await db
    .insert(listUnsubscribes)
    .values({ ...row, sender, unsubscribedAt: when })
    .onConflictDoUpdate({
      target: [listUnsubscribes.mailboxId, listUnsubscribes.sender],
      set: {
        kind: input.kind,
        memberId: input.memberId,
        unsubscribedAt: sql`greatest(${listUnsubscribes.unsubscribedAt}, ${when})`,
      },
    });
}
