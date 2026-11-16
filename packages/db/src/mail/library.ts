// Canned replies (ADR 0021): an inbox's, shared with everyone on it, or one member's own. Every
// read and write checks the member's grant on the inbox (`grantFor`), and a member's own replies
// are reachable only by that member.
import { and, desc, eq, exists, inArray, ne, or, sql } from "drizzle-orm";
import type { Db } from "../client.ts";
import { memberMailbox, senderIdentity } from "./compose.ts";
import { grantFor } from "./member-mail.ts";
import { cannedReplies, customers, mailboxes, messages, tags, threads } from "../schema/index.ts";

export type CannedReplyScope = "inbox" | "personal";

const replyColumns = {
  id: cannedReplies.id,
  mailboxId: cannedReplies.mailboxId,
  ownerMemberId: cannedReplies.ownerMemberId,
  title: cannedReplies.title,
  bodyText: cannedReplies.bodyText,
  bodyHtml: cannedReplies.bodyHtml,
  setStatus: cannedReplies.setStatus,
  addTagIds: cannedReplies.addTagIds,
  updatedAt: cannedReplies.updatedAt,
};

type ReplyRow = { [K in keyof typeof replyColumns]: (typeof cannedReplies.$inferSelect)[K] };

function withScope(row: ReplyRow) {
  return { ...row, scope: (row.mailboxId ? "inbox" : "personal") as CannedReplyScope };
}

/** A reply the member may use and change: their own, or an inbox's they can see. */
function visibleTo(db: Db, memberId: string) {
  return or(
    eq(cannedReplies.ownerMemberId, memberId),
    exists(grantFor(db, memberId, cannedReplies.mailboxId, cannedReplies.orgId)),
  );
}

/**
 * The replies a member can use: `mailboxId`'s (if they can see it) and their own, by title. Without
 * `mailboxId`, their own only. Each says its `scope`.
 */
export async function listCannedReplies(
  db: Db,
  memberId: string,
  options: { mailboxId?: string } = {},
) {
  const rows = await db
    .select(replyColumns)
    .from(cannedReplies)
    .where(
      or(
        eq(cannedReplies.ownerMemberId, memberId),
        options.mailboxId
          ? and(
              eq(cannedReplies.mailboxId, options.mailboxId),
              exists(grantFor(db, memberId, cannedReplies.mailboxId, cannedReplies.orgId)),
            )
          : undefined,
      ),
    )
    .orderBy(sql`lower(${cannedReplies.title})`, cannedReplies.id);
  return rows.map(withScope);
}

export async function getCannedReply(db: Db, memberId: string, id: string) {
  const [row] = await db
    .select(replyColumns)
    .from(cannedReplies)
    .where(and(eq(cannedReplies.id, id), visibleTo(db, memberId)));
  return row ? withScope(row) : null;
}

export interface CannedReplyFields {
  title: string;
  bodyText: string;
  bodyHtml: string | null;
  setStatus: "open" | "pending" | "snoozed" | "resolved" | null;
  addTagIds: string[];
}

/** Tags of `mailboxId` among `tagIds`; anything else is refused by the caller. */
async function inboxTags(db: Db, mailboxId: string, tagIds: string[]) {
  if (!tagIds.length) return [];
  const rows = await db
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.mailboxId, mailboxId), inArray(tags.id, tagIds)));
  return rows.map((r) => r.id);
}

export type CannedReplyWriteError = "not_found" | "invalid_tags";

/**
 * Creates an inbox's reply (`mailboxId`) or the member's own (no mailbox). Tags must be the
 * inbox's; a personal reply works in any inbox, so it adds none.
 */
export async function createCannedReply(
  db: Db,
  memberId: string,
  input: CannedReplyFields & { mailboxId: string | null },
) {
  let orgId: string;
  if (input.mailboxId) {
    const mailbox = await memberMailbox(db, memberId, input.mailboxId);
    if (!mailbox) return { error: "not_found" as const };
    orgId = mailbox.orgId;
    const valid = await inboxTags(db, input.mailboxId, input.addTagIds);
    if (valid.length !== new Set(input.addTagIds).size) return { error: "invalid_tags" as const };
  } else {
    if (input.addTagIds.length) return { error: "invalid_tags" as const };
    const identity = await senderIdentity(db, memberId);
    if (!identity) return { error: "not_found" as const };
    orgId = identity.orgId;
  }
  const [row] = await db
    .insert(cannedReplies)
    .values({
      orgId,
      mailboxId: input.mailboxId,
      ownerMemberId: input.mailboxId ? null : memberId,
      createdByMemberId: memberId,
      title: input.title,
      bodyText: input.bodyText,
      bodyHtml: input.bodyHtml,
      setStatus: input.setStatus,
      addTagIds: [...new Set(input.addTagIds)],
    })
    .returning(replyColumns);
  return { reply: withScope(row!) };
}

export async function updateCannedReply(
  db: Db,
  memberId: string,
  id: string,
  patch: Partial<CannedReplyFields>,
) {
  const current = await getCannedReply(db, memberId, id);
  if (!current) return { error: "not_found" as const };
  if (patch.addTagIds) {
    const ok = current.mailboxId
      ? (await inboxTags(db, current.mailboxId, patch.addTagIds)).length ===
        new Set(patch.addTagIds).size
      : patch.addTagIds.length === 0;
    if (!ok) return { error: "invalid_tags" as const };
    patch = { ...patch, addTagIds: [...new Set(patch.addTagIds)] };
  }
  const [row] = await db
    .update(cannedReplies)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(cannedReplies.id, id), visibleTo(db, memberId)))
    .returning(replyColumns);
  return row ? { reply: withScope(row) } : { error: "not_found" as const };
}

export async function deleteCannedReply(db: Db, memberId: string, id: string) {
  const rows = await db
    .delete(cannedReplies)
    .where(and(eq(cannedReplies.id, id), visibleTo(db, memberId)))
    .returning({ id: cannedReplies.id });
  return rows.length > 0;
}

/**
 * What a canned reply's variables fill in for `threadId`, as the member sees it: the
 * conversation's customer (else the latest sender who is not the inbox), the agent, the inbox and
 * the org. Null when the member cannot see the thread.
 */
export async function templateContext(db: Db, memberId: string, threadId: string) {
  const [thread] = await db
    .select({
      mailboxId: threads.mailboxId,
      address: mailboxes.address,
      customerName: customers.name,
      customerAddress: customers.address,
      company: customers.company,
    })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .leftJoin(customers, eq(customers.id, threads.customerId))
    .where(
      and(
        eq(threads.id, threadId),
        exists(grantFor(db, memberId, threads.mailboxId, threads.orgId)),
      ),
    );
  if (!thread) return null;
  let customer = thread.customerAddress
    ? { name: thread.customerName, address: thread.customerAddress, company: thread.company }
    : null;
  if (!customer) {
    const [latest] = await db
      .select({ name: messages.fromName, address: messages.fromAddress })
      .from(messages)
      .where(
        and(
          eq(messages.threadId, threadId),
          ne(sql`lower(${messages.fromAddress})`, thread.address.toLowerCase()),
        ),
      )
      .orderBy(desc(messages.sentAt))
      .limit(1);
    customer = latest ? { ...latest, company: null } : null;
  }
  const agent = await senderIdentity(db, memberId);
  return {
    mailboxId: thread.mailboxId,
    customer,
    agent: agent ? { name: agent.name, email: agent.email } : null,
    inboxAddress: thread.address,
    orgName: agent?.orgName ?? null,
  };
}
