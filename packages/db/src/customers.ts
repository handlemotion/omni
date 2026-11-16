// Customers (ADR 0021): the people who write to an org's shared inboxes, keyed by address and
// filled on ingest. Members see a customer only through a conversation they can see, so the
// profile, the history and autocomplete never reveal who wrote to an inbox they are not on.
import { companyFromAddress, normalizeAddress, sameAddress } from "@omni/mail-core/addresses";
import { and, desc, eq, exists, ilike, or, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { grantFor } from "./member-mail.ts";
import { customers, mailboxes, members, messages, threads } from "./schema/index.ts";

/**
 * Records the sender of a newly indexed message as a customer of its org and links the
 * conversation to them if it has none yet. Only for shared inboxes, and never the inbox's own
 * address (a sent reply). Idempotent: a redelivered event upserts the same row.
 */
export async function recordCustomer(db: Db, event: { messageId: string }) {
  const [message] = await db
    .select({
      orgId: messages.orgId,
      threadId: messages.threadId,
      fromAddress: messages.fromAddress,
      fromName: messages.fromName,
      sentAt: messages.sentAt,
      mailboxAddress: mailboxes.address,
      mailboxKind: mailboxes.kind,
    })
    .from(messages)
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .where(eq(messages.id, event.messageId));
  if (!message || message.mailboxKind !== "shared") return null;
  const address = normalizeAddress(message.fromAddress);
  if (!address.includes("@") || sameAddress(address, message.mailboxAddress)) return null;

  const { domain, company } = companyFromAddress(address);
  const seen = message.sentAt.toISOString();
  const newer = sql`(excluded.name is not null and (${customers.nameSeenAt} is null or excluded.name_seen_at >= ${customers.nameSeenAt}))`;
  const [customer] = await db
    .insert(customers)
    .values({
      orgId: message.orgId,
      address,
      name: message.fromName || null,
      nameSeenAt: message.fromName ? message.sentAt : null,
      domain,
      company,
      firstSeenAt: message.sentAt,
      lastSeenAt: message.sentAt,
    })
    .onConflictDoUpdate({
      target: [customers.orgId, customers.address],
      set: {
        // The name from the newest message that had one wins, in whatever order mail arrives;
        // a message without a name changes nothing.
        name: sql`case when ${newer} then excluded.name else ${customers.name} end`,
        nameSeenAt: sql`case when ${newer} then excluded.name_seen_at else ${customers.nameSeenAt} end`,
        firstSeenAt: sql`least(${customers.firstSeenAt}, ${seen}::timestamptz)`,
        lastSeenAt: sql`greatest(${customers.lastSeenAt}, ${seen}::timestamptz)`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: customers.id });
  await db
    .update(threads)
    .set({ customerId: customer!.id })
    .where(and(eq(threads.id, message.threadId), sql`${threads.customerId} is null`));
  return customer!.id;
}

/** The customer has a conversation in a mailbox the member can see. */
function knownTo(db: Db, memberId: string) {
  return exists(
    db
      .select({ one: sql`1` })
      .from(threads)
      .where(
        and(
          eq(threads.customerId, customers.id),
          exists(grantFor(db, memberId, threads.mailboxId, threads.orgId)),
        ),
      ),
  );
}

const profileColumns = {
  id: customers.id,
  address: customers.address,
  name: customers.name,
  domain: customers.domain,
  company: customers.company,
  firstSeenAt: customers.firstSeenAt,
  lastSeenAt: customers.lastSeenAt,
};

/**
 * Customers whose address or name starts with `query` (or whose name has a word that does), for
 * recipient autocomplete: most recently seen first. Only customers of conversations the member
 * can see.
 */
export async function searchCustomers(db: Db, memberId: string, query: string, limit = 10) {
  const pattern = `${query.replaceAll(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return db
    .select(profileColumns)
    .from(customers)
    .innerJoin(members, and(eq(members.id, memberId), eq(members.organizationId, customers.orgId)))
    .where(
      and(
        or(
          ilike(customers.address, pattern),
          ilike(customers.name, pattern),
          ilike(customers.name, `% ${pattern}`),
        ),
        knownTo(db, memberId),
      ),
    )
    .orderBy(desc(customers.lastSeenAt))
    .limit(limit);
}

/**
 * A customer's profile and their conversations across every inbox the member can see, newest
 * first. Null when the member cannot see any conversation of theirs.
 */
export async function customerProfile(db: Db, memberId: string, customerId: string, limit = 50) {
  const [customer] = await db
    .select(profileColumns)
    .from(customers)
    .where(and(eq(customers.id, customerId), knownTo(db, memberId)));
  if (!customer) return null;
  const conversations = await db
    .select({
      id: threads.id,
      mailboxId: threads.mailboxId,
      mailboxAddress: mailboxes.address,
      status: threads.status,
      priority: threads.priority,
      lastMessageAt: threads.lastMessageAt,
      subject: sql<string>`(select m.subject from ${messages} m where m.thread_id = ${threads.id} order by m.sent_at, m.id limit 1)`,
    })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(
      and(
        eq(threads.customerId, customerId),
        exists(grantFor(db, memberId, threads.mailboxId, threads.orgId)),
      ),
    )
    .orderBy(desc(threads.lastMessageAt), desc(threads.id))
    .limit(limit);
  return { ...customer, conversations };
}
